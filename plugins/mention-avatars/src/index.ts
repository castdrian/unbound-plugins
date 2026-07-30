import { metro, patcher, storage } from '@unbound-app/api';

const ADDON_ID = 'unbound.mention-avatars';
const ROW_GENERATOR_PATH = 'modules/messages/native/renderer/MessageWithContent.tsx';
const STORE = storage.getStore(ADDON_ID);

type Mention = {
	avatarURL?: string;
	label: string;
	type: 'role' | 'user';
};

type User = {
	avatar?: string | null;
	getAvatarURL?: (guildId?: string | null, size?: number, animated?: boolean) => string;
	globalName?: string | null;
	id: string;
	username?: string;
};

let unpatch: (() => void) | null = null;
let users: { getUser?: (id: string) => User | undefined } | null = null;
let members: { getMember?: (guildId: string, userId: string) => { nick?: string } | undefined } | null = null;
let roles: { getRole?: (guildId: string, roleId: string) => { icon?: string | null; id: string; name?: string } | undefined } | null = null;
const mentionIndex = new Map<string, Mention>();

function getBridge(): { clearMentionAvatars?: () => void; setMentionAvatars?: (mentions: string) => void } | null {
	return (globalThis as any).UnboundNative?.chat ?? null;
}

function pngURL(url: string): string {
	return url.replace(/\.webp(?=\?|$)/, '.png');
}

function userAvatarURL(user: User, guildId?: string): string | undefined {
	const resolved = user.getAvatarURL?.(guildId ?? null, 32, false);
	if (resolved) return pngURL(resolved);
	if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=32`;
	return undefined;
}

function addUserMentions(mentions: Map<string, Mention>, userId: string, guildId?: string): void {
	const user = users?.getUser?.(userId);
	if (!user) return;

	const labels = [members?.getMember?.(guildId ?? '', userId)?.nick, user.globalName, user.username];
	for (const label of labels) {
		if (!label) continue;
		mentions.set(`user:${label}`, { avatarURL: userAvatarURL(user, guildId), label, type: 'user' });
	}
}

function addRoleMention(mentions: Map<string, Mention>, roleId: string, guildId?: string): void {
	if (!guildId) return;
	const role = roles?.getRole?.(guildId, roleId);
	if (!role?.name) return;

	const avatarURL = role.icon
		? `https://cdn.discordapp.com/role-icons/${role.id}/${role.icon}.png?size=32&quality=lossless`
		: undefined;
	mentions.set(`role:${role.name}`, { avatarURL, label: role.name, type: 'role' });
}

function collectMentions(message: any): Mention[] {
	const mentions = new Map<string, Mention>();
	const guildId = message?.guild_id ?? message?.guildId;
	const content = message?.content;
	if (typeof content !== 'string') return [];

	for (const match of content.matchAll(/<@!?(\d+)>|<@&(\d+)>/g)) {
		if (match[1]) addUserMentions(mentions, match[1], guildId);
		if (match[2]) addRoleMention(mentions, match[2], guildId);
	}

	return [...mentions.values()];
}

function addMentions(message: any): boolean {
	let changed = false;
	for (const mention of collectMentions(message)) {
		const key = `${mention.type}:${mention.label}`;
		const existing = mentionIndex.get(key);
		if (existing?.avatarURL === mention.avatarURL) continue;
		mentionIndex.set(key, mention);
		changed = true;
	}
	return changed;
}

function sendMentions(): void {
	const bridge = getBridge();
	if (!bridge?.setMentionAvatars) return;
	bridge.setMentionAvatars(
		JSON.stringify({ mentions: [...mentionIndex.values()], showAtSymbol: STORE.get('showAtSymbol', true) }),
	);
}

function hydrateMentions(): void {
	const channelId = metro.findByProps('getChannelId')?.getChannelId?.();
	const messages = metro.findStore('Message')?.getMessages?.(channelId)?._array;
	if (!Array.isArray(messages)) return;

	for (const message of messages) addMentions(message);
	sendMentions();
}

function start(): void {
	users = metro.findByProps('getCurrentUser', 'getUser');
	members = metro.findStore('GuildMember');
	roles = metro.findStore('GuildRole');

	const target = metro.findByFilePath(ROW_GENERATOR_PATH);
	if (typeof target?.generateMessageRowData !== 'function') return;

	unpatch = patcher.after(target, 'generateMessageRowData', (ctx) => {
		if (addMentions(ctx.args[0]?.message)) sendMentions();
	});

	hydrateMentions();
}

export default {
	start,
	stop() {
		unpatch?.();
		unpatch = null;
		users = null;
		members = null;
		roles = null;
		mentionIndex.clear();
		getBridge()?.clearMentionAvatars?.();
	},
};
