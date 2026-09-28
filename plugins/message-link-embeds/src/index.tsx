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
import { enableAnimatedEmojiSources } from '@message-link-embeds/animated-emoji';
import {
	contentText,
	findRenderedLinkRange,
	type LinkTarget,
	linkedTargets,
	nativeUsernameColor,
} from '@message-link-embeds/link-targets';
import { reactionSnapshot, stripMessageReactions } from '@message-link-embeds/reaction-state';
import {
	BottomAnchorTracker,
	readSurfaceAnchor,
	SurfaceHeightCache,
	type SurfaceLayoutMetrics,
	shouldRefreshSurfaceRow,
	surfaceHeightCacheKey,
} from '@message-link-embeds/surface-layout';

const CHAT_ITEM_PATH = 'components_native/chat/ChatItem.tsx';
const SURFACE_MODULE_PREFIX = 'MessageLinkEmbedSurface';
const MIN_SURFACE_HEIGHT = 72;
const INITIAL_SURFACE_HEIGHT = MIN_SURFACE_HEIGHT;
const MAX_SURFACE_HEIGHT = 520;
const SURFACE_LAYOUT_SETTLE_DELAY = 80;
const SURFACE_BOTTOM_TRIM = 5;
const SURFACE_SPACER_FONT_SIZE = 8;
const EMBED_BACKGROUND = '#2b2d31';
const MAX_NATIVE_VIEW_DEPTH = 10;

type AnyRecord = Record<string, unknown>;
type NativeInvoker = (handle: NativeObjectHandle, selector: string, ...args: unknown[]) => unknown;
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
	addChangeListener?: (listener: () => void) => void;
	getMessage?: (channelId: string, messageId: string) => Message | null;
	getLastMessage?: (channelId: string) => Message | null;
	removeChangeListener?: (listener: () => void) => void;
};
type MessageActions = {
	fetchMessage?: (target: LinkTarget) => Promise<Message | null>;
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
	setOptions?: (options: AnyRecord) => void;
};
type RowManagerConstructor = (...args: never[]) => unknown;
type ChatItemProps = {
	message: Message;
	renderRevision: number;
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
	baseGenerator: RowGenerator;
	font: NativeObjectHandle | null;
	generator: RowGenerator;
	host: NativeObjectHandle;
	label: NativeObjectHandle;
	labelHook: NativeHookToken | null;
	messageId: string;
	sourceReactionSnapshot: string;
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
	heightCacheKey: string;
	lastInvalidatedHeight: number;
	applying: boolean;
	layoutTimer: ReturnType<typeof setTimeout> | null;
	reactionLayoutTimer: ReturnType<typeof setTimeout> | null;
	bottomScrollTimer: ReturnType<typeof setTimeout> | null;
	pendingHeight: number | null;
	renderRevision: number;
	bottomAnchor: BottomAnchorTracker;
};
type SurfaceProps = {
	surfaceId: string;
	renderRevision: number;
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
let messageStoreListener: (() => void) | null = null;
let messageSyncTimer: ReturnType<typeof setTimeout> | null = null;
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
const surfaceHeights = new SurfaceHeightCache();
const cellLabelHooks = new Map<string, NativeHookToken[]>();
const surfaceRebindTimers = new Map<string, ReturnType<typeof setTimeout>>();

function nativeCall(handle: NativeObjectHandle, selector: string, ...args: unknown[]): unknown {
	if (!objc) return null;
	try {
		return objc.invoke(handle, selector, args, { thread: 'main' });
	} catch {
		return null;
	}
}

function syncMessageReactions(): void {
	messageSyncTimer = null;
	if (!messages || !fabric) return;

	for (const state of cellStates.values()) {
		const source = messages.getMessage?.(state.selectedTarget.channelId, state.messageId);
		const sourceReactionSnapshot = source
			? reactionSnapshot(source.reactions)
			: state.sourceReactionSnapshot;
		const sourceChanged = sourceReactionSnapshot !== state.sourceReactionSnapshot;
		if (!sourceChanged) {
			reconcileSurfaceText(state);
			continue;
		}
		const table = tableForCell(state.cell);
		if (table) captureSurfaceBottomAnchor(state, table);
		reconcileSurfaceText(state);
		if (cellStates.get(state.cellKey) !== state) continue;

		state.sourceReactionSnapshot = sourceReactionSnapshot;
		scheduleReactionScrollCorrection(state, SURFACE_LAYOUT_SETTLE_DELAY);
	}
}

function reconcileSurfaceText(state: EmbeddedSurfaceState): void {
	if (!messages || !objc) return;
	const attributedText = currentAttributedText(state.label);
	const text = attributedText ? textForView(state.label) : undefined;
	if (!attributedText || text === undefined || text === state.renderedText) return;
	const range = findRenderedLinkRange(text, state.channelName);
	if (range) updateExistingSurface(state, attributedText, range);
}

function scheduleMessageSync(): void {
	if (messageSyncTimer) return;
	const token = lifecycle;
	messageSyncTimer = setTimeout(() => {
		messageSyncTimer = null;
		if (token === lifecycle) syncMessageReactions();
	}, 0);
}

function handleMessageStoreChange(): void {
	if (messages) {
		for (const state of cellStates.values()) {
			const source = messages.getMessage?.(state.selectedTarget.channelId, state.messageId);
			const sourceChanged =
				source && reactionSnapshot(source.reactions) !== state.sourceReactionSnapshot;
			if (!sourceChanged) continue;
			const table = tableForCell(state.cell);
			if (table) captureSurfaceBottomAnchor(state, table);
		}
	}
	scheduleMessageSync();
}

function installMessageStoreListener(): void {
	if (messageStoreListener || !messages?.addChangeListener) return;
	messageStoreListener = handleMessageStoreChange;
	messages.addChangeListener(messageStoreListener);
}

function removeMessageStoreListener(): void {
	if (messageStoreListener) messages?.removeChangeListener?.(messageStoreListener);
	messageStoreListener = null;
	if (messageSyncTimer) clearTimeout(messageSyncTimer);
	messageSyncTimer = null;
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

function linkFont(
	attributedText: NativeObjectHandle,
	range: { location: number; length: number },
	invoke: NativeInvoker = nativeCall,
): NativeObjectHandle | null {
	if (!objc) return null;
	const text = stringFromNative(invoke(attributedText, 'string')) ?? '';
	const end = range.location + range.length;
	for (let index = range.location; index < end; index++) {
		if (text[index] !== '\uFFFC') continue;
		const values = invoke(attributedText, 'attributesAtIndex:effectiveRange:', index, null);
		if (!values || typeof values !== 'object') continue;
		const attributes = values as AnyRecord;
		if (!attributes.YYTextAttachment) continue;
		return (attributes.NSFont as NativeObjectHandle | undefined) ?? null;
	}
	return null;
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

function buildSurfaceRecord(target: Message, channelId: string): Message {
	const record = buildRecord(target, channelId);
	stripMessageReactions(record);
	record.animateEmoji = true;
	const usernameColor = nativeUsernameColor(record.colorString);
	if (usernameColor !== undefined) record.usernameColor = usernameColor;
	return record;
}

function createRowGeneratorProxy(generator: RowGenerator): RowGenerator {
	return new Proxy(generator, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

function buildEmbeddedContent(target: Message, channelId: string): EmbeddedContent | undefined {
	if (!messageRecord || !rowManager) return;
	try {
		const record = buildSurfaceRecord(target, channelId);
		const usernameColor = nativeUsernameColor(record.colorString);
		const generator = Reflect.construct(rowManager, []) as RowGenerator;
		generator.setOptions?.({
			animateEmoji: true,
			animatingStickerMessageId: record.id,
			gifAutoPlay: true,
		});
		const generate = generator.generate.bind(generator);
		generator.generate = (input) => {
			const row = generate(input);
			const renderedMessage = row?.message as AnyRecord | undefined;
			if (renderedMessage) {
				renderedMessage.type = 0;
				renderedMessage.renderContentOnly = false;
				renderedMessage.animateEmoji = true;
				renderedMessage.gifAutoPlay = true;
				enableAnimatedEmojiSources(renderedMessage.content);
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

function attributedSurfaceInsertion(
	state: EmbeddedSurfaceState,
	invoke: NativeInvoker = nativeCall,
): NativeObjectHandle | null {
	if (!objc) return null;
	const attachmentClass = objc.getClass('YYTextAttachment');
	if (!attachmentClass) return null;
	const attachment = objc.alloc(attachmentClass);
	invoke(attachment, 'setValue:forKey:', state.host, 'content');
	invoke(attachment, 'setValue:forKey:', 1, 'contentMode');
	const sourceText = stringFromNative(invoke(state.original, 'string')) ?? '';
	const insertionLocation = state.range.location + state.range.length;
	const trailingText = sourceText.slice(insertionLocation);
	const leadingNewline = sourceText[insertionLocation - 1] === '\n' ? '' : '\n';
	const trailingNewline = trailingText.trim().length > 0 ? '\n' : '';
	const spacerText = '\u200B\n';
	const spacerLocation = leadingNewline.length;
	const attachmentLocation = spacerLocation + spacerText.length;
	const insertionText = `${leadingNewline}${spacerText}\uFFFC${trailingNewline}`;
	const attributes: AnyRecord = state.font ? { NSFont: state.font } : {};
	const insertion = objc.alloc('NSMutableAttributedString');
	invoke(insertion, 'initWithString:attributes:', insertionText, attributes);
	const spacerFont = state.font
		? (invoke(state.font, 'fontWithSize:', SURFACE_SPACER_FONT_SIZE) as NativeObjectHandle | null)
		: null;
	if (spacerFont) {
		invoke(
			insertion,
			'addAttribute:value:range:',
			'NSFont',
			spacerFont,
			nativeRange(spacerLocation, spacerText.length),
		);
	}
	invoke(
		insertion,
		'addAttribute:value:range:',
		'YYTextAttachment',
		attachment,
		nativeRange(attachmentLocation, 1),
	);
	const delegateClass = objc.getClass('YYTextRunDelegate');
	if (delegateClass) {
		const delegate = objc.alloc(delegateClass);
		invoke(delegate, 'setValue:forKey:', state.height, 'ascent');
		invoke(delegate, 'setValue:forKey:', 0, 'descent');
		invoke(delegate, 'setValue:forKey:', state.width, 'width');
		const coreDelegate = invoke(delegate, 'CTRunDelegate');
		if (coreDelegate) {
			invoke(
				insertion,
				'addAttribute:value:range:',
				'CTRunDelegate',
				coreDelegate,
				nativeRange(attachmentLocation, 1),
			);
		}
	}
	return insertion;
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

function tableLayoutMetrics(table: NativeObjectHandle): SurfaceLayoutMetrics {
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
	const x = Number(contentOffset.x);
	return {
		bottomInset,
		contentHeight,
		inverted: Number(transform.d) < 0,
		offsetX: x,
		offsetY,
		topInset,
		viewportHeight,
	};
}

function captureSurfaceBottomAnchor(state: EmbeddedSurfaceState, table: NativeObjectHandle): void {
	const latestMessage = messages?.getLastMessage?.(state.selectedTarget.channelId);
	const anchor = readSurfaceAnchor(
		tableLayoutMetrics(table),
		latestMessage?.id === state.messageId,
	);
	state.bottomAnchor.capture(anchor);
}

function tableIsScrolling(table: NativeObjectHandle): boolean {
	return Boolean(
		nativeCall(table, 'isTracking') ||
			nativeCall(table, 'isDragging') ||
			nativeCall(table, 'isDecelerating'),
	);
}

function scheduleBottomScrollCorrection(
	state: EmbeddedSurfaceState,
	table: NativeObjectHandle,
): void {
	if (!state.bottomAnchor.pending) return;
	if (state.bottomScrollTimer) return;
	let attempts = 0;
	const correct = () => {
		state.bottomScrollTimer = null;
		if (cellStates.get(state.cellKey) !== state || !objc) {
			state.bottomAnchor.clear();
			return;
		}
		nativeCall(state.label, 'layoutIfNeeded');
		nativeCall(state.cell, 'layoutIfNeeded');
		nativeCall(table, 'layoutIfNeeded');
		const metrics = tableLayoutMetrics(table);
		const userIsScrolling = tableIsScrolling(table);
		const correction = state.bottomAnchor.correction(metrics, userIsScrolling);
		if (correction) {
			nativeCall(
				table,
				'setContentOffset:animated:',
				objc.struct('CGPoint', { x: correction.x, y: correction.y }),
				false,
			);
			return;
		}
		if (state.bottomAnchor.pending && attempts < 12) {
			attempts++;
			state.bottomScrollTimer = setTimeout(correct, 16);
			return;
		}
		state.bottomAnchor.clear();
	};
	state.bottomScrollTimer = setTimeout(correct, 16);
}

function scheduleReactionScrollCorrection(state: EmbeddedSurfaceState, delay: number): void {
	if (state.reactionLayoutTimer) clearTimeout(state.reactionLayoutTimer);
	state.reactionLayoutTimer = setTimeout(() => {
		state.reactionLayoutTimer = null;
		if (cellStates.get(state.cellKey) !== state) return;
		const table = tableForCell(state.cell);
		if (table) scheduleBottomScrollCorrection(state, table);
	}, delay);
}

function refreshRowSize(state: EmbeddedSurfaceState, force: boolean = false): void {
	if (!objc || !shouldRefreshSurfaceRow(force, state.lastInvalidatedHeight, state.height)) return;
	state.lastInvalidatedHeight = state.height;
	nativeCall(state.label, 'invalidateIntrinsicContentSize');
	nativeCall(state.label, 'setNeedsLayout');
	nativeCall(state.cell, 'setNeedsUpdateConstraints');
	nativeCall(state.cell, 'setNeedsLayout');
	const table = tableForCell(state.cell);
	if (!table) {
		state.bottomAnchor.clear();
		return;
	}
	captureSurfaceBottomAnchor(state, table);
	nativeCall(table, 'beginUpdates');
	nativeCall(table, 'endUpdates');
	scheduleBottomScrollCorrection(state, table);
}

function applyAttachment(state: EmbeddedSurfaceState, forceRefresh: boolean = false): boolean {
	if (!objc) return false;
	if (state.applying) return false;
	state.applying = true;
	try {
		const attachment = attributedSurfaceInsertion(state);
		if (!attachment) return false;
		const updated = nativeCall(state.original, 'mutableCopy') as NativeObjectHandle | null;
		if (!updated) return false;
		nativeCall(
			updated,
			'insertAttributedString:atIndex:',
			attachment,
			state.range.location + state.range.length,
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

function clearSurfaceTimers(state: EmbeddedSurfaceState): void {
	if (state.layoutTimer) clearTimeout(state.layoutTimer);
	if (state.reactionLayoutTimer) clearTimeout(state.reactionLayoutTimer);
	if (state.bottomScrollTimer) clearTimeout(state.bottomScrollTimer);
	state.layoutTimer = null;
	state.reactionLayoutTimer = null;
	state.bottomScrollTimer = null;
	state.pendingHeight = null;
	state.bottomAnchor.clear();
}

function reportSurfaceLayout(surfaceId: string, height: number): void {
	const state = surfaces.get(surfaceId);
	if (!state || !Number.isFinite(height) || height <= 0 || height > MAX_SURFACE_HEIGHT) return;
	const fittedHeight = Math.max(MIN_SURFACE_HEIGHT, height - SURFACE_BOTTOM_TRIM);
	const currentHeight = state.pendingHeight ?? state.height;
	if (Math.abs(currentHeight - fittedHeight) < 2) return;
	state.pendingHeight = fittedHeight;
	if (state.layoutTimer) clearTimeout(state.layoutTimer);
	state.layoutTimer = setTimeout(() => {
		state.layoutTimer = null;
		const settledHeight = state.pendingHeight;
		state.pendingHeight = null;
		if (
			settledHeight === null ||
			surfaces.get(state.surfaceId) !== state ||
			Math.abs(state.height - settledHeight) < 2
		)
			return;
		const table = tableForCell(state.cell);
		if (table) captureSurfaceBottomAnchor(state, table);
		state.height = settledHeight;
		surfaceHeights.set(state.heightCacheKey, settledHeight);
		if (state.reactionLayoutTimer) clearTimeout(state.reactionLayoutTimer);
		state.reactionLayoutTimer = null;
		nativeCall(state.host, 'setFrame:', nativeFrame(state.width, settledHeight));
		applyAttachment(state, true);
	}, SURFACE_LAYOUT_SETTLE_DELAY);
}

function MessageSurface({ renderRevision, surfaceId }: SurfaceProps): ReactNode {
	const state = surfaces.get(surfaceId);
	const { React, ReactNative } = metro.common;
	if (!state || !chatItem) return React.createElement(ReactNative.View, { style: { height: 1 } });
	const embeddedMessage = React.createElement(chatItem, {
		key: surfaceId,
		message: state.record,
		renderRevision,
		rowGenerator: state.generator,
	});
	const onLayout = (event: AnyRecord) => {
		const height = Number(event?.nativeEvent?.layout?.height);
		if (height > 0) reportSurfaceLayout(surfaceId, height);
	};
	return React.createElement(
		ReactNative.View,
		{
			onLayout,
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
		embeddedMessage,
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
	source: Message,
	content: EmbeddedContent,
): EmbeddedSurfaceState | null {
	if (!objc || !fabric) return null;
	const width = availableMessageWidth(cell, label);
	if (!Number.isFinite(width) || width < 80) return null;
	const font = linkFont(attributedText, range);
	const heightCacheKey = surfaceHeightCacheKey(target.channelId, target.messageId, width);
	const initialHeight = surfaceHeights.get(heightCacheKey, INITIAL_SURFACE_HEIGHT);
	const host = createHost(width, initialHeight);
	if (!host) return null;
	const bottomAnchor = new BottomAnchorTracker();
	const surfaceId = `message-link-${key}-${info.messageId}-${target.messageId}`;
	const state: EmbeddedSurfaceState = {
		cell,
		cellKey: key,
		channelName,
		baseGenerator: content.generator,
		font,
		generator: content.generator,
		host,
		label,
		labelHook: null,
		messageId: info.messageId,
		sourceReactionSnapshot: reactionSnapshot(source.reactions),
		original: attributedText,
		range,
		record: content.record,
		rendered: null,
		renderedText: null,
		selectedTarget: target,
		surface: null,
		surfaceId,
		width,
		height: initialHeight,
		heightCacheKey,
		lastInvalidatedHeight: -1,
		applying: false,
		layoutTimer: null,
		reactionLayoutTimer: null,
		bottomScrollTimer: null,
		pendingHeight: null,
		renderRevision: 0,
		bottomAnchor,
	};
	const table = tableForCell(cell);
	if (table) captureSurfaceBottomAnchor(state, table);
	surfaces.set(surfaceId, state);
	try {
		state.labelHook = objc.hook(
			'DCDReusableYYLabel',
			'setAttributedText:',
			{
				after: () => {
					if (state.applying) return;
					setTimeout(() => reconcileSurfaceText(state), 0);
				},
			},
			{ instance: label },
		);
		state.surface = fabric.mount(host, surfaceModuleName, {
			renderRevision: state.renderRevision,
			surfaceId,
		});
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
		clearSurfaceTimers(state);
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
	clearSurfaceTimers(state);
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
	const rebindTimer = surfaceRebindTimers.get(key);
	if (rebindTimer) clearTimeout(rebindTimer);
	surfaceRebindTimers.delete(key);
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
	forceRefresh: boolean = true,
): void {
	state.original = attributedText;
	state.range = range;
	state.font = linkFont(attributedText, range);
	applyAttachment(state, forceRefresh);
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
			source,
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
	const rebindTimer = surfaceRebindTimers.get(key);
	if (rebindTimer) clearTimeout(rebindTimer);
	surfaceRebindTimers.delete(key);
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

function queueSurfaceRebind(cell: NativeObjectHandle, state: EmbeddedSurfaceState): void {
	const key = state.cellKey;
	if (surfaceRebindTimers.has(key)) return;
	const timer = setTimeout(() => {
		surfaceRebindTimers.delete(key);
		if (cellStates.get(key) !== state || !objc) return;
		if (nativeCall(state.label, 'isDescendantOfView:', cell)) return;
		teardownSurface(key, false);
		completedCells.delete(key);
		scheduleCell(cell);
	}, 0);
	surfaceRebindTimers.set(key, timer);
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
	let initialScan: NativeHookToken;
	initialScan = objc.hook('DCDMessageTableViewCell', 'layoutSubviews', {
		after: ({ self }) => {
			const cells = visibleMessageCellsInCell(self);
			if (cells.length === 0) return;
			initialScan.remove();
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
	installMessageStoreListener();
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
	removeMessageStoreListener();
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
	for (const timer of surfaceRebindTimers.values()) clearTimeout(timer);
	surfaceRebindTimers.clear();
	waitingCells.clear();
	cachedMessages.clear();
	pendingMessages.clear();
	surfaceHeights.clear();
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
