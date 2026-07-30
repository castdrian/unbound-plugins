import { metro, patcher, storage } from '@unbound-app/api';

const ADDON_ID = 'unbound.pronoundb';
const STORE = storage.getStore(ADDON_ID);
const ROW_GENERATOR_PATH = 'modules/messages/native/renderer/MessageWithContent.tsx';
const API_URL = 'https://pronoundb.org/api/v2/lookup';
const REQUEST_BATCH_SIZE = 50;
const REQUEST_INTERVAL_MS = 2000;
const AUTO_MODERATION_ACTION = 24;

type Format = 'capitalized' | 'lowercase';
type Source = 'discord' | 'pronoundb';
type Priority = 'discord' | 'pronoundb';

type Message = {
	author?: { bot?: boolean; id?: string; system?: boolean };
	channel_id?: string;
	id?: string;
	type?: number;
};

type ProfileStore = {
	getGuildMemberProfile?: (userId: string, guildId?: string) => { pronouns?: string } | undefined;
	getUserProfile?: (userId: string) => { pronouns?: string } | undefined;
};

type PronounDBResponse = Record<string, { sets?: Record<string, string[]> }>;

const pronounMapping: Record<string, string> = {
	any: 'Any pronouns',
	ask: 'Ask me my pronouns',
	avoid: 'Avoid pronouns, use my name',
	he: 'He/Him',
	it: 'It/Its',
	other: 'Other pronouns',
	she: 'She/Her',
	they: 'They/Them',
	unspecified: 'No pronouns specified.',
};

const cache = new Map<string, string | null>();
const queue = new Set<string>();
const touchedMessages = new Map<string, Message>();
let unpatch: (() => void) | null = null;
let profiles: ProfileStore | null = null;
let users: { getCurrentUser?: () => { id?: string } | undefined } | null = null;
let channels: { getChannel?: (id: string) => { guild_id?: string } | undefined } | null = null;
let dispatcher: { dispatch?: (event: unknown) => void } | null = null;
let processing = false;
let scheduled = false;
let runId = 0;

function formatPronouns(codes: string[] | undefined): string | null {
	if (!codes?.length) return null;
	if (codes.length > 1) {
		const pronouns = codes.map((code) => code[0]?.toUpperCase() + code.slice(1)).join('/');
		return STORE.get<Format>('format', 'lowercase') === 'lowercase' ? pronouns.toLowerCase() : pronouns;
	}

	const code = codes[0];
	const value = pronounMapping[code] ?? code;
	if (STORE.get<Format>('format', 'lowercase') === 'capitalized' || ['any', 'ask', 'avoid', 'other', 'unspecified'].includes(code)) {
		return value;
	}
	return value.toLowerCase();
}

function discordPronouns(userId: string, channelId?: string): string | null {
	const global = profiles?.getUserProfile?.(userId)?.pronouns?.trim().replace(/\n+/g, '');
	const guildId = channelId ? channels?.getChannel?.(channelId)?.guild_id : undefined;
	return profiles?.getGuildMemberProfile?.(userId, guildId)?.pronouns?.trim().replace(/\n+/g, '') || global || null;
}

function resolvePronouns(userId: string, channelId?: string): string | null {
	const discord = discordPronouns(userId, channelId);
	const pronounDB = cache.get(userId) ?? null;
	const priority = STORE.get<Priority>('priority', 'pronoundb');
	return priority === 'discord' ? discord || pronounDB : pronounDB || discord;
}

function refreshMessages(): void {
	for (const message of touchedMessages.values()) {
		if (!message.id) continue;
		dispatcher?.dispatch?.({ type: 'MESSAGE_UPDATE', message: { ...message }, log_edit: false });
	}
}

async function requestPronouns(ids: string[], currentRunId: number): Promise<void> {
	const query = new URLSearchParams({ ids: ids.join(','), platform: 'discord' });
	try {
		const response = await fetch(`${API_URL}?${query}`, {
			headers: { Accept: 'application/json', 'X-PronounDB-Source': 'Unbound/1.0.0' },
		});
		if (!response.ok) throw new Error(`PronounDB returned ${response.status}`);
		const result = (await response.json()) as PronounDBResponse;
		if (runId !== currentRunId) return;
		for (const id of ids) cache.set(id, formatPronouns(result[id]?.sets?.en));
		refreshMessages();
	} catch {
		if (runId !== currentRunId) return;
		for (const id of ids) cache.set(id, null);
	}
}

async function processQueue(currentRunId: number): Promise<void> {
	if (processing) return;
	processing = true;
	while (queue.size > 0 && runId === currentRunId) {
		const ids = Array.from(queue).slice(0, REQUEST_BATCH_SIZE);
		for (const id of ids) queue.delete(id);
		await requestPronouns(ids, currentRunId);
		if (queue.size > 0 && runId === currentRunId) {
			await new Promise((resolve) => setTimeout(resolve, REQUEST_INTERVAL_MS));
		}
	}
	processing = false;
}

function enqueue(userId: string): void {
	if (cache.has(userId)) return;
	queue.add(userId);
	if (scheduled) return;
	scheduled = true;
	setTimeout(() => {
		scheduled = false;
		void processQueue(runId);
	}, 0);
}

function shouldShow(message: Message | undefined): message is Message {
	if (!message) return false;
	const author = message.author;
	if (!author?.id || author.bot || author.system || message.type === AUTO_MODERATION_ACTION) return false;
	if (!STORE.get('showSelf', true) && author.id === users?.getCurrentUser?.()?.id) return false;
	return true;
}

function addPronouns(row: any, message: Message | undefined): void {
	if (!shouldShow(message) || !message.author?.id) return;
	touchedMessages.set(message.id ?? message.author.id, message);
	const pronouns = resolvePronouns(message.author.id, message.channel_id);
	if (!cache.has(message.author.id)) enqueue(message.author.id);
	if (!pronouns || typeof row?.timestamp !== 'string' || row.timestamp.includes(`• ${pronouns}`)) return;
	row.timestamp = `${row.timestamp} • ${pronouns}`;
	if (typeof row.timestampAccessibilityLabel === 'string') {
		row.timestampAccessibilityLabel = `${row.timestampAccessibilityLabel} • ${pronouns}`;
	}
}

function getDesignModule(): { TableRow?: any; TableRowGroup?: any; TableSwitchRow?: any } | null {
	const Discord = (metro as any).components?.Discord;
	if (Discord?.TableRow && Discord?.TableRowGroup) return Discord;
	const module = metro.findByProps('TableRow', 'TableRowGroup') as any;
	return module?.TableRow && module?.TableRowGroup ? module : null;
}

function SettingsPanel() {
	const ReactNative = metro.common.ReactNative;
	const Discord = getDesignModule();
	const state = STORE.useSettingsStore();
	if (!Discord?.TableRow || !Discord?.TableRowGroup) {
		return <ReactNative.Text style={{ padding: 16 }}>Settings are unavailable on this client build.</ReactNative.Text>;
	}

	const SwitchRow = Discord.TableSwitchRow ?? Discord.TableRow;
	const format = state.get<Format>('format', 'lowercase');
	const priority = state.get<Priority>('priority', 'pronoundb');
	return (
		<ReactNative.ScrollView contentContainerStyle={{ gap: 12, padding: 16 }}>
			<Discord.TableRowGroup title="Pronouns">
				<Discord.TableRow label="Lowercase" trailing={format === 'lowercase' ? <ReactNative.Text>✓</ReactNative.Text> : null} onPress={() => state.set('format', 'lowercase')} />
				<Discord.TableRow label="Capitalized" trailing={format === 'capitalized' ? <ReactNative.Text>✓</ReactNative.Text> : null} onPress={() => state.set('format', 'capitalized')} />
			</Discord.TableRowGroup>
			<Discord.TableRowGroup title="Source">
				<Discord.TableRow label="Prefer PronounDB" subLabel="Fall back to Discord profile pronouns" trailing={priority === 'pronoundb' ? <ReactNative.Text>✓</ReactNative.Text> : null} onPress={() => state.set('priority', 'pronoundb')} />
				<Discord.TableRow label="Prefer Discord" subLabel="Fall back to PronounDB" trailing={priority === 'discord' ? <ReactNative.Text>✓</ReactNative.Text> : null} onPress={() => state.set('priority', 'discord')} />
			</Discord.TableRowGroup>
			<Discord.TableRowGroup title="Visibility">
				<SwitchRow label="Show for Yourself" value={state.get('showSelf', true)} onValueChange={(value: boolean) => state.set('showSelf', value)} />
			</Discord.TableRowGroup>
		</ReactNative.ScrollView>
	);
}

export default {
	start() {
		runId++;
		profiles = metro.findStore('UserProfile');
		users = metro.findByProps('getCurrentUser');
		channels = metro.findByProps('getChannel');
		dispatcher = metro.findByProps('dispatch', 'subscribe');
		const target = metro.findByFilePath(ROW_GENERATOR_PATH);
		if (!profiles || !users?.getCurrentUser || !target?.generateMessageRowData) return;

		unpatch = patcher.after(target, 'generateMessageRowData', (ctx) => {
			addPronouns(ctx.result?.message, ctx.args[0]?.message);
		});
	},
	stop() {
		runId++;
		unpatch?.();
		unpatch = null;
		cache.clear();
		queue.clear();
		touchedMessages.clear();
		profiles = null;
		users = null;
		channels = null;
		dispatcher = null;
		processing = false;
		scheduled = false;
	},
	getSettingsPanel: () => <SettingsPanel />,
};
