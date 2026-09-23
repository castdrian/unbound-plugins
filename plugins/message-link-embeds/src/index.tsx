import { metro } from '@unbound-app/api';
import type {
	NativeFabricBridge,
	NativeFabricFrame,
	NativeFabricSurface,
	NativeHookToken,
	NativeObjCBridge,
	NativeObjectHandle,
	PluginContext,
} from '@unbound-app/api/native';

const CHAT_ITEM_PATH = 'components_native/chat/ChatItem.tsx';
const SURFACE_MODULE = 'UnboundMessageLinkSurface';
const MESSAGE_ROW_TYPE = 1;
const ESTIMATED_HEIGHT = 168;
const MAX_HEIGHT = 480;
const MESSAGE_LINK_REGEX =
	/https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(?:\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})/g;

type AnyRecord = Record<string, any>;

type Message = AnyRecord & {
	author?: AnyRecord;
	channel_id?: string;
	channelId?: string;
	content?: unknown;
	id?: string;
	timestamp?: Date | string;
};

type LinkTarget = {
	channelId: string;
	messageId: string;
};

type MessageStore = {
	getMessage?: (channelId: string, messageId: string) => Message | null;
};

type MessageActions = {
	fetchMessage?: (target: LinkTarget) => Promise<Message | null>;
};

type MessageRecordConstructor = new (message: AnyRecord) => Message;

type RowGenerator = {
	generate: (input: { message: Message; rowType: number }) => unknown;
};

type RowManagerConstructor = new () => RowGenerator;

type ChatItemComponent = (props: { message: Message; rowGenerator: RowGenerator }) => unknown;

type SurfaceProps = {
	surfaceId: string;
	targetMessageId: string;
};

type SurfaceState = {
	cell: NativeObjectHandle;
	container: NativeObjectHandle;
	generator: RowGenerator;
	height: number;
	originY: number;
	record: Message;
	source: Message;
	surface: NativeFabricSurface;
	target: Message;
	width: number;
};

type CellState = {
	cell: NativeObjectHandle;
	surfaceId: string;
};

let native: PluginContext['native'] | null = null;
let objc: NativeObjCBridge | null = null;
let fabric: NativeFabricBridge | null = null;
let messages: MessageStore | null = null;
let messageActions: MessageActions | null = null;
let messageRecord: MessageRecordConstructor | null = null;
let rowManager: RowManagerConstructor | null = null;
let chatItem: ChatItemComponent | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let surfaceRegistered = false;
let lifecycle = 0;

const hookTokens: NativeHookToken[] = [];
const cachedMessages = new Map<string, Message>();
const pendingMessages = new Set<string>();
const cellStates = new Map<string, CellState>();
const activeCells = new Map<string, NativeObjectHandle>();
const surfaces = new Map<string, SurfaceState>();
const pendingCells = new Set<string>();

function nativeCall(handle: NativeObjectHandle, selector: string, ...args: unknown[]): unknown {
	if (!objc) return null;
	try {
		return objc.invoke(handle, selector, args, { thread: 'main' });
	} catch {
		return null;
	}
}

function nativeIvar(handle: NativeObjectHandle, name: string): unknown {
	if (!objc) return null;
	try {
		return objc.getIvar(handle, name);
	} catch {
		return null;
	}
}

function nativeChildren(handle: NativeObjectHandle): NativeObjectHandle[] {
	if (!objc) return [];
	const subviews = nativeCall(handle, 'subviews');
	if (!subviews || typeof subviews !== 'object') return [];
	try {
		return objc.array(subviews as NativeObjectHandle) as NativeObjectHandle[];
	} catch {
		return [];
	}
}

function messageChannelId(message: Message): string | undefined {
	return message.channel_id ?? message.channelId;
}

function messageKey(channelId: string, messageId: string): string {
	return `${channelId}:${messageId}`;
}

function contentText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(contentText).join('');
	if (!value || typeof value !== 'object') return '';

	const record = value as AnyRecord;
	return `${contentText(record.content)}${typeof record.originalLink === 'string' ? record.originalLink : ''}${typeof record.text === 'string' ? record.text : ''}`;
}

function linkedTargets(message: Message): LinkTarget[] {
	const text = contentText(message.content);
	if (!text) return [];

	const targets: LinkTarget[] = [];
	for (const match of text.matchAll(MESSAGE_LINK_REGEX)) {
		const target = { channelId: match[1], messageId: match[2] };
		if (!target.channelId || !target.messageId) continue;
		if (
			!targets.some(
				(item) => item.channelId === target.channelId && item.messageId === target.messageId,
			)
		)
			targets.push(target);
	}
	return targets;
}

function linkedMessage(target: LinkTarget): Message | null {
	const key = messageKey(target.channelId, target.messageId);
	const cached = cachedMessages.get(key);
	if (cached) return cached;

	const message = messages?.getMessage?.(target.channelId, target.messageId) ?? null;
	if (message) cachedMessages.set(key, message);
	return message;
}

function refreshCells(): void {
	for (const cell of activeCells.values()) scheduleCell(cell);
}

function fetchLinkedMessage(target: LinkTarget): void {
	const key = messageKey(target.channelId, target.messageId);
	if (pendingMessages.has(key)) return;
	pendingMessages.add(key);

	let request: Promise<Message | null> | undefined;
	try {
		request = messageActions?.fetchMessage?.(target);
	} catch {
		pendingMessages.delete(key);
		return;
	}
	if (!request?.then) {
		pendingMessages.delete(key);
		return;
	}

	void request
		.then((result) => {
			const resolved = messages?.getMessage?.(target.channelId, target.messageId) ?? result;
			if (resolved) cachedMessages.set(key, resolved);
		})
		.catch(() => undefined)
		.finally(() => {
			pendingMessages.delete(key);
			refreshCells();
		});
}

function messageFromValue(value: unknown, depth: number = 0): Message | undefined {
	if (!value || depth > 4) return undefined;

	if (typeof value === 'object') {
		const record = value as AnyRecord;
		if (typeof record.id === 'string' && ('content' in record || 'author' in record))
			return record as Message;
		for (const key of ['message', 'item', 'row', 'rawRow', 'viewModel']) {
			const result = messageFromValue(record[key], depth + 1);
			if (result) return result;
		}
	}

	if (!objc || typeof value !== 'object') return undefined;
	const handle = value as NativeObjectHandle;
	for (const key of ['message', 'item', 'row', 'rawRow', 'viewModel']) {
		const nested = nativeIvar(handle, key) ?? nativeCall(handle, key);
		const result = messageFromValue(nested, depth + 1);
		if (result) return result;
	}
	return undefined;
}

function messageForCell(cell: NativeObjectHandle): Message | undefined {
	const viewModel = nativeIvar(cell, 'viewModel') ?? nativeCall(cell, 'viewModel');
	return messageFromValue(viewModel) ?? messageFromValue(nativeIvar(cell, 'message'));
}

function cellKey(cell: NativeObjectHandle): string | undefined {
	const hash = nativeCall(cell, 'hash');
	if (hash !== null && hash !== undefined) return String(hash);
	const description = nativeCall(cell, 'description');
	return typeof description === 'string' ? description : undefined;
}

function measure(view: NativeObjectHandle): NativeFabricFrame {
	if (!fabric) return { x: 0, y: 0, width: 0, height: 0 };
	try {
		return fabric.measure(view);
	} catch {
		return { x: 0, y: 0, width: 0, height: 0 };
	}
}

function largestAvatar(view: NativeObjectHandle, depth: number = 0): NativeObjectHandle | null {
	if (depth > 8 || !objc) return null;
	let result: NativeObjectHandle | null = null;
	let resultWidth = 0;
	const className = objc.className(view) ?? '';
	if (className.includes('Avatar')) {
		const width = measure(view).width;
		if (width > resultWidth) {
			result = view;
			resultWidth = width;
		}
	}
	for (const child of nativeChildren(view)) {
		const candidate = largestAvatar(child, depth + 1);
		if (!candidate) continue;
		const width = measure(candidate).width;
		if (width > resultWidth) {
			result = candidate;
			resultWidth = width;
		}
	}
	return result;
}

function contentContainer(cell: NativeObjectHandle): NativeObjectHandle {
	const fallback = (nativeCall(cell, 'contentView') ?? cell) as NativeObjectHandle;
	const avatar = largestAvatar(fallback);
	if (!avatar || !objc) return fallback;

	let node = avatar;
	for (let level = 0; level < 6; level++) {
		const parent = nativeCall(node, 'superview') as NativeObjectHandle | null;
		if (!parent) break;
		const avatarWidth = measure(node).width;
		const candidate = nativeChildren(parent).find((sibling) => {
			if (sibling === node) return false;
			const frame = measure(sibling);
			return frame.width > avatarWidth * 3 && frame.width > 100;
		});
		if (candidate) return candidate;
		node = parent;
	}
	return fallback;
}

function containerOriginY(container: NativeObjectHandle): number {
	const children = nativeChildren(container);
	if (children.length === 0) return 0;
	let bottom = 0;
	for (const child of children) {
		const frame = measure(child);
		bottom = Math.max(bottom, frame.y + frame.height);
	}
	return bottom + 6;
}

function buildRecord(target: Message, channelId: string): Message {
	const Constructor = messageRecord;
	if (!Constructor) throw new Error('MessageRecord is unavailable');
	if (target instanceof Constructor) return target;
	const timestamp =
		target.timestamp instanceof Date ? target.timestamp : new Date(target.timestamp ?? Date.now());
	return new Constructor({
		...target,
		channel_id: channelId,
		timestamp,
	});
}

function buildSurfaceContent(
	source: Message,
	target: Message,
): { generator: RowGenerator; record: Message } | undefined {
	if (!messageRecord || !rowManager) return undefined;
	const channelId = messageChannelId(target) ?? messageChannelId(source);
	if (!channelId || !target.id) return undefined;
	try {
		const record = buildRecord(target, channelId);
		const generator = new rowManager();
		generator.generate({ rowType: MESSAGE_ROW_TYPE, message: record });
		return { generator, record };
	} catch {
		return undefined;
	}
}

function surfaceFrame(state: SurfaceState, height: number): void {
	if (!fabric) return;
	const containerFrame = measure(state.container);
	const nextHeight = Math.min(Math.max(height, 1), MAX_HEIGHT);
	state.width = containerFrame.width || state.width;
	state.height = nextHeight;
	try {
		fabric.setFrame(state.surface, {
			x: 0,
			y: state.originY,
			width: state.width,
			height: nextHeight,
		});
	} catch {}
}

function MessageSurface({ surfaceId }: SurfaceProps): unknown {
	const state = surfaces.get(surfaceId);
	const { React, ReactNative } = metro.common;
	if (!state || !chatItem) return React.createElement(ReactNative.View, { style: { height: 1 } });

	const onLayout = (event: AnyRecord) => {
		const height = Number(event?.nativeEvent?.layout?.height) || state.height;
		surfaceFrame(state, height);
	};
	return React.createElement(
		ReactNative.View,
		{
			onLayout,
			style: { minHeight: 1, width: '100%' },
		},
		React.createElement(chatItem, { message: state.record, rowGenerator: state.generator }),
	);
}

function registerSurface(): boolean {
	if (surfaceRegistered) return true;
	const registry = (metro.common.ReactNative as AnyRecord).AppRegistry;
	if (!registry || typeof registry.registerComponent !== 'function') return false;
	try {
		registry.registerComponent(SURFACE_MODULE, () => MessageSurface);
		surfaceRegistered = true;
		return true;
	} catch {
		return false;
	}
}

function removeCellSurface(key: string): void {
	const state = cellStates.get(key);
	if (!state || !fabric) return;
	const surface = surfaces.get(state.surfaceId);
	if (surface) {
		try {
			fabric.unmount(surface.surface);
		} catch {}
		surfaces.delete(state.surfaceId);
	}
	cellStates.delete(key);
}

function renderCell(cell: NativeObjectHandle): boolean {
	const key = cellKey(cell);
	if (!key || !native || !fabric) return false;
	activeCells.set(key, cell);
	const source = messageForCell(cell);
	if (!source?.id) {
		removeCellSurface(key);
		return false;
	}

	const targets = linkedTargets(source);
	if (targets.length === 0) {
		removeCellSurface(key);
		return false;
	}
	const target = targets.map(linkedMessage).find((value) => value?.id && value.id !== source.id);
	if (!target) {
		for (const candidate of targets) fetchLinkedMessage(candidate);
		removeCellSurface(key);
		return true;
	}

	const current = cellStates.get(key);
	if (current) {
		const surface = surfaces.get(current.surfaceId);
		if (surface?.target.id === target.id) {
			surface.source = source;
			try {
				fabric.update(surface.surface, { targetMessageId: target.id });
			} catch {}
			return false;
		}
		removeCellSurface(key);
	}

	const content = buildSurfaceContent(source, target);
	if (!content) return false;
	const container = contentContainer(cell);
	const containerFrame = measure(container);
	const surfaceId = `message-link-${key}-${target.id}`;
	const state = {
		cell,
		container,
		generator: content.generator,
		height: ESTIMATED_HEIGHT,
		originY: containerOriginY(container),
		record: content.record,
		source,
		surface: null as unknown as NativeFabricSurface,
		target,
		width: containerFrame.width,
	};
	surfaces.set(surfaceId, state);
	try {
		state.surface = fabric.mount(container, SURFACE_MODULE, {
			surfaceId,
			targetMessageId: target.id,
		});
		fabric.setSize(
			state.surface,
			{ width: state.width, height: 1 },
			{ width: state.width, height: MAX_HEIGHT },
		);
		surfaceFrame(state, ESTIMATED_HEIGHT);
		cellStates.set(key, { cell, surfaceId });
		return false;
	} catch {
		surfaces.delete(surfaceId);
		return false;
	}
}

function scheduleCell(cell: NativeObjectHandle, attempt: number = 0): void {
	const key = cellKey(cell);
	if (!key || pendingCells.has(key)) return;
	pendingCells.add(key);
	const token = lifecycle;
	setTimeout(() => {
		pendingCells.delete(key);
		if (token !== lifecycle) return;
		const retry = renderCell(cell);
		if (retry && attempt < 10) setTimeout(() => scheduleCell(cell, attempt + 1), 120);
	}, 0);
}

function scheduleVisibleCells(view: NativeObjectHandle, depth: number = 0): void {
	if (depth > 16 || !objc) return;
	if ((objc.className(view) ?? '') === 'DCDMessageTableViewCell') scheduleCell(view);
	for (const child of nativeChildren(view)) scheduleVisibleCells(child, depth + 1);
}

function installHooks(): void {
	if (!objc || hookTokens.length > 0) return;
	const layout = objc.hook('DCDMessageTableViewCell', 'layoutSubviews', {
		after: ({ self }) => scheduleCell(self),
	});
	const lifecycleHook = objc.hook('DCDMessageTableViewCell', 'didMoveToWindow', {
		after: ({ self }) => {
			if (!nativeCall(self, 'window')) {
				const key = cellKey(self);
				if (key) removeCellSurface(key);
				return;
			}
			scheduleCell(self);
		},
	});
	const reuse = objc.hook('DCDMessageTableViewCell', 'prepareForReuse', {
		after: ({ self }) => {
			const key = cellKey(self);
			if (key) removeCellSurface(key);
		},
	});
	hookTokens.push(layout, lifecycleHook, reuse);
}

function install(context: PluginContext): void {
	if (retryTimer) return;
	native = context.native;
	objc = native.objc;
	fabric = native.fabric;
	messages = metro.findStore('MessageStore', { short: false }) ?? metro.findStore('Message');
	messageActions = metro.findByProps('fetchMessage');
	messageRecord = metro.findByName('MessageRecord');
	rowManager = metro.findByName('RowManager');
	const module = metro.findByFilePath(CHAT_ITEM_PATH, { interop: false });
	chatItem = typeof module?.default === 'function' ? module.default : null;

	if (
		!messages?.getMessage ||
		!messageActions?.fetchMessage ||
		!messageRecord ||
		!rowManager ||
		!chatItem
	) {
		retryTimer = setTimeout(() => {
			retryTimer = null;
			if (native) install(context);
		}, 250);
		return;
	}
	if (!registerSurface()) {
		retryTimer = setTimeout(() => {
			retryTimer = null;
			if (native) install(context);
		}, 250);
		return;
	}
	installHooks();
	const windowClass = objc.getClass('UIWindow');
	const keyWindow = windowClass
		? (nativeCall(windowClass, 'keyWindow') as NativeObjectHandle)
		: null;
	if (keyWindow) scheduleVisibleCells(keyWindow);
}

function stop(): void {
	lifecycle++;
	if (retryTimer) clearTimeout(retryTimer);
	retryTimer = null;
	for (const token of hookTokens) token.remove();
	hookTokens.length = 0;
	for (const key of cellStates.keys()) removeCellSurface(key);
	for (const surface of surfaces.values()) {
		try {
			fabric?.unmount(surface.surface);
		} catch {}
	}
	surfaces.clear();
	cellStates.clear();
	activeCells.clear();
	pendingCells.clear();
	cachedMessages.clear();
	pendingMessages.clear();
	native = null;
	objc = null;
	fabric = null;
	messages = null;
	messageActions = null;
	messageRecord = null;
	rowManager = null;
	chatItem = null;
}

export default {
	start(context: PluginContext) {
		lifecycle++;
		install(context);
	},
	stop,
};
