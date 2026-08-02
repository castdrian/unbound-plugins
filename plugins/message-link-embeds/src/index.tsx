import { metro, patcher } from '@unbound-app/api';

const MESSAGE_ROW_TYPE = 1;
const MAX_EMBEDS = 3;
const MESSAGE_LINK_REGEX = /https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(?:\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})/g;

type Author = {
	globalName?: string | null;
	username?: string;
};

type Message = {
	author?: Author;
	channel_id?: string;
	content?: string;
	guild_id?: string | null;
	id?: string;
	timestamp?: string;
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

type RowManager = {
	generate(row: Record<string, unknown>): Record<string, unknown>;
};

type MessageRecordFactory = {
	createMessageRecord(message: Message): Message;
};

type ChatManager = {
	rowIndex: number;
	rows: Record<string, unknown>[];
	createRow(row: Record<string, unknown>): void;
};

let unpatchCreateRow: (() => void) | null = null;
let unpatchRowManagerGenerate: (() => void) | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let messages: { getMessage?: (channelId: string, messageId: string) => Message | null } | null = null;
let messageActions: MessageActions | null = null;
let dispatcher: { dispatch?: (event: unknown) => void } | null = null;
let rowManager: RowManager | null = null;
let messageRecordFactory: MessageRecordFactory | null = null;

const cachedMessages = new Map<string, Message>();
const pendingMessages = new Set<string>();
const sourceMessages = new Map<string, Message>();

function messageKey(channelId: string, messageId: string): string {
	return `${channelId}:${messageId}`;
}

function linkedTargets(message: Message): LinkTarget[] {
	if (!message.content) return [];

	const targets: LinkTarget[] = [];
	for (const match of message.content.matchAll(MESSAGE_LINK_REGEX)) {
		if (targets.some((target) => target.channelId === match[1] && target.messageId === match[2])) continue;
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

function fetchLinkedMessage(source: Message, target: LinkTarget): void {
	const key = messageKey(target.channelId, target.messageId);
	if (pendingMessages.has(key)) return;
	pendingMessages.add(key);

	messageActions?.fetchMessage?.(target)
		.then((result) => {
			const resolved = messages?.getMessage?.(target.channelId, target.messageId) ?? result ?? linkedMessage(target);
			if (resolved) cachedMessages.set(key, resolved);
		})
		.catch(() => undefined)
		.finally(() => {
			pendingMessages.delete(key);
			if (source.id) dispatcher?.dispatch?.({ type: 'MESSAGE_UPDATE', message: { ...source }, log_edit: false });
		});
}

function rememberSource(message: Message): void {
	if (!message.id) return;
	sourceMessages.set(message.id, message);
	for (const target of linkedTargets(message)) {
		if (!linkedMessage(target)) fetchLinkedMessage(message, target);
	}
}

function sourceForRow(row: Record<string, unknown>): Message | null {
	const rendered = row.message as Message | undefined;
	if (!rendered?.id) return null;
	return sourceMessages.get(rendered.id) ?? messages?.getMessage?.(rendered.channel_id ?? (rendered.channelId as string | undefined) ?? '', rendered.id) ?? null;
}

function syntheticId(source: Message, linked: Message): string | null {
	if (!source.id || !linked.id) return null;
	try {
		const id = BigInt(source.id) ^ BigInt(linked.id) ^ 4611686018427387904n;
		return (id === 0n ? 1n : id).toString();
	} catch {
		return null;
	}
}

function embeddedRow(source: Message, linked: Message): Record<string, unknown> | null {
	const id = syntheticId(source, linked);
	if (!id || !source.channel_id || !linked.id || !linked.channel_id || !rowManager || !messageRecordFactory) return null;

	try {
		const message = messageRecordFactory.createMessageRecord({
			id,
			type: 0,
			channel_id: source.channel_id,
			guild_id: source.guild_id,
			author: source.author,
			timestamp: source.timestamp,
			content: '',
			attachments: [],
			embeds: [],
			components: [],
			mentions: [],
			mention_roles: [],
			message_reference: {
				type: 1,
				channel_id: linked.channel_id,
				guild_id: linked.guild_id,
				message_id: linked.id,
			},
			message_snapshots: [{ message: linked }],
		});

		const row = rowManager.generate({
			rowType: MESSAGE_ROW_TYPE,
			changeType: 0,
			isFirst: false,
			canAddNewReactions: false,
			canShowImages: true,
			message,
		});
		row.separatorBefore = false;
		row.renderContentOnly = true;
		(row.message as Record<string, unknown>).renderContentOnly = true;
		return row;
	} catch {
		return null;
	}
}

function install(): void {
	const foundMessages = metro.findStore('MessageStore', { short: false });
	const foundActions = metro.findByProps('sendMessage', 'fetchMessage');
	const foundDispatcher = metro.findByProps('dispatch', 'subscribe');
	const foundMessageRecordFactory = metro.findByProps('createMessageRecord');
	const ChatManager = metro.find((module) => module?.default?.name === 'ChatManager')?.default;
	const RowManager = metro.find((module) => module?.default?.name === 'RowManager')?.default;

	if (!foundMessages?.getMessage || !foundActions?.fetchMessage || !foundDispatcher?.dispatch || !foundMessageRecordFactory?.createMessageRecord || !ChatManager?.prototype?.createRow || !RowManager?.prototype?.generate) {
		startupTimer = setTimeout(install, 250);
		return;
	}

	messages = foundMessages;
	messageActions = foundActions;
	dispatcher = foundDispatcher;
	messageRecordFactory = foundMessageRecordFactory;

	unpatchRowManagerGenerate = patcher.before(RowManager.prototype, 'generate', (context) => {
		rowManager = context.this as RowManager;
		const source = context.args[0]?.message as Message | undefined;
		if (source) rememberSource(source);
	});

	unpatchCreateRow = patcher.after(ChatManager.prototype, 'createRow', (context) => {
		const row = context.args[0] as Record<string, unknown>;
		const source = sourceForRow(row);
		if (!source) return;

		for (const target of linkedTargets(source)) {
			const linked = linkedMessage(target);
			if (!linked || linked.id === source.id) continue;
			const embedded = embeddedRow(source, linked);
			if (!embedded) continue;
			embedded.index = context.this.rowIndex++;
			const sourceIndex = context.this.rows.findIndex((candidate) => (candidate.message as Message | undefined)?.id === source.id);
			context.this.rows.splice(sourceIndex < 0 ? context.this.rows.length : sourceIndex, 0, embedded);
		}
	});
}

export default {
	start() {
		install();
	},
	stop() {
		if (startupTimer) clearTimeout(startupTimer);
		startupTimer = null;
		unpatchCreateRow?.();
		unpatchCreateRow = null;
		unpatchRowManagerGenerate?.();
		unpatchRowManagerGenerate = null;
		messages = null;
		messageActions = null;
		dispatcher = null;
		rowManager = null;
		messageRecordFactory = null;
		cachedMessages.clear();
		pendingMessages.clear();
		sourceMessages.clear();
	},
};
