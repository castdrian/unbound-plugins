import { metro } from '@unbound-app/api';
import type {
	NativeFabricBridge,
	NativeFabricSurface,
	NativeHookToken,
	NativeObjCBridge,
	NativeObjectHandle,
	PluginContext,
} from '@unbound-app/api/native';
import type { ReactNode } from 'react';

import {
	contentText,
	findRenderedLinkRange,
	type LinkTarget,
	linkedTargets,
	nativeUsernameColor,
} from '#link-targets';

const CHAT_ITEM_PATH = 'components_native/chat/ChatItem.tsx';
const SURFACE_MODULE_PREFIX = 'MessageLinkEmbedSurface';
const MIN_SURFACE_HEIGHT = 72;
const INITIAL_SURFACE_HEIGHT = MIN_SURFACE_HEIGHT;
const MAX_SURFACE_HEIGHT = 520;
const SURFACE_BOTTOM_TRIM = 5;
const EMBED_BACKGROUND = '#2b2d31';
const MAX_NATIVE_VIEW_DEPTH = 10;

type AnyRecord = Record<string, unknown>;
type MetroModule = {
	isInitialized?: boolean;
	publicModule?: { exports?: unknown };
};
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
type MessageStore = {
	getMessage?: (channelId: string, messageId: string) => Message | null;
};
type MessageActions = {
	fetchMessage?: (target: LinkTarget) => Promise<Message | null>;
	jumpToMessage?: (options: {
		channelId: string;
		messageId: string;
		flash: boolean;
		jumpType: string;
	}) => unknown;
};
type ChannelStore = {
	getChannel?: (channelId: string) => AnyRecord | undefined;
};
type SelectedChannel = {
	getChannelId?: () => string | undefined;
	getLastSelectedChannelId?: () => string | undefined;
};
type MessageRecordConstructor = (...args: never[]) => unknown;
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
type RowManagerConstructor = (...args: never[]) => unknown;
type ChatItemProps = {
	message: Message;
	rowGenerator: RowGenerator;
};
type ChatItemComponent = (props: ChatItemProps) => ReactNode;
type EmbeddedContent = {
	generator: RowGenerator;
	record: Message;
};
type NativeMessageInfo = {
	channelId?: string;
	messageId: string;
};
type EmbeddedSurfaceState = {
	cell: NativeObjectHandle;
	cellKey: string;
	channelName: string;
	font: NativeObjectHandle | null;
	generator: RowGenerator;
	highlight: NativeObjectHandle | null;
	host: NativeObjectHandle;
	label: NativeObjectHandle;
	labelHook: NativeHookToken | null;
	messageId: string;
	original: NativeObjectHandle;
	range: { location: number; length: number };
	record: Message;
	rendered: NativeObjectHandle | null;
	renderedText: string | null;
	selectedTarget: LinkTarget;
	surface: NativeFabricSurface | null;
	surfaceId: string;
	width: number;
	height: number;
	lastInvalidatedHeight: number;
	applying: boolean;
};
type SurfaceProps = {
	surfaceId: string;
};
type CellUpdateStatus = 'done' | 'retry' | 'waiting';

let objc: NativeObjCBridge | null = null;
let fabric: NativeFabricBridge | null = null;
let messages: MessageStore | null = null;
let messageActions: MessageActions | null = null;
let channelStore: ChannelStore | null = null;
let selectedChannel: SelectedChannel | null = null;
let messageRecord: MessageRecordConstructor | null = null;
let rowManager: RowManagerConstructor | null = null;
let chatItem: ChatItemComponent | null = null;
let moduleListenerCleanup: (() => boolean) | null = null;
let hooks: NativeHookToken[] = [];
let lifecycle = 0;
let surfaceModuleName = '';

const cachedMessages = new Map<string, Message>();
const pendingMessages = new Set<string>();
const activeCells = new Map<string, NativeObjectHandle>();
const pendingCells = new Set<string>();
const completedCells = new Set<string>();
const retryCounts = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const waitingCells = new Map<string, string>();
const cellStates = new Map<string, EmbeddedSurfaceState>();
const surfaces = new Map<string, EmbeddedSurfaceState>();
const cellLabelHooks = new Map<string, NativeHookToken[]>();

function nativeCall(handle: NativeObjectHandle, selector: string, ...args: unknown[]): unknown {
	if (!objc) return null;
	try {
		return objc.invoke(handle, selector, args, { thread: 'main' });
	} catch {
		return null;
	}
}

function nativeRange(location: number, length: number): unknown {
	return objc?.struct('NSRange', { location, length }) ?? null;
}

function nativeChildren(handle: NativeObjectHandle): NativeObjectHandle[] {
	if (!objc) return [];
	const subviews = nativeCall(handle, 'subviews');
	if (Array.isArray(subviews)) return subviews as NativeObjectHandle[];
	if (!subviews || typeof subviews !== 'object') return [];
	try {
		return objc.array(subviews as NativeObjectHandle);
	} catch {
		return [];
	}
}

function messageKey(channelId: string, messageId: string): string {
	return `${channelId}:${messageId}`;
}

function currentChannelId(): string | undefined {
	return selectedChannel?.getChannelId?.() ?? selectedChannel?.getLastSelectedChannelId?.();
}

function stringFromNative(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (!objc || !value || typeof value !== 'object') return;
	const handle = value as NativeObjectHandle;
	if (!objc.respondsTo(handle, 'description')) return;
	const description = nativeCall(handle, 'description');
	return typeof description === 'string' ? description : undefined;
}

function messageInfoForCell(cell: NativeObjectHandle): NativeMessageInfo | undefined {
	if (!objc) return;
	try {
		const viewModel = objc.getIvar(cell, 'viewModel') as NativeObjectHandle | null;
		if (!viewModel || !objc.respondsTo(viewModel, 'message')) return;
		const message = nativeCall(viewModel, 'message') as NativeObjectHandle | null;
		if (!message) return;
		const messageId = stringFromNative(nativeCall(message, 'id'));
		if (!messageId) return;
		const channel = nativeCall(message, 'channel');
		const channelId =
			stringFromNative(nativeCall(message, 'channelId')) ??
			stringFromNative(nativeCall(message, 'channel_id')) ??
			(channel && typeof channel === 'object'
				? stringFromNative(nativeCall(channel as NativeObjectHandle, 'id'))
				: undefined);
		return { channelId, messageId };
	} catch {
		return;
	}
}

function cellKey(cell: NativeObjectHandle): string | undefined {
	const hash = nativeCall(cell, 'hash');
	if (hash !== null && hash !== undefined) return String(hash);
	const description = nativeCall(cell, 'description');
	return typeof description === 'string' ? description : undefined;
}

function textViewsInView(
	view: NativeObjectHandle,
	depth: number = 0,
	result: NativeObjectHandle[] = [],
): NativeObjectHandle[] {
	if (!objc || depth > MAX_NATIVE_VIEW_DEPTH || result.length >= 32) return result;
	if (objc.respondsTo(view, 'attributedText') && objc.respondsTo(view, 'setAttributedText:')) {
		result.push(view);
	}
	for (const child of nativeChildren(view)) textViewsInView(child, depth + 1, result);
	return result;
}

function visibleMessageCellsInCell(cell: NativeObjectHandle): NativeObjectHandle[] {
	if (!objc) return [];
	let table = nativeCall(cell, 'superview') as NativeObjectHandle | null;
	for (let depth = 0; table && depth < MAX_NATIVE_VIEW_DEPTH; depth++) {
		if ((objc.className(table) ?? '').includes('DCDTableView')) break;
		table = nativeCall(table, 'superview') as NativeObjectHandle | null;
	}
	if (!table || !(objc.className(table) ?? '').includes('DCDTableView')) return [];
	const visibleCells = nativeCall(table, 'visibleCells');
	try {
		const cells = Array.isArray(visibleCells)
			? (visibleCells as NativeObjectHandle[])
			: visibleCells && typeof visibleCells === 'object'
				? objc.array(visibleCells as NativeObjectHandle)
				: [];
		return cells.filter((value) =>
			(objc.className(value) ?? '').includes('DCDMessageTableViewCell'),
		);
	} catch {
		return [];
	}
}

function textForView(view: NativeObjectHandle): string | undefined {
	const attributedText = nativeCall(view, 'attributedText') as NativeObjectHandle | null;
	const text = attributedText ? nativeCall(attributedText, 'string') : null;
	return typeof text === 'string' ? text : undefined;
}

function channelNameFor(target: LinkTarget, targetMessage: Message): string | undefined {
	const channel = channelStore?.getChannel?.(target.channelId);
	const fromStore = channel?.name;
	if (typeof fromStore === 'string' && fromStore.length > 0) return fromStore;
	const fromMessage = targetMessage.channelName ?? targetMessage.channel_name;
	return typeof fromMessage === 'string' && fromMessage.length > 0 ? fromMessage : undefined;
}

function linkAttributes(
	attributedText: NativeObjectHandle,
	range: { location: number; length: number },
): { font: NativeObjectHandle | null; highlight: NativeObjectHandle | null } {
	if (!objc) return { font: null, highlight: null };
	const text = stringFromNative(nativeCall(attributedText, 'string')) ?? '';
	const end = range.location + range.length;
	for (let index = range.location; index < end; index++) {
		if (text[index] !== '\uFFFC') continue;
		const values = nativeCall(attributedText, 'attributesAtIndex:effectiveRange:', index, null);
		if (!values || typeof values !== 'object') continue;
		const attributes = values as AnyRecord;
		if (!attributes.YYTextAttachment) continue;
		return {
			font: (attributes.NSFont as NativeObjectHandle | undefined) ?? null,
			highlight: (attributes.YYTextHighlight as NativeObjectHandle | undefined) ?? null,
		};
	}
	return { font: null, highlight: null };
}

function messagePayload(message: Message): Message {
	for (const key of ['message', 'message_snapshot', 'messageSnapshot']) {
		const nested = message[key] as Message | undefined;
		if (nested && typeof nested.id === 'string' && nested.id !== message.id) return nested;
	}
	for (const key of ['message_snapshots', 'messageSnapshots']) {
		const snapshots = message[key];
		if (!Array.isArray(snapshots)) continue;
		for (const snapshot of snapshots) {
			if (snapshot && typeof snapshot.id === 'string' && snapshot.id !== message.id) {
				return snapshot as Message;
			}
		}
	}
	return message;
}

function buildRecord(target: Message, channelId: string): Message {
	if (!messageRecord) throw new Error('MessageRecord is unavailable');
	const payload = messagePayload(target);
	const timestamp =
		payload.timestamp instanceof Date
			? payload.timestamp
			: new Date(payload.timestamp ?? Date.now());
	return Reflect.construct(messageRecord, [
		{
			...payload,
			id: payload.id,
			type: 0,
			channel_id: channelId,
			channelId,
			guild_id: payload.guild_id ?? payload.guildId ?? null,
			guildId: payload.guildId ?? payload.guild_id ?? null,
			content: contentText(payload.content),
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
		},
	]) as Message;
}

function buildEmbeddedContent(target: Message, channelId: string): EmbeddedContent | undefined {
	if (!messageRecord || !rowManager) return;
	try {
		const record = buildRecord(target, channelId);
		const usernameColor = nativeUsernameColor(record.colorString);
		if (usernameColor !== undefined) record.usernameColor = usernameColor;
		record.animateEmoji = true;
		record.gifAutoPlay = true;
		const generator = Reflect.construct(rowManager, []) as RowGenerator;
		const generate = generator.generate.bind(generator);
		generator.generate = (input) => {
			const row = generate(input);
			const renderedMessage = row?.message as AnyRecord | undefined;
			if (renderedMessage) {
				renderedMessage.type = 0;
				renderedMessage.renderContentOnly = false;
				renderedMessage.animateEmoji = true;
				renderedMessage.gifAutoPlay = true;
				if (usernameColor !== undefined) {
					renderedMessage.colorString = usernameColor;
					renderedMessage.usernameColor = usernameColor;
				}
			}
			return row;
		};
		const row = generator.generate({
			rowType: 1,
			changeType: 0,
			isFirst: false,
			canAddNewReactions: false,
			canShowImages: true,
			message: record,
		});
		if (!row) return;
		row.renderContentOnly = false;
		row.separatorBefore = false;
		return { generator, record };
	} catch {
		return;
	}
}

function linkedMessage(target: LinkTarget): Message | null {
	const key = messageKey(target.channelId, target.messageId);
	const cached = cachedMessages.get(key);
	if (cached) return cached;
	const message = messages?.getMessage?.(target.channelId, target.messageId) ?? null;
	if (message) cachedMessages.set(key, message);
	return message;
}

function wakeTargetCells(targetKey: string): void {
	for (const [key, waitingTarget] of waitingCells) {
		if (waitingTarget !== targetKey) continue;
		waitingCells.delete(key);
		completedCells.delete(key);
		retryCounts.delete(key);
		const cell = activeCells.get(key);
		if (cell) scheduleCell(cell);
	}
}

function fetchLinkedMessage(target: LinkTarget): void {
	const key = messageKey(target.channelId, target.messageId);
	if (pendingMessages.has(key) || linkedMessage(target)) return;
	pendingMessages.add(key);
	const token = lifecycle;
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
			if (token !== lifecycle) return;
			const resolved = messages?.getMessage?.(target.channelId, target.messageId) ?? result;
			if (resolved) cachedMessages.set(key, resolved);
		})
		.catch(() => undefined)
		.finally(() => {
			pendingMessages.delete(key);
			if (token === lifecycle) wakeTargetCells(key);
		});
}

function jumpToMessage(target: LinkTarget): void {
	try {
		const actions = messageActions?.jumpToMessage
			? messageActions
			: metro.findByProps('jumpToMessage');
		actions?.jumpToMessage?.({
			channelId: target.channelId,
			flash: true,
			jumpType: 'INSTANT',
			messageId: target.messageId,
		});
	} catch {
		return;
	}
}

function nativeFrame(width: number, height: number): unknown {
	return objc?.struct('CGRect', { origin: { x: 0, y: 0 }, size: { width, height } }) ?? null;
}

function availableMessageWidth(cell: NativeObjectHandle, label: NativeObjectHandle): number {
	if (!fabric) return 0;
	const labelWidth = fabric.measure(label).width;
	const cellWidth = fabric.measure(cell).width;
	if (!Number.isFinite(labelWidth) || !Number.isFinite(cellWidth)) return labelWidth;
	const targetKey = cellKey(cell);
	let view = label;
	let left = 0;
	for (let depth = 0; depth < MAX_NATIVE_VIEW_DEPTH; depth++) {
		const frame = fabric.measure(view);
		left += frame.x;
		const parent = nativeCall(view, 'superview') as NativeObjectHandle | null;
		if (!parent || cellKey(parent) === targetKey) break;
		view = parent;
	}
	const availableWidth = cellWidth - left - 12;
	if (!Number.isFinite(availableWidth) || availableWidth < 80) return labelWidth;
	return Math.max(labelWidth, Math.min(cellWidth, availableWidth));
}

function createHost(width: number, height: number): NativeObjectHandle | null {
	if (!objc) return null;
	try {
		const view = objc.alloc('UIView');
		objc.invoke(view, 'setFrame:', [nativeFrame(width, height)], {
			thread: 'main',
		});
		return view;
	} catch {
		return null;
	}
}

function attributedAttachment(state: EmbeddedSurfaceState): NativeObjectHandle | null {
	if (!objc) return null;
	const attachmentClass = objc.getClass('YYTextAttachment');
	if (!attachmentClass) return null;
	const attachment = objc.alloc(attachmentClass);
	nativeCall(attachment, 'setValue:forKey:', state.host, 'content');
	nativeCall(attachment, 'setValue:forKey:', 1, 'contentMode');
	const attributes: AnyRecord = {};
	if (state.font) attributes.NSFont = state.font;
	if (state.highlight) attributes.YYTextHighlight = state.highlight;
	const replacement = objc.alloc('NSMutableAttributedString');
	nativeCall(replacement, 'initWithString:attributes:', '\uFFFC', attributes);
	nativeCall(
		replacement,
		'addAttribute:value:range:',
		'YYTextAttachment',
		attachment,
		nativeRange(0, 1),
	);
	const delegateClass = objc.getClass('YYTextRunDelegate');
	if (delegateClass) {
		const delegate = objc.alloc(delegateClass);
		nativeCall(delegate, 'setValue:forKey:', state.height, 'ascent');
		nativeCall(delegate, 'setValue:forKey:', 0, 'descent');
		nativeCall(delegate, 'setValue:forKey:', state.width, 'width');
		const coreDelegate = nativeCall(delegate, 'CTRunDelegate');
		if (coreDelegate) {
			nativeCall(
				replacement,
				'addAttribute:value:range:',
				'CTRunDelegate',
				coreDelegate,
				nativeRange(0, 1),
			);
		}
	}
	return replacement;
}

function structFields(value: unknown): AnyRecord {
	if (!value || typeof value !== 'object') return {};
	const fields = (value as AnyRecord).value;
	return fields && typeof fields === 'object' ? (fields as AnyRecord) : {};
}

function tableForCell(cell: NativeObjectHandle): NativeObjectHandle | null {
	if (!objc) return null;
	let current: NativeObjectHandle | null = cell;
	for (let depth = 0; depth < 14 && current; depth++) {
		if (objc.respondsTo(current, 'beginUpdates') && objc.respondsTo(current, 'endUpdates')) {
			return current;
		}
		current = nativeCall(current, 'superview') as NativeObjectHandle | null;
	}
	return null;
}

function tableBottomAnchor(table: NativeObjectHandle): {
	atBottom: boolean;
	inverted: boolean;
	x: number;
} {
	const contentSize = structFields(nativeCall(table, 'contentSize'));
	const contentOffset = structFields(nativeCall(table, 'contentOffset'));
	const bounds = structFields(nativeCall(table, 'bounds'));
	const boundsSize = bounds.size as AnyRecord | undefined;
	const transform = structFields(nativeCall(table, 'transform'));
	const contentInset = structFields(nativeCall(table, 'adjustedContentInset'));
	const contentHeight = Number(contentSize.height);
	const viewportHeight = Number(boundsSize?.height);
	const offsetY = Number(contentOffset.y);
	const topInset = Number(contentInset.top ?? 0);
	const bottomInset = Number(contentInset.bottom ?? 0);
	const maximumOffset = contentHeight - viewportHeight + bottomInset;
	const inverted = Number(transform.d) < 0;
	const bottomOffset = inverted ? -topInset : Math.max(-topInset, maximumOffset);
	const x = Number(contentOffset.x);
	return {
		atBottom:
			Number.isFinite(bottomOffset) &&
			Number.isFinite(offsetY) &&
			Math.abs(bottomOffset - offsetY) <= Math.max(36, topInset + bottomInset),
		inverted,
		x: Number.isFinite(x) ? x : 0,
	};
}

function refreshRowSize(state: EmbeddedSurfaceState, force: boolean = false): void {
	if (!objc || (!force && state.lastInvalidatedHeight === state.height)) return;
	state.lastInvalidatedHeight = state.height;
	nativeCall(state.label, 'invalidateIntrinsicContentSize');
	nativeCall(state.label, 'setNeedsLayout');
	nativeCall(state.cell, 'setNeedsUpdateConstraints');
	nativeCall(state.cell, 'setNeedsLayout');
	const table = tableForCell(state.cell);
	if (!table) return;
	const anchor = tableBottomAnchor(table);
	nativeCall(table, 'beginUpdates');
	nativeCall(table, 'endUpdates');
	if (anchor.atBottom) {
		const contentSize = structFields(nativeCall(table, 'contentSize'));
		const bounds = structFields(nativeCall(table, 'bounds'));
		const boundsSize = bounds.size as AnyRecord | undefined;
		const contentInset = structFields(nativeCall(table, 'adjustedContentInset'));
		const contentHeight = Number(contentSize.height);
		const viewportHeight = Number(boundsSize?.height);
		const bottomInset = Number(contentInset.bottom ?? 0);
		const topInset = Number(contentInset.top ?? 0);
		if (Number.isFinite(contentHeight) && Number.isFinite(viewportHeight)) {
			const y = anchor.inverted
				? -topInset
				: Math.max(-topInset, contentHeight - viewportHeight + bottomInset);
			const currentOffset = structFields(nativeCall(table, 'contentOffset'));
			if (Math.abs(Number(currentOffset.y) - y) > 1) {
				nativeCall(
					table,
					'setContentOffset:animated:',
					objc.struct('CGPoint', { x: anchor.x, y }),
					false,
				);
			}
		}
	}
}

function applyAttachment(state: EmbeddedSurfaceState, forceRefresh: boolean = false): boolean {
	if (!objc) return false;
	if (state.applying) return false;
	state.applying = true;
	try {
		const attachment = attributedAttachment(state);
		if (!attachment) return false;
		const updated = nativeCall(state.original, 'mutableCopy') as NativeObjectHandle | null;
		if (!updated) return false;
		nativeCall(
			updated,
			'replaceCharactersInRange:withAttributedString:',
			nativeRange(state.range.location, state.range.length),
			attachment,
		);
		const text = stringFromNative(nativeCall(updated, 'string'));
		if (typeof text !== 'string') return false;
		state.rendered = updated;
		state.renderedText = text;
		nativeCall(state.label, 'setAttributedText:', updated);
		nativeCall(state.label, 'setNeedsLayout');
		refreshRowSize(state, forceRefresh);
		return true;
	} finally {
		state.applying = false;
	}
}

function repairSurface(state: EmbeddedSurfaceState): void {
	if (!objc || cellStates.get(state.cellKey) !== state || state.applying) return;
	const info = messageInfoForCell(state.cell);
	if (info?.messageId && info.messageId !== state.messageId) {
		teardownSurface(state.cellKey, true);
		return;
	}
	const attributedText = currentAttributedText(state.label);
	const text = attributedText ? textForView(state.label) : undefined;
	if (!attributedText || text === undefined || text === state.renderedText) return;
	const range = findRenderedLinkRange(text, state.channelName);
	if (!range) return;
	state.original = attributedText;
	state.range = range;
	const attributes = linkAttributes(attributedText, range);
	state.font = attributes.font;
	state.highlight = attributes.highlight;
	applyAttachment(state);
}

function reportSurfaceLayout(surfaceId: string, height: number): void {
	const state = surfaces.get(surfaceId);
	if (!state || !Number.isFinite(height) || height <= 0 || height > MAX_SURFACE_HEIGHT) return;
	const fittedHeight = Math.max(MIN_SURFACE_HEIGHT, height - SURFACE_BOTTOM_TRIM);
	if (Math.abs(state.height - fittedHeight) < 2) return;
	state.height = fittedHeight;
	nativeCall(state.host, 'setFrame:', nativeFrame(state.width, fittedHeight));
	applyAttachment(state, true);
}

function MessageSurface({ surfaceId }: SurfaceProps): ReactNode {
	const state = surfaces.get(surfaceId);
	const { React, ReactNative } = metro.common;
	if (!state || !chatItem) return React.createElement(ReactNative.View, { style: { height: 1 } });
	const onLayout = (event: AnyRecord) => {
		const height = Number(event?.nativeEvent?.layout?.height);
		if (height > 0) reportSurfaceLayout(surfaceId, height);
	};
	return React.createElement(
		ReactNative.Pressable,
		{
			accessibilityLabel: 'Open linked message',
			accessibilityRole: 'button',
			onLayout,
			onPress: () => jumpToMessage(state.selectedTarget),
			style: {
				backgroundColor: EMBED_BACKGROUND,
				borderRadius: 8,
				overflow: 'hidden',
				minHeight: MIN_SURFACE_HEIGHT,
				paddingBottom: 0,
				paddingTop: 6,
				width: state.width,
			},
		},
		React.createElement(chatItem, {
			message: state.record,
			rowGenerator: state.generator,
		}),
	);
}

function resolveChatItem(value: unknown, depth: number = 0): ChatItemComponent | null {
	if (typeof value === 'function') return value as ChatItemComponent;
	if (!value || typeof value !== 'object' || depth >= 5) return null;
	const wrapped = value as AnyRecord;
	return resolveChatItem(wrapped.type ?? wrapped.render ?? wrapped.default, depth + 1);
}

function modulePath(id: number | string): string | undefined {
	const window = (globalThis as AnyRecord).window as AnyRecord | undefined;
	const modules = window?.modules as { get?: (id: number) => AnyRecord | undefined } | undefined;
	return modules?.get?.(Number(id))?.__filePath as string | undefined;
}

function registerSurface(): boolean {
	if (surfaceModuleName) return true;
	const window = (globalThis as AnyRecord).window as AnyRecord | undefined;
	const registry =
		(metro.common.ReactNative as AnyRecord).AppRegistry ??
		window?.RN$AppRegistry ??
		metro.findByProps('registerComponent', 'runApplication');
	if (!registry || typeof registry.registerComponent !== 'function') return false;
	surfaceModuleName = `${SURFACE_MODULE_PREFIX}${lifecycle}`;
	try {
		registry.registerComponent(surfaceModuleName, () => MessageSurface);
		return true;
	} catch {
		surfaceModuleName = '';
		return false;
	}
}

function createSurfaceState(
	cell: NativeObjectHandle,
	key: string,
	info: NativeMessageInfo,
	target: LinkTarget,
	channelName: string,
	label: NativeObjectHandle,
	attributedText: NativeObjectHandle,
	range: { location: number; length: number },
	content: EmbeddedContent,
): EmbeddedSurfaceState | null {
	if (!objc || !fabric) return null;
	const width = availableMessageWidth(cell, label);
	if (!Number.isFinite(width) || width < 80) return null;
	const attributes = linkAttributes(attributedText, range);
	const host = createHost(width, INITIAL_SURFACE_HEIGHT);
	if (!host) return null;
	const surfaceId = `message-link-${key}-${info.messageId}-${target.messageId}`;
	const state: EmbeddedSurfaceState = {
		cell,
		cellKey: key,
		channelName,
		font: attributes.font,
		generator: content.generator,
		highlight: attributes.highlight,
		host,
		label,
		labelHook: null,
		messageId: info.messageId,
		original: attributedText,
		range,
		record: content.record,
		rendered: null,
		renderedText: null,
		selectedTarget: target,
		surface: null,
		surfaceId,
		width,
		height: INITIAL_SURFACE_HEIGHT,
		lastInvalidatedHeight: -1,
		applying: false,
	};
	surfaces.set(surfaceId, state);
	try {
		state.labelHook = objc.hook(
			'DCDReusableYYLabel',
			'setAttributedText:',
			{ after: () => repairSurface(state) },
			{ instance: label },
		);
		state.surface = fabric.mount(host, surfaceModuleName, { surfaceId });
		fabric.setSize(
			state.surface,
			{ width, height: MIN_SURFACE_HEIGHT },
			{ width, height: MAX_SURFACE_HEIGHT },
		);
		removeCellLabelHooks(key);
		cellStates.set(key, state);
		if (!applyAttachment(state)) throw new Error('Could not attach the Fabric message surface');
		return state;
	} catch {
		cellStates.delete(key);
		state.labelHook?.remove();
		try {
			if (state.surface) fabric.unmount(state.surface);
		} catch {
			void 0;
		}
		surfaces.delete(surfaceId);
		return null;
	}
}

function teardownSurface(key: string, restore: boolean): void {
	const state = cellStates.get(key);
	if (!state) return;
	state.labelHook?.remove();
	if (restore && objc && state.rendered && state.renderedText !== null) {
		const current = nativeCall(state.label, 'attributedText') as NativeObjectHandle | null;
		const currentText = current ? stringFromNative(nativeCall(current, 'string')) : undefined;
		if (current && (currentText === state.renderedText || current === state.rendered)) {
			nativeCall(state.label, 'setAttributedText:', state.original);
			nativeCall(state.label, 'setNeedsLayout');
		}
	}
	if (state.surface) {
		try {
			fabric?.unmount(state.surface);
		} catch {
			void 0;
		}
	}
	surfaces.delete(state.surfaceId);
	cellStates.delete(key);
}

function cachedContentFor(target: LinkTarget, message: Message): EmbeddedContent | undefined {
	return buildEmbeddedContent(message, target.channelId);
}

function currentAttributedText(view: NativeObjectHandle): NativeObjectHandle | null {
	return nativeCall(view, 'attributedText') as NativeObjectHandle | null;
}

function updateExistingSurface(
	state: EmbeddedSurfaceState,
	attributedText: NativeObjectHandle,
	range: { location: number; length: number },
): void {
	state.original = attributedText;
	state.range = range;
	const attributes = linkAttributes(attributedText, range);
	state.font = attributes.font;
	state.highlight = attributes.highlight;
	applyAttachment(state);
}

function updateCell(cell: NativeObjectHandle): CellUpdateStatus {
	if (!objc || !fabric) return 'done';
	const key = cellKey(cell);
	const info = messageInfoForCell(cell);
	if (!key || !info) return 'retry';
	const channelId = info.channelId ?? currentChannelId();
	if (!channelId) return 'retry';
	const source = messages?.getMessage?.(channelId, info.messageId);
	const targets = source ? linkedTargets(source) : [];
	if (!source || targets.length === 0) {
		const state = cellStates.get(key);
		if (state && state.messageId !== info.messageId) teardownSurface(key, true);
		return source ? 'done' : 'retry';
	}
	const target = targets[0];
	const targetMessage = linkedMessage(target);
	if (!targetMessage) {
		waitingCells.set(key, messageKey(target.channelId, target.messageId));
		fetchLinkedMessage(target);
		return 'waiting';
	}
	const channelName = channelNameFor(target, targetMessage);
	if (!channelName) return 'retry';
	const existing = cellStates.get(key);
	if (
		existing &&
		existing.messageId === info.messageId &&
		existing.selectedTarget.messageId === target.messageId
	) {
		const attributedText = currentAttributedText(existing.label);
		const text = attributedText ? textForView(existing.label) : undefined;
		if (!attributedText || text === undefined) return 'retry';
		if (text === existing.renderedText) return 'done';
		const range = findRenderedLinkRange(text, channelName);
		if (!range) return 'retry';
		updateExistingSurface(existing, attributedText, range);
		return 'done';
	}
	if (existing) teardownSurface(key, false);
	const content = nativeCall(cell, 'contentView') as NativeObjectHandle | null;
	if (!content) return 'retry';
	for (const label of textViewsInView(content)) {
		const attributedText = currentAttributedText(label);
		const text = attributedText ? textForView(label) : undefined;
		if (!attributedText || text === undefined) continue;
		const range = findRenderedLinkRange(text, channelName);
		if (!range) continue;
		const built = cachedContentFor(target, targetMessage);
		if (!built) return 'retry';
		const state = createSurfaceState(
			cell,
			key,
			info,
			target,
			channelName,
			label,
			attributedText,
			range,
			built,
		);
		return state ? 'done' : 'retry';
	}
	return 'retry';
}

function scheduleCell(cell: NativeObjectHandle): void {
	const key = cellKey(cell);
	if (!key) return;
	activeCells.set(key, cell);
	if (
		cellStates.has(key) ||
		pendingCells.has(key) ||
		completedCells.has(key) ||
		waitingCells.has(key) ||
		retryTimers.has(key)
	)
		return;
	pendingCells.add(key);
	const token = lifecycle;
	setTimeout(() => {
		pendingCells.delete(key);
		if (token !== lifecycle || !objc) return;
		try {
			const status = updateCell(cell);
			if (status === 'done') {
				completedCells.add(key);
				retryCounts.delete(key);
				return;
			}
			if (status === 'waiting') return;
			observeCellLabels(cell);
			const attempts = (retryCounts.get(key) ?? 0) + 1;
			retryCounts.set(key, attempts);
			if (attempts > 8) {
				completedCells.add(key);
				return;
			}
			const timer = setTimeout(() => {
				retryTimers.delete(key);
				if (token === lifecycle) scheduleCell(cell);
			}, 120);
			retryTimers.set(key, timer);
		} catch {
			completedCells.add(key);
		}
	}, 0);
}

function clearCell(key: string): void {
	activeCells.delete(key);
	pendingCells.delete(key);
	completedCells.delete(key);
	retryCounts.delete(key);
	waitingCells.delete(key);
	const retryTimer = retryTimers.get(key);
	if (retryTimer) clearTimeout(retryTimer);
	retryTimers.delete(key);
	removeCellLabelHooks(key);
	teardownSurface(key, true);
}

function removeCellLabelHooks(key: string): void {
	for (const token of cellLabelHooks.get(key) ?? []) token.remove();
	cellLabelHooks.delete(key);
}

function refreshCell(cell: NativeObjectHandle): void {
	const key = cellKey(cell);
	if (!key || cellStates.has(key)) return;
	completedCells.delete(key);
	retryCounts.delete(key);
	waitingCells.delete(key);
	scheduleCell(cell);
}

function observeCellLabels(cell: NativeObjectHandle): void {
	if (!objc) return;
	const key = cellKey(cell);
	if (!key || cellLabelHooks.has(key)) return;
	const content = nativeCall(cell, 'contentView') as NativeObjectHandle | null;
	if (!content) return;
	const tokens: NativeHookToken[] = [];
	for (const label of textViewsInView(content)) {
		if (!(objc.className(label) ?? '').includes('DCDReusableYYLabel')) continue;
		try {
			tokens.push(
				objc.hook(
					'DCDReusableYYLabel',
					'setAttributedText:',
					{ after: () => refreshCell(cell) },
					{ instance: label },
				),
			);
		} catch {
			void 0;
		}
	}
	if (tokens.length > 0) cellLabelHooks.set(key, tokens);
}

function installNativeHooks(): void {
	if (!objc || hooks.length > 0) return;
	let initialScan: NativeHookToken | null = null;
	initialScan = objc.hook('DCDMessageTableViewCell', 'layoutSubviews', {
		after: ({ self }) => {
			const cells = visibleMessageCellsInCell(self);
			if (cells.length === 0) return;
			initialScan?.remove();
			for (const cell of cells) scheduleCell(cell);
		},
	});
	const visibility = objc.hook('DCDMessageTableViewCell', 'didMoveToWindow', {
		after: ({ self }) => {
			const key = cellKey(self);
			if (!key) return;
			if (!nativeCall(self, 'window')) {
				clearCell(key);
				return;
			}
			scheduleCell(self);
		},
	});
	const reuse = objc.hook('DCDMessageTableViewCell', 'prepareForReuse', {
		after: ({ self }) => {
			const key = cellKey(self);
			if (!key) return;
			clearCell(key);
			setTimeout(() => scheduleCell(self), 0);
		},
	});
	hooks = [initialScan, visibility, reuse];
}

function dependenciesReady(): boolean {
	return Boolean(
		messages?.getMessage && messageActions?.fetchMessage && messageRecord && rowManager && chatItem,
	);
}

function captureDependency(candidate: unknown): void {
	if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function')) return;
	const value = candidate as AnyRecord;
	if (
		!messages &&
		value._dispatcher &&
		typeof value.getName === 'function' &&
		value.getName() === 'MessageStore' &&
		typeof value.getMessage === 'function'
	) {
		messages = value as MessageStore;
	}
	if (!messageActions && typeof value.fetchMessage === 'function')
		messageActions = value as MessageActions;
	if (!messageRecord && typeof candidate === 'function' && value.name === 'MessageRecord') {
		messageRecord = candidate as MessageRecordConstructor;
	}
	if (!rowManager && typeof candidate === 'function' && value.name === 'RowManager') {
		rowManager = candidate as RowManagerConstructor;
	}
}

function activate(): void {
	if (!dependenciesReady() || !registerSurface()) return;
	clearModuleListener();
	installNativeHooks();
}

function captureLoadedModule(module: unknown, id: number | string): void {
	if (!module || (typeof module !== 'object' && typeof module !== 'function')) return;
	const exports = module as AnyRecord;
	const isChatItemModule =
		typeof exports.DCDMessageView === 'function' &&
		typeof exports.DCDSystemMessageView === 'function' &&
		typeof exports.DCDAutoModerationSystemMessageView === 'function';
	if (!chatItem && (modulePath(id) === CHAT_ITEM_PATH || isChatItemModule)) {
		chatItem = resolveChatItem(exports.default) ?? resolveChatItem(exports);
	}
	captureDependency(exports);
	captureDependency(exports.default);
	if (dependenciesReady()) activate();
}

function captureInitializedModules(): void {
	const window = (globalThis as AnyRecord).window as AnyRecord | undefined;
	const modules = window?.modules as Map<number, MetroModule> | undefined;
	if (!modules) return;
	for (const [id, module] of modules) {
		if (!module.isInitialized) continue;
		captureLoadedModule(module.publicModule?.exports, id);
		if (dependenciesReady()) break;
	}
}

function clearModuleListener(): void {
	moduleListenerCleanup?.();
	moduleListenerCleanup = null;
}

function initialize(): void {
	if (!moduleListenerCleanup) {
		moduleListenerCleanup = metro.addListener((module, id) => captureLoadedModule(module, id));
	}
	captureInitializedModules();
	if (!chatItem) {
		const module = metro.findByFilePath(CHAT_ITEM_PATH, { cacheOnly: true, interop: false });
		if (module) {
			chatItem = resolveChatItem((module as AnyRecord).default) ?? resolveChatItem(module);
		}
	}
	if (dependenciesReady()) activate();
}

function start(context?: PluginContext): void {
	lifecycle++;
	objc = context?.native.objc ?? null;
	fabric = context?.native.fabric ?? null;
	selectedChannel = metro.findByProps('getLastSelectedChannelId', 'getChannelId');
	channelStore = metro.findByProps('getChannel');
	initialize();
}

function stop(): void {
	lifecycle++;
	for (const token of hooks) token.remove();
	hooks = [];
	clearModuleListener();
	for (const key of [...cellLabelHooks.keys()]) removeCellLabelHooks(key);
	for (const key of [...cellStates.keys()]) teardownSurface(key, true);
	activeCells.clear();
	pendingCells.clear();
	completedCells.clear();
	retryCounts.clear();
	for (const timer of retryTimers.values()) clearTimeout(timer);
	retryTimers.clear();
	waitingCells.clear();
	cachedMessages.clear();
	pendingMessages.clear();
	messages = null;
	messageActions = null;
	channelStore = null;
	selectedChannel = null;
	messageRecord = null;
	rowManager = null;
	chatItem = null;
	objc = null;
	fabric = null;
	surfaceModuleName = '';
}

export default { start, stop };
