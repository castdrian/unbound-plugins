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
const SURFACE_MODULE = 'MessageLinkSurface';
const ESTIMATED_HEIGHT = 168;
const EMBED_HEIGHT = 62;
const MAX_HEIGHT = 480;
const MESSAGE_LINK_REGEX =
	/https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(?:\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})/g;

type AnyRecord = Record<string, unknown>;
type NativeOriginal = (...args: unknown[]) => unknown;

type Message = AnyRecord & {
	author?: AnyRecord;
	channel_id?: string;
	channelId?: string;
	content?: unknown;
	guild_id?: string;
	guildId?: string;
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

type SelectedChannel = {
	getChannelId?: () => string | undefined;
	getLastSelectedChannelId?: () => string | undefined;
};

type MessageRecordConstructor = new (message: AnyRecord) => Message;

type RowInput = {
	message: Message;
	rowType: number;
	changeType?: number;
	isFirst?: boolean;
	canAddNewReactions?: boolean;
	canShowImages?: boolean;
	renderContentOnly?: boolean;
};

type RowGenerator = {
	generate: (input: RowInput) => AnyRecord | undefined;
};

type RowManagerConstructor = new () => RowGenerator;

type ChatItemComponent = (props: { message: Message; rowGenerator: RowGenerator }) => unknown;

type SurfaceProps = {
	surfaceId: string;
	targetMessageId: string;
};

type SurfaceState = {
	cell: NativeObjectHandle;
	generator: RowGenerator;
	height: number;
	hostX: number;
	hostY: number;
	layoutPath: LayoutNode[];
	record: Message;
	rowHeight: number;
	source: Message;
	surface: NativeFabricSurface;
	target: Message;
	width: number;
	contentHeight: number;
	cellFrame: NativeFabricFrame;
};

type LayoutNode = {
	frame: NativeFabricFrame;
	view: NativeObjectHandle;
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
let selectedChannel: SelectedChannel | null = null;
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
const surfaceFrameTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
const sizeOverrides = new Map<string, number>();
const rowBaseFrames = new Map<string, NativeFabricFrame>();
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
	if (Array.isArray(subviews)) return subviews as NativeObjectHandle[];
	if ('length' in subviews)
		return Array.from(subviews as ArrayLike<NativeObjectHandle | null | undefined>).filter(
			(value): value is NativeObjectHandle => Boolean(value),
		);
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

function stringFromNative(value: unknown, selector: string): string | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const result = nativeCall(value as NativeObjectHandle, selector);
	return typeof result === 'string' ? result : undefined;
}

function currentChannelId(): string | undefined {
	return selectedChannel?.getChannelId?.() ?? selectedChannel?.getLastSelectedChannelId?.();
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
	const direct = messageFromValue(viewModel) ?? messageFromValue(nativeIvar(cell, 'message'));
	if (direct?.id && direct.content !== undefined) return direct;

	const nativeMessage =
		(viewModel && typeof viewModel === 'object'
			? (nativeIvar(viewModel as NativeObjectHandle, 'message') ??
				nativeCall(viewModel as NativeObjectHandle, 'message'))
			: null) ?? nativeIvar(cell, 'message');
	const messageId = stringFromNative(nativeMessage, 'id') ?? direct?.id;
	const channelId =
		stringFromNative(nativeMessage, 'channelId') ??
		stringFromNative(nativeMessage, 'channel_id') ??
		currentChannelId();
	if (!messageId || !channelId) return direct;
	return messages?.getMessage?.(channelId, messageId) ?? direct;
}

function messagePayload(message: Message): Message {
	const record = message as AnyRecord;
	for (const key of ['message', 'message_snapshot', 'messageSnapshot']) {
		const nested = messageFromValue(record[key]);
		if (nested && nested.id !== message.id) return nested;
	}

	for (const key of ['message_snapshots', 'messageSnapshots']) {
		const snapshots = record[key];
		if (!Array.isArray(snapshots)) continue;
		for (const snapshot of snapshots) {
			const nested = messageFromValue(snapshot);
			if (nested && nested.id !== message.id) return nested;
		}
	}

	return message;
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

function setNativeFrame(view: NativeObjectHandle, frame: NativeFabricFrame): void {
	if (!objc) return;
	const current = measure(view);
	if (
		Math.abs(current.x - frame.x) <= 0.25 &&
		Math.abs(current.y - frame.y) <= 0.25 &&
		Math.abs(current.width - frame.width) <= 0.25 &&
		Math.abs(current.height - frame.height) <= 0.25
	)
		return;
	try {
		const rect = objc.struct('CGRect', {
			origin: { x: frame.x, y: frame.y },
			size: { width: frame.width, height: frame.height },
		});
		nativeCall(view, 'setFrame:', rect);
	} catch {}
}

function createSurfaceHost(
	cell: NativeObjectHandle,
	content: NativeObjectHandle,
): {
	cellFrame: NativeFabricFrame;
	contentHeight: number;
	hostX: number;
	hostY: number;
	layoutPath: LayoutNode[];
	parent: NativeObjectHandle;
	width: number;
} | null {
	if (!objc) return null;
	try {
		const cellFrame = measure(cell);
		const children = nativeChildren(content);
		const parent = children[1] ?? content;
		const parentFrame = measure(parent);
		const layoutPath = createLayoutPath(parent);
		const hostX = 0;
		const contentHeight = parentFrame.height;
		const hostY = contentHeight + 8;
		return {
			cellFrame,
			contentHeight,
			hostX,
			hostY,
			layoutPath,
			parent,
			width: parentFrame.width || cellFrame.width || 320,
		};
	} catch {
		return null;
	}
}

function createLayoutPath(parent: NativeObjectHandle): LayoutNode[] {
	if (!objc) return [];
	const layoutPath: LayoutNode[] = [];
	let current: NativeObjectHandle | null = parent;
	for (let depth = 0; depth < 12 && current; depth++) {
		if ((objc.className(current) ?? '') === 'DCDMessageTableViewCell') break;
		layoutPath.push({ frame: measure(current), view: current });
		current = nativeCall(current, 'superview') as NativeObjectHandle | null;
	}
	return layoutPath;
}

function linkedCellHeight(cell: NativeObjectHandle): number | null {
	const key = cellKey(cell);
	if (!key) return null;
	const source = messageForCell(cell);
	if (!source?.id || linkedTargets(source).length === 0) {
		sizeOverrides.delete(key);
		return null;
	}
	const cached = sizeOverrides.get(key);
	if (cached !== undefined) return cached;
	const content = contentContainer(cell);
	const children = nativeChildren(content);
	const parent = children[1] ?? content;
	const layoutPath = createLayoutPath(parent);
	if (layoutPath.length === 0) return null;
	const embeddedHeight = layoutPath[0].frame.height + 8 + EMBED_HEIGHT;
	let childHeight = embeddedHeight;
	for (let index = 0; index < layoutPath.length; index++) {
		const frame = layoutPath[index].frame;
		childHeight =
			index === 0
				? embeddedHeight
				: Math.max(frame.height, layoutPath[index - 1].frame.y + childHeight);
	}
	const top = layoutPath[layoutPath.length - 1];
	const height = Math.max(measure(cell).height, top.frame.y + childHeight);
	sizeOverrides.set(key, height);
	return height;
}

function tableRows(table: NativeObjectHandle): NativeObjectHandle[] {
	if (!objc) return [];
	return nativeChildren(table).filter((child) => {
		const className = objc?.className(child) ?? '';
		return (
			className.includes('MessageTableViewCell') || className.includes('SeparatorTableViewCell')
		);
	});
}

function tableForCell(cell: NativeObjectHandle): NativeObjectHandle | null {
	let current: NativeObjectHandle | null = cell;
	for (let depth = 0; depth < 12 && current; depth++) {
		const className = objc?.className(current) ?? '';
		if (className === 'DCDTableView' || className === 'NSKVONotifying_DCDTableView') return current;
		current = nativeCall(current, 'superview') as NativeObjectHandle | null;
	}
	return null;
}

function shiftTableRows(table: NativeObjectHandle): void {
	const rows = tableRows(table);
	if (rows.length === 0) return;
	const states = [...surfaces.values()];
	for (const row of rows) {
		const key = cellKey(row);
		if (!key) continue;
		const state = states.find((item) => cellKey(item.cell) === key);
		const currentFrame = measure(row);
		const baseFrame = rowBaseFrames.get(key) ?? state?.cellFrame ?? currentFrame;
		rowBaseFrames.set(key, baseFrame);
		let offset = 0;
		for (const other of states) {
			if (other.cellFrame.y < baseFrame.y - 0.5)
				offset += Math.max(0, other.rowHeight - other.cellFrame.height);
		}
		const nextFrame = {
			...baseFrame,
			y: baseFrame.y + offset,
			height: state?.rowHeight ?? baseFrame.height,
		};
		if (
			Math.abs(currentFrame.y - nextFrame.y) > 0.5 ||
			Math.abs(currentFrame.height - nextFrame.height) > 0.5
		)
			setNativeFrame(row, nextFrame);
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

function buildRecord(target: Message, channelId: string): Message {
	const Constructor = messageRecord;
	if (!Constructor) throw new Error('MessageRecord is unavailable');
	const payload = messagePayload(target);
	const timestamp =
		payload.timestamp instanceof Date
			? payload.timestamp
			: new Date(payload.timestamp ?? Date.now());
	const content = contentText(payload.content);
	const record = new Constructor({
		...payload,
		id: payload.id,
		type: 0,
		channel_id: channelId,
		channelId,
		guild_id: payload.guild_id ?? payload.guildId ?? null,
		guildId: payload.guildId ?? payload.guild_id ?? null,
		content,
		author: payload.author,
		attachments: payload.attachments ?? [],
		embeds: payload.embeds ?? [],
		mentions: payload.mentions ?? [],
		mention_roles: payload.mention_roles ?? [],
		mentionRoles: payload.mentionRoles ?? payload.mention_roles ?? [],
		timestamp,
		edited_timestamp: payload.edited_timestamp ?? null,
		editedTimestamp: payload.editedTimestamp ?? payload.edited_timestamp ?? null,
		pinned: Boolean(payload.pinned),
		mention_everyone: Boolean(payload.mention_everyone),
		mentionEveryone: Boolean(payload.mentionEveryone ?? payload.mention_everyone),
		tts: Boolean(payload.tts),
		flags: payload.flags ?? 0,
		components: payload.components ?? [],
		reactions: payload.reactions ?? [],
		sticker_items: payload.sticker_items ?? payload.stickerItems ?? [],
		stickers: payload.stickers ?? payload.sticker_items ?? [],
		message_reference: payload.message_reference ?? payload.messageReference ?? null,
		messageReference: payload.messageReference ?? payload.message_reference ?? null,
		message_snapshots: payload.message_snapshots ?? payload.messageSnapshots ?? [],
		messageSnapshots: payload.messageSnapshots ?? payload.message_snapshots ?? [],
		state: payload.state ?? 'SENT',
		nonce: payload.nonce ?? null,
	});
	return record;
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
		const row = generator.generate({
			rowType: 1,
			changeType: 0,
			isFirst: false,
			canAddNewReactions: false,
			canShowImages: true,
			message: record,
		});
		if (row) {
			row.renderContentOnly = false;
			row.separatorBefore = false;
			const renderedMessage = row.message as AnyRecord | undefined;
			if (renderedMessage) {
				renderedMessage.type = 0;
				renderedMessage.renderContentOnly = false;
			}
		}
		if (!row) return undefined;
		return { generator, record };
	} catch {
		return undefined;
	}
}

function surfaceFrame(state: SurfaceState, height: number): void {
	if (!fabric || state.layoutPath.length === 0) return;
	const nextHeight = Math.min(Math.max(height, EMBED_HEIGHT), MAX_HEIGHT);
	const previousRowHeight = state.rowHeight;
	const currentCellFrame = measure(state.cell);
	state.cellFrame = {
		...state.cellFrame,
		x: currentCellFrame.x,
		y: currentCellFrame.y,
		width: currentCellFrame.width,
	};
	let childHeight = nextHeight;
	for (let index = 0; index < state.layoutPath.length; index++) {
		const node = state.layoutPath[index];
		const frame = measure(node);
		const baseFrame = node.frame;
		const nextFrame = {
			...frame,
			height:
				index === 0
					? state.contentHeight + 8 + nextHeight
					: Math.max(baseFrame.height, baseFrame.y + childHeight),
		};
		setNativeFrame(node.view, nextFrame);
		nativeCall(node.view, 'setClipsToBounds:', false);
		childHeight = nextFrame.height;
	}
	const top = state.layoutPath[state.layoutPath.length - 1];
	state.rowHeight = Math.max(state.cellFrame.height, top.frame.y + childHeight);
	setNativeFrame(state.cell, { ...currentCellFrame, height: state.rowHeight });
	nativeCall(state.cell, 'setClipsToBounds:', false);
	state.height = nextHeight;
	try {
		fabric.setFrame(state.surface, {
			x: state.hostX,
			y: state.hostY,
			width: state.width,
			height: nextHeight,
		});
	} catch {}
	const table = tableForCell(state.cell);
	if (table && Math.abs(previousRowHeight - state.rowHeight) > 0.25) shiftTableRows(table);
}

function clearSurfaceFrameTimers(surfaceId: string): void {
	const timers = surfaceFrameTimers.get(surfaceId);
	if (!timers) return;
	for (const timer of timers) clearTimeout(timer);
	surfaceFrameTimers.delete(surfaceId);
}

function scheduleSurfaceFrame(surfaceId: string, state: SurfaceState): void {
	clearSurfaceFrameTimers(surfaceId);
	const timers: ReturnType<typeof setTimeout>[] = [];
	for (const delay of [0, 48, 160, 320]) {
		timers.push(
			setTimeout(() => {
				if (surfaces.get(surfaceId) !== state) return;
				surfaceFrame(state, state.height);
			}, delay),
		);
	}
	surfaceFrameTimers.set(surfaceId, timers);
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
			style: {
				backgroundColor: '#2b2d31',
				borderRadius: 8,
				minHeight: EMBED_HEIGHT,
				overflow: 'hidden',
				paddingLeft: 8,
				paddingTop: 8,
				width: state.width,
			},
		},
		React.createElement(chatItem, { message: state.record, rowGenerator: state.generator }),
	);
}

function registerSurface(): boolean {
	if (surfaceRegistered) return true;
	const registry =
		(metro.common.ReactNative as AnyRecord).AppRegistry ??
		metro.findByProps('registerComponent', 'runApplication');
	if (!registry || typeof registry.registerComponent !== 'function') return false;
	try {
		registry.registerComponent(SURFACE_MODULE, () => MessageSurface);
		surfaceRegistered = true;
		return true;
	} catch {
		return false;
	}
}

function removeCellSurface(key: string, clearRowBase: boolean = false): void {
	const state = cellStates.get(key);
	if (!state || !fabric) {
		cellStates.delete(key);
		if (clearRowBase) rowBaseFrames.delete(key);
		return;
	}
	const surface = surfaces.get(state.surfaceId);
	if (surface) {
		clearSurfaceFrameTimers(state.surfaceId);
		for (const node of surface.layoutPath) setNativeFrame(node.view, node.frame);
		setNativeFrame(surface.cell, surface.cellFrame);
		try {
			fabric.unmount(surface.surface);
		} catch {}
		surfaces.delete(state.surfaceId);
	}
	cellStates.delete(key);
	if (clearRowBase) rowBaseFrames.delete(key);
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
		sizeOverrides.delete(key);
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
			return false;
		}
		removeCellSurface(key);
	}

	const surfaceContent = buildSurfaceContent(source, target);
	if (!surfaceContent) return false;
	const content = contentContainer(cell);
	const host = createSurfaceHost(cell, content);
	if (!host) return false;
	const surfaceId = `message-link-${key}-${target.id}`;
	const state = {
		cell,
		generator: surfaceContent.generator,
		height: ESTIMATED_HEIGHT,
		hostX: host.hostX,
		hostY: host.hostY,
		record: surfaceContent.record,
		rowHeight: host.cellFrame.height,
		source,
		surface: null as unknown as NativeFabricSurface,
		target,
		width: host.width,
		contentHeight: host.contentHeight,
		cellFrame: host.cellFrame,
		layoutPath: host.layoutPath,
	};
	surfaces.set(surfaceId, state);
	try {
		state.surface = fabric.mount(host.parent, SURFACE_MODULE, {
			surfaceId,
			targetMessageId: target.id,
		});
		fabric.setSize(
			state.surface,
			{ width: state.width, height: EMBED_HEIGHT },
			{ width: state.width, height: MAX_HEIGHT },
		);
		surfaceFrame(state, EMBED_HEIGHT);
		cellStates.set(key, { cell, surfaceId });
		scheduleSurfaceFrame(surfaceId, state);
		return false;
	} catch {
		for (const node of host.layoutPath) setNativeFrame(node.view, node.frame);
		setNativeFrame(cell, host.cellFrame);
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
		try {
			const retry = renderCell(cell);
			if (retry && attempt < 10) setTimeout(() => scheduleCell(cell, attempt + 1), 120);
		} catch {}
	}, 0);
}

function scheduleVisibleCells(view: NativeObjectHandle, depth: number = 0): void {
	if (depth > 48 || !objc) return;
	if ((objc.className(view) ?? '') === 'DCDMessageTableViewCell') {
		scheduleCell(view);
	}
	for (const child of nativeChildren(view)) scheduleVisibleCells(child, depth + 1);
}

function scheduleWindowCells(): void {
	if (!objc || !native) return;
	const windowClass = objc.getClass('UIWindow');
	const keyWindow = windowClass
		? (nativeCall(windowClass, 'keyWindow') as NativeObjectHandle)
		: null;
	if (keyWindow) scheduleVisibleCells(keyWindow);
}

function installHooks(): void {
	if (!objc || hookTokens.length > 0) return;
	const replaceSize = ({ self, original, args }: AnyRecord): unknown => {
		const height = linkedCellHeight(self as NativeObjectHandle);
		if (height === null || !objc) return (original as NativeOriginal)(...(args as unknown[]));
		return objc.struct('CGSize', { width: measure(self as NativeObjectHandle).width, height });
	};
	const layout = objc.hook('DCDMessageTableViewCell', 'layoutSubviews', {
		after: ({ self }) => scheduleCell(self),
	});
	const lifecycleHook = objc.hook('DCDMessageTableViewCell', 'didMoveToWindow', {
		after: ({ self }) => {
			if (!nativeCall(self, 'window')) {
				const key = cellKey(self);
				if (key) {
					activeCells.delete(key);
					removeCellSurface(key, true);
				}
				return;
			}
			scheduleCell(self);
		},
	});
	const reuse = objc.hook('DCDMessageTableViewCell', 'prepareForReuse', {
		after: ({ self }) => {
			const key = cellKey(self);
			if (key) {
				sizeOverrides.delete(key);
				removeCellSurface(key, true);
			}
		},
	});
	hookTokens.push(layout, lifecycleHook, reuse);
	for (const selector of [
		'systemLayoutSizeFittingSize:',
		'systemLayoutSizeFittingSize:withHorizontalFittingPriority:verticalFittingPriority:',
		'sizeThatFits:',
	]) {
		try {
			hookTokens.push(
				objc.hook('DCDMessageTableViewCell', selector, {
					replace: replaceSize,
				}),
			);
		} catch {}
	}
}

function install(context: PluginContext): void {
	if (retryTimer) return;
	native = context.native;
	objc = native.objc;
	fabric = native.fabric;
	messages = metro.findStore('MessageStore', { short: false }) ?? metro.findStore('Message');
	messageActions = metro.findByProps('fetchMessage');
	selectedChannel = metro.findByProps('getLastSelectedChannelId', 'getChannelId');
	messageRecord = metro.findByName('MessageRecord');
	rowManager = metro.findByName('RowManager');
	const module = metro.findByFilePath(CHAT_ITEM_PATH, { interop: false });
	chatItem = typeof module?.default === 'function' ? module.default : null;

	if (!messages?.getMessage || !messageActions?.fetchMessage || !messageRecord || !rowManager) {
		retryTimer = setTimeout(() => {
			retryTimer = null;
			if (native) install(context);
		}, 250);
		return;
	}
	if (!chatItem) {
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
	scheduleWindowCells();
	setTimeout(scheduleWindowCells, 1000);
	setTimeout(scheduleWindowCells, 3000);
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
	for (const surfaceId of surfaceFrameTimers.keys()) clearSurfaceFrameTimers(surfaceId);
	surfaces.clear();
	sizeOverrides.clear();
	rowBaseFrames.clear();
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
	selectedChannel = null;
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
