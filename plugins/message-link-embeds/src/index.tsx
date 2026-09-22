import { metro, patcher } from '@unbound-app/api';

const MAX_EMBEDS = 3;
const MESSAGE_LINK_REGEX =
	/https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(?:\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})/g;
const MESSAGE_RENDERER_PATH = 'modules/messages/native/MessagesRenderer.tsx';
const MESSAGE_ROW_TYPE = 1;

type Author = {
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

type MessageRecordConstructor = new (message: Record<string, unknown>) => Message;

type RowGenerator = {
	generate: (input: Record<string, unknown>) => Record<string, unknown>;
};

type RowManagerConstructor = new () => RowGenerator;

type ChatItemProps = {
	message: Message;
	rowGenerator: RowGenerator;
};

type ChatItemComponent = (props: ChatItemProps) => unknown;

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

type EmbeddedMessage = {
	message: Message;
	rowGenerator: RowGenerator;
};

let unpatchMessagesRenderer: (() => void) | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let removeModuleListener: (() => boolean) | null = null;
let messages: { getMessage?: (channelId: string, messageId: string) => Message | null } | null =
	null;
let messageActions: MessageActions | null = null;
let dispatcher: { dispatch?: (event: unknown) => void } | null = null;
let messageRecord: MessageRecordConstructor | null = null;
let rowManager: RowManagerConstructor | null = null;
let chatItem: ChatItemComponent | null = null;

const cachedMessages = new Map<string, Message>();
const pendingMessages = new Set<string>();
const embeddedMessages = new Map<string, EmbeddedMessage>();
const wrappedRenderItems = new WeakMap<RenderItem, RenderItem>();

function messageKey(channelId: string, messageId: string): string {
	return `${channelId}:${messageId}`;
}

function messageChannelId(message: Message): string | undefined {
	return message.channel_id ?? message.channelId;
}

function contentText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(contentText).join('');
	if (!value || typeof value !== 'object') return '';

	const record = value as Record<string, unknown>;
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
		if (targets.length === MAX_EMBEDS) break;
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

function messageFromValue(value: unknown, depth = 0): Message | undefined {
	if (!value || typeof value !== 'object' || depth > 3) return undefined;

	const record = value as Record<string, unknown>;
	if (typeof record.id === 'string' && ('content' in record || 'author' in record)) {
		return record as Message;
	}

	for (const key of ['message', 'item', 'itemRow', 'rawRow', 'row']) {
		const result = messageFromValue(record[key], depth + 1);
		if (result) return result;
	}

	return undefined;
}

function embeddedMessage(source: Message, target: Message): EmbeddedMessage | null {
	if (!messageRecord || !rowManager) return null;

	const targetChannelId = messageChannelId(target) ?? messageChannelId(source);
	if (!target.id || !targetChannelId) return null;

	const key = messageKey(targetChannelId, target.id);
	const cached = embeddedMessages.get(key);
	if (cached) return cached;

	try {
		const message =
			target instanceof messageRecord
				? target
				: new messageRecord({ ...target, channel_id: targetChannelId });
		const generator = new rowManager();
		generator.generate({ rowType: MESSAGE_ROW_TYPE, message });
		const result = { message, rowGenerator: generator };
		embeddedMessages.set(key, result);
		return result;
	} catch {
		return null;
	}
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
	const moduleRecord = mod && typeof mod === 'object' ? (mod as Record<string, unknown>) : null;
	let holder = moduleRecord ?? {};
	let prop = 'default';
	let current = moduleRecord?.default;
	let depth = 0;

	while (current && typeof current === 'object' && depth < 5) {
		const currentRecord = current as Record<string, unknown>;
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
	if (!embedded || !chatItem) return rendered;

	const { React, ReactNative } = metro.common;
	const body = React.createElement(chatItem, {
		message: embedded.message,
		rowGenerator: embedded.rowGenerator,
	});

	return React.createElement(
		ReactNative.View,
		{
			style: {
				marginLeft: 48,
				marginRight: 12,
				marginTop: 4,
				marginBottom: 4,
				borderLeftWidth: 3,
				borderLeftColor: '#5865f2',
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

	const wrapped = (info: RenderItemInfo) => {
		const rendered = renderItem(info);
		return renderEmbeddedItem(info, rendered);
	};
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

function patchMessagesRenderer(mod: unknown): boolean {
	if (unpatchMessagesRenderer) return true;

	const target = unwrapComponent(mod);
	if (!target) return false;

	unpatchMessagesRenderer = patcher.after(target.holder, target.prop, (context) => {
		try {
			return enhanceElement(context.result);
		} catch {
			return context.result;
		}
	});

	return true;
}

function install(): void {
	const foundMessages = metro.findStore('MessageStore', { short: false });
	const foundActions = metro.findByProps('sendMessage', 'fetchMessage');
	const foundDispatcher = metro.findByProps('dispatch', 'subscribe');
	const MessageRecord = metro.findByName('MessageRecord');
	const RowManager = metro.findByName('RowManager');
	const ChatItem = metro.findByFilePath('components_native/chat/ChatItem.tsx', { interop: false });
	const MessagesRenderer = metro.findByFilePath(MESSAGE_RENDERER_PATH, { interop: false });

	if (
		!foundMessages?.getMessage ||
		!foundActions?.fetchMessage ||
		!foundDispatcher?.dispatch ||
		typeof MessageRecord !== 'function' ||
		typeof RowManager !== 'function' ||
		typeof ChatItem?.default !== 'function'
	) {
		startupTimer = setTimeout(install, 250);
		return;
	}

	messages = foundMessages;
	messageActions = foundActions;
	dispatcher = foundDispatcher;
	messageRecord = MessageRecord as MessageRecordConstructor;
	rowManager = RowManager as RowManagerConstructor;
	chatItem = ChatItem.default as ChatItemComponent;

	if (patchMessagesRenderer(MessagesRenderer)) return;

	removeModuleListener = metro.addListener((module, id) => {
		if (modulePath(id) !== MESSAGE_RENDERER_PATH || !patchMessagesRenderer(module)) return;
		removeModuleListener?.();
		removeModuleListener = null;
	});
}

export default {
	start() {
		install();
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
		cachedMessages.clear();
		pendingMessages.clear();
		embeddedMessages.clear();
	},
};
