import { metro, patcher } from '@unbound-app/api';
import type { NativeObjCBridge, PluginContext } from '@unbound-app/api/native';

const MAX_EMBEDS = 3;
const MESSAGE_LINK_REGEX =
	/https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(?:\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})/g;
const MESSAGE_RENDERER_PATH = 'modules/messages/native/MessagesRenderer.tsx';
const MESSAGE_ROW_TYPE = 1;

type AnyRecord = Record<string, unknown>;

type Author = {
	id?: string;
	globalName?: string | null;
	username?: string;
};

type Message = {
	author?: Author;
	channel_id?: string;
	channelId?: string;
	content?: unknown;
	guild_id?: string | null;
	guildId?: string | null;
	id?: string;
	timestamp?: Date | string;
	type?: number;
	[key: string]: unknown;
};

type LinkTarget = {
	channelId: string;
	messageId: string;
};

type MessageActions = {
	fetchMessage?: (options: LinkTarget) => Promise<Message | null>;
};

type MessageStore = {
	getMessage?: (channelId: string, messageId: string) => Message | null;
};

type MessageRecordConstructor = new (message: AnyRecord) => Message;

type RowInput = {
	message: Message;
	rowType: number;
	[key: string]: unknown;
};

type Row = AnyRecord;

type RowGenerator = {
	generate: (input: RowInput) => Row;
};

type RowManagerConstructor = new () => RowGenerator;

type ChatItemProps = {
	message: Message;
	rowGenerator: RowGenerator;
};

type ChatItemComponent = (props: ChatItemProps) => unknown;

type NativeMessageViewProps = {
	row: Row;
};

type NativeMessageView = (props: NativeMessageViewProps) => unknown;

type RenderItemInfo = {
	item?: unknown;
	[key: string]: unknown;
};

type RenderItem = (info: RenderItemInfo) => unknown;

type ReactElementLike = {
	key?: string | null;
	props?: Record<string, unknown>;
	type?: unknown;
};

type AutoModerationNestedMessage = {
	avatarURL?: string | null;
	channelId?: string | null;
	colorString?: number | string;
	communicationDisabled?: boolean;
	content: string;
	guildId?: string | null;
	id: string;
	roleColor?: number | string;
	shouldShowRoleDot?: boolean;
	timestamp: string;
	userId?: string | null;
	username: string;
	usernameColor?: number | string;
};

type AutoModerationContext = {
	actionsIconURL: string;
	actionsText: string;
	feedbackText: string;
	headerBadgeText: string;
	headerText: string;
	keywordDisplayText: string;
	message: AutoModerationNestedMessage;
	notification: null;
	reasonDisplayText: null;
	ruleDisplayText: string;
};

type EmbeddedMessage = {
	generator: RowGenerator;
	message: Message;
	row: Row;
};

type SyntheticRow = {
	context: AutoModerationContext;
	message: Message;
};

let unpatchMessagesRenderer: (() => void) | null = null;
let unpatchRowManager: (() => void) | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let removeModuleListener: (() => boolean) | null = null;
let messages: MessageStore | null = null;
let messageActions: MessageActions | null = null;
let dispatcher: { dispatch?: (event: unknown) => void } | null = null;
let messageRecord: MessageRecordConstructor | null = null;
let rowManager: RowManagerConstructor | null = null;
let chatItem: ChatItemComponent | null = null;
let autoModerationView: NativeMessageView | null = null;
let native: NativeObjCBridge | null = null;

const cachedMessages = new Map<string, Message>();
const pendingMessages = new Set<string>();
const embeddedMessages = new Map<string, EmbeddedMessage>();
const syntheticRows = new Map<string, SyntheticRow>();
const wrappedRenderItems = new WeakMap<RenderItem, RenderItem>();

function messageKey(channelId: string, messageId: string): string {
	return `${channelId}:${messageId}`;
}

function embeddedMessageKey(source: Message, target: Message): string | undefined {
	if (!source.id || !target.id) return undefined;
	return `${source.id}:${messageKey(messageChannelId(target) ?? '', target.id)}`;
}

function messageChannelId(message: Message): string | undefined {
	return message.channel_id ?? message.channelId;
}

function contentText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(contentText).join('');
	if (!value || typeof value !== 'object') return '';

	const record = value as AnyRecord;
	const link = typeof record.originalLink === 'string' ? record.originalLink : '';
	return `${contentText(record.content)}${link}`;
}

function messageText(message: Message): string {
	return contentText(message.content);
}

function linkedTargets(message: Message): LinkTarget[] {
	const content = messageText(message);
	if (!content) return [];

	const targets: LinkTarget[] = [];
	for (const match of content.matchAll(MESSAGE_LINK_REGEX)) {
		if (targets.some((target) => target.channelId === match[1] && target.messageId === match[2]))
			continue;
		targets.push({ channelId: match[1], messageId: match[2] });
		if (targets.length >= MAX_EMBEDS) break;
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

function canonicalMessage(message: Message): Message {
	const channelId = messageChannelId(message);
	if (!message.id || !channelId) return message;
	return messages?.getMessage?.(channelId, message.id) ?? message;
}

function fetchLinkedMessage(source: Message, target: LinkTarget): void {
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

	request
		.then((result) => {
			const resolved =
				messages?.getMessage?.(target.channelId, target.messageId) ??
				result ??
				linkedMessage(target);
			if (resolved) cachedMessages.set(key, resolved);
		})
		.catch(() => undefined)
		.finally(() => {
			pendingMessages.delete(key);
			if (source.id)
				dispatcher?.dispatch?.({ type: 'MESSAGE_UPDATE', message: { ...source }, log_edit: false });
		});
}

function rememberSource(message: Message): void {
	const source = canonicalMessage(message);
	for (const target of linkedTargets(source)) {
		if (!linkedMessage(target)) fetchLinkedMessage(source, target);
	}
}

function timestampText(timestamp: unknown): string {
	if (timestamp instanceof Date) return timestamp.toLocaleString();
	return typeof timestamp === 'string' ? timestamp : '';
}

function autoModerationNestedMessage(
	target: Message,
	targetRowMessage: AnyRecord,
): AutoModerationNestedMessage {
	const author = target.author ?? {};
	return {
		id: String(targetRowMessage.id ?? target.id ?? ''),
		channelId: String(targetRowMessage.channelId ?? messageChannelId(target) ?? ''),
		guildId: (targetRowMessage.guildId ?? target.guild_id ?? target.guildId ?? null) as
			| string
			| null,
		userId: (targetRowMessage.authorId ?? author.id ?? null) as string | null,
		username: String(
			targetRowMessage.username ?? author.globalName ?? author.username ?? 'Unknown User',
		),
		usernameColor: targetRowMessage.usernameColor ?? 4294967295,
		roleColor: targetRowMessage.roleColor ?? 4294967295,
		shouldShowRoleDot: Boolean(targetRowMessage.shouldShowRoleDot),
		colorString: targetRowMessage.colorString ?? 4294967295,
		avatarURL: (targetRowMessage.avatarURL ?? null) as string | null,
		content: messageText(target),
		communicationDisabled: false,
		timestamp: timestampText(targetRowMessage.timestamp ?? target.timestamp),
	};
}

function autoModerationContext(
	target: Message,
	targetRowMessage: AnyRecord,
): AutoModerationContext {
	return {
		headerText: '',
		headerBadgeText: '',
		keywordDisplayText: '',
		message: autoModerationNestedMessage(target, targetRowMessage),
		notification: null,
		ruleDisplayText: '',
		reasonDisplayText: null,
		actionsIconURL: '',
		actionsText: '',
		feedbackText: '',
	};
}

function syntheticMessageId(source: Message, target: Message): string {
	const input = `${source.id ?? ''}:${target.id ?? ''}`;
	let high = 0;
	let low = 0;
	for (const character of input) {
		high = (high * 31 + character.charCodeAt(0)) % 1000000000;
		low = (low * 131 + character.charCodeAt(0)) % 1000000000;
	}
	return `9${String(high).padStart(9, '0')}${String(low).padStart(9, '0')}`;
}

function syntheticRow(source: Message, target: Message): SyntheticRow | null {
	if (!messageRecord || !rowManager) return null;

	const sourceChannelId = messageChannelId(source);
	const targetChannelId = messageChannelId(target) ?? sourceChannelId;
	if (!sourceChannelId || !targetChannelId || !source.id || !target.id) return null;

	const id = syntheticMessageId(source, target);
	const existing = syntheticRows.get(id);
	if (existing) return existing;

	try {
		const targetRecord =
			target instanceof messageRecord
				? target
				: new messageRecord({ ...target, channel_id: targetChannelId });
		const generator = new rowManager();
		const targetRow = generator.generate({ rowType: MESSAGE_ROW_TYPE, message: targetRecord });
		const message = new messageRecord({
			...source,
			id,
			type: 0,
			channel_id: sourceChannelId,
			content: '',
			embeds: [],
			attachments: [],
			components: [],
			messageReference: null,
			messageSnapshots: [],
		});
		const result = {
			message,
			context: autoModerationContext(target, targetRow.message as AnyRecord),
		};
		syntheticRows.set(id, result);
		return result;
	} catch {
		return null;
	}
}

function injectSyntheticRows(array: unknown[]): void {
	const rows: unknown[] = [];
	const active = new Set<string>();
	let changed = false;

	for (const value of array) {
		const message = value as Message;
		if (typeof message?.id === 'string' && syntheticRows.has(message.id)) {
			changed = true;
			continue;
		}

		rows.push(value);
		const source = canonicalMessage(message);
		if (!source.id) continue;

		for (const target of linkedTargets(source)) {
			const linked = linkedMessage(target);
			if (!linked || linked.id === source.id) {
				if (!linked) fetchLinkedMessage(source, target);
				continue;
			}

			const synthetic = syntheticRow(source, linked);
			if (!synthetic) continue;
			active.add(synthetic.message.id ?? '');
			rows.push(synthetic.message);
			changed = true;
		}
	}

	for (const id of syntheticRows.keys()) {
		if (!active.has(id)) syntheticRows.delete(id);
	}

	if (changed) array.splice(0, array.length, ...rows);
}

function embeddedMessage(source: Message, target: Message): EmbeddedMessage | null {
	if (!messageRecord || !rowManager) return null;

	const sourceChannelId = messageChannelId(source);
	const targetChannelId = messageChannelId(target) ?? sourceChannelId;
	if (!sourceChannelId || !target.id || !targetChannelId) return null;

	const key = embeddedMessageKey(source, target);
	if (!key) return null;
	const cached = embeddedMessages.get(key);
	if (cached) return cached;

	try {
		const targetRecord =
			target instanceof messageRecord
				? target
				: new messageRecord({ ...target, channel_id: targetChannelId });
		const generator = new rowManager();
		const targetRow = generator.generate({ rowType: MESSAGE_ROW_TYPE, message: targetRecord });
		const targetRowMessage = targetRow.message as AnyRecord;
		const renderRecord = new messageRecord({
			...target,
			id: target.id,
			type: 24,
			channel_id: sourceChannelId,
			content: '',
			embeds: [],
			attachments: [],
			components: [],
			messageReference: null,
			messageSnapshots: [],
		});
		const row = generator.generate({ rowType: MESSAGE_ROW_TYPE, message: renderRecord });
		row.message = {
			...((row.message ?? targetRowMessage) as AnyRecord),
			id: target.id,
			channelId: sourceChannelId,
			type: 24,
			autoModerationContext: autoModerationContext(target, targetRowMessage),
		};
		const result = { generator, message: renderRecord, row };
		embeddedMessages.set(key, result);
		return result;
	} catch {
		return null;
	}
}

function renderEmbeddedMessage(embedded: EmbeddedMessage): unknown {
	if (autoModerationView)
		return metro.common.React.createElement(autoModerationView, { row: embedded.row });
	if (chatItem)
		return metro.common.React.createElement(chatItem, {
			message: embedded.message,
			rowGenerator: embedded.generator,
		});
	return null;
}

function messageFromValue(value: unknown, depth = 0): Message | undefined {
	if (!value || typeof value !== 'object' || depth > 3) return undefined;

	const record = value as AnyRecord;
	if (typeof record.id === 'string' && ('content' in record || 'author' in record))
		return record as Message;

	for (const key of ['message', 'item', 'itemRow', 'rawRow', 'row']) {
		const result = messageFromValue(record[key], depth + 1);
		if (result) return result;
	}

	return undefined;
}

function modulePath(id: string): string | undefined {
	type RuntimeGlobal = typeof globalThis & {
		window?: {
			modules?: { get: (moduleId: string) => { __filePath?: string } | undefined };
		};
	};

	return (globalThis as RuntimeGlobal).window?.modules?.get(id)?.__filePath;
}

function unwrapComponent(mod: unknown): { holder: Record<string, unknown>; prop: string } | null {
	const moduleRecord = mod && typeof mod === 'object' ? (mod as AnyRecord) : null;
	let holder = moduleRecord ?? {};
	let prop = 'default';
	let current = moduleRecord?.default;
	let depth = 0;

	while (current && typeof current === 'object' && depth < 5) {
		const currentRecord = current as AnyRecord;
		const next =
			currentRecord.type !== undefined
				? 'type'
				: currentRecord.render !== undefined
					? 'render'
					: null;
		if (!next) break;

		holder = currentRecord;
		prop = next;
		current = currentRecord[next];
		depth++;
	}

	return typeof current === 'function' ? { holder, prop } : null;
}

function isReactElement(value: unknown): value is ReactElementLike {
	return Boolean(value && typeof value === 'object' && 'props' in value && 'type' in value);
}

function isListElement(element: ReactElementLike): boolean {
	const props = element.props;
	if (!props) return false;
	if (
		typeof props.renderItem !== 'function' &&
		typeof props.ListItemComponent !== 'function' &&
		typeof props.listItemComponent !== 'function'
	)
		return false;
	if (Array.isArray(props.data)) return true;
	if (typeof props.getItem === 'function' || typeof props.getItemCount === 'function') return true;

	const type = element.type as { displayName?: string; name?: string } | undefined;
	const name = `${type?.displayName ?? ''} ${type?.name ?? ''}`.toLowerCase();
	return name.includes('list');
}

function renderEmbeddedItem(info: RenderItemInfo, rendered: unknown): unknown {
	const source = messageFromValue(info.item) ?? messageFromValue(info);
	if (!source) return rendered;

	rememberSource(source);
	const target = linkedTargets(source)
		.map((candidate) => linkedMessage(candidate))
		.find((candidate) => candidate && candidate.id !== source.id);
	if (!target) return rendered;

	const embedded = embeddedMessage(source, target);
	if (!embedded) return rendered;

	const { React, ReactNative } = metro.common;
	const body = renderEmbeddedMessage(embedded);
	if (!body) return rendered;

	return React.createElement(
		ReactNative.View,
		{
			style: {
				marginLeft: 48,
				marginRight: 12,
				marginTop: 4,
				marginBottom: 4,
				borderRadius: 8,
				overflow: 'hidden',
				backgroundColor: 'rgba(4, 4, 5, 0.24)',
			},
		},
		rendered,
		body,
	);
}

function wrapRenderItem(renderItem: RenderItem): RenderItem {
	const cached = wrappedRenderItems.get(renderItem);
	if (cached) return cached;

	const wrapped = (info: RenderItemInfo) => renderEmbeddedItem(info, renderItem(info));
	wrappedRenderItems.set(renderItem, wrapped);
	return wrapped;
}

function enhanceElement(element: unknown, depth = 0): unknown {
	if (!isReactElement(element) || depth > 8) return element;

	const { React } = metro.common;
	let next = element;
	const props = element.props ?? {};
	if (isListElement(element)) {
		next = React.cloneElement(next, {
			renderItem:
				typeof props.renderItem === 'function'
					? wrapRenderItem(props.renderItem as RenderItem)
					: props.renderItem,
			ListItemComponent:
				typeof props.ListItemComponent === 'function'
					? wrapRenderItem(props.ListItemComponent as RenderItem)
					: props.ListItemComponent,
			listItemComponent:
				typeof props.listItemComponent === 'function'
					? wrapRenderItem(props.listItemComponent as RenderItem)
					: props.listItemComponent,
		});
	}

	const children = props.children;
	if (children === undefined || children === null) return next;

	const childList = React.Children.toArray(children);
	let changed = false;
	const enhancedChildren = childList.map((child: unknown) => {
		const enhanced = enhanceElement(child, depth + 1);
		changed ||= enhanced !== child;
		return enhanced;
	});
	if (!changed) return next;

	return React.cloneElement(next, null, ...enhancedChildren);
}

function patchRowManager(): void {
	if (unpatchRowManager || !rowManager) return;

	const prototype = (rowManager as unknown as { prototype?: Record<string, unknown> }).prototype;
	if (!prototype || typeof prototype.generate !== 'function') return;

	unpatchRowManager = patcher.after(prototype, 'generate', (context) => {
		const input = context.args?.[0] as RowInput | undefined;
		const id = input?.message?.id;
		const synthetic = typeof id === 'string' ? syntheticRows.get(id) : undefined;
		if (!synthetic || !context.result) return context.result;

		const row = context.result as Row;
		row.message = {
			...((row.message ?? {}) as AnyRecord),
			id: synthetic.message.id,
			channelId: messageChannelId(synthetic.message),
			type: 24,
			autoModerationContext: synthetic.context,
		};
		return row;
	});
}

function patchMessagesRenderer(mod: unknown): boolean {
	if (unpatchMessagesRenderer) return true;

	const target = unwrapComponent(mod);
	if (!target) return false;

	const unpatchBefore = patcher.before(target.holder, target.prop, (context) => {
		const props = context.args?.[0] as AnyRecord | undefined;
		const messageList = props?.messages as AnyRecord | undefined;
		if (Array.isArray(messageList?._array)) injectSyntheticRows(messageList._array);
	});
	const unpatchAfter = patcher.after(target.holder, target.prop, (context) => {
		try {
			return enhanceElement(context.result);
		} catch {
			return context.result;
		}
	});
	unpatchMessagesRenderer = () => {
		unpatchBefore();
		unpatchAfter();
	};

	return true;
}

function install(context?: PluginContext): void {
	native = context?.native?.objc ?? null;
	if (native) {
		try {
			native.getClass('DCDAutoModerationSystemMessageView');
		} catch {
			native = null;
		}
	}

	const foundMessages = metro.findStore('MessageStore', { short: false });
	const foundActions = metro.findByProps('sendMessage', 'fetchMessage');
	const foundDispatcher = metro.findByProps('dispatch', 'subscribe');
	const MessageRecord = metro.findByName('MessageRecord');
	const RowManager = metro.findByName('RowManager');
	const ChatModule = metro.findByFilePath('components_native/chat/ChatItem.tsx', {
		interop: false,
	});
	const MessagesRenderer = metro.findByFilePath(MESSAGE_RENDERER_PATH, { interop: false });

	if (
		!foundMessages?.getMessage ||
		!foundActions?.fetchMessage ||
		!foundDispatcher?.dispatch ||
		typeof MessageRecord !== 'function' ||
		typeof RowManager !== 'function' ||
		(typeof ChatModule?.default !== 'function' &&
			typeof ChatModule?.DCDAutoModerationSystemMessageView !== 'function')
	) {
		startupTimer = setTimeout(() => install(context), 250);
		return;
	}

	messages = foundMessages as MessageStore;
	messageActions = foundActions as MessageActions;
	dispatcher = foundDispatcher as { dispatch?: (event: unknown) => void };
	messageRecord = MessageRecord as MessageRecordConstructor;
	rowManager = RowManager as RowManagerConstructor;
	patchRowManager();
	chatItem =
		typeof ChatModule?.default === 'function' ? (ChatModule.default as ChatItemComponent) : null;
	autoModerationView =
		typeof ChatModule?.DCDAutoModerationSystemMessageView === 'function'
			? (ChatModule.DCDAutoModerationSystemMessageView as NativeMessageView)
			: null;

	if (patchMessagesRenderer(MessagesRenderer)) return;

	removeModuleListener = metro.addListener((module, id) => {
		if (modulePath(id) !== MESSAGE_RENDERER_PATH || !patchMessagesRenderer(module)) return;
		removeModuleListener?.();
		removeModuleListener = null;
	});
}

export default {
	start(context?: PluginContext) {
		install(context);
	},
	stop() {
		if (startupTimer) clearTimeout(startupTimer);
		startupTimer = null;
		removeModuleListener?.();
		removeModuleListener = null;
		unpatchMessagesRenderer?.();
		unpatchMessagesRenderer = null;
		messages = null;
		messageActions = null;
		dispatcher = null;
		messageRecord = null;
		rowManager = null;
		chatItem = null;
		autoModerationView = null;
		native = null;
		cachedMessages.clear();
		pendingMessages.clear();
		embeddedMessages.clear();
		syntheticRows.clear();
	},
};
