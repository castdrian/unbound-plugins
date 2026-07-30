import { metro, patcher, storage } from '@unbound-app/api';

const ADDON_ID = 'unbound.mention-avatars';
const ROW_GENERATOR_PATH = 'modules/messages/native/renderer/MessageWithContent.tsx';
const STORE = storage.getStore(ADDON_ID);

type Mention = {
	avatarURL?: string;
	labels: string[];
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
let channels: { getChannel?: (channelId: string) => { guild_id?: string; guildId?: string } | undefined } | null = null;
let roles: {
	getRole?: (guildId: string, roleId: string) => { icon?: string | null; id: string; name?: string } | undefined;
	getSortedRoles?: (guildId: string) => unknown[];
} | null = null;
const messageMentionIndex = new Map<string, Mention[]>();

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

function userMention(userId: string, guildId?: string): Mention | undefined {
	const user = users?.getUser?.(userId);
	if (!user) return;

	const labels = [members?.getMember?.(guildId ?? '', userId)?.nick, user.globalName, user.username].filter(
		(label): label is string => Boolean(label),
	);
	if (labels.length === 0) return;
	return { avatarURL: userAvatarURL(user, guildId), labels: [...new Set(labels)], type: 'user' };
}

function roleMention(roleId: string, guildId?: string): Mention | undefined {
	if (!guildId) return;
	const role = roles?.getRole?.(guildId, roleId);
	if (!role?.name) return;

	const avatarURL = role.icon
		? `https://cdn.discordapp.com/role-icons/${role.id}/${role.icon}.png?size=32&quality=lossless`
		: undefined;
	return { avatarURL, labels: [role.name], type: 'role' };
}

function guildIdForMessage(message: any): string | undefined {
	const directGuildId = message?.guild_id ?? message?.guildId;
	if (directGuildId) return directGuildId;
	const channelId = message?.channel_id ?? message?.channelId;
	const channel = channelId ? channels?.getChannel?.(channelId) : undefined;
	return channel?.guild_id ?? channel?.guildId;
}

function collectMentions(message: any): Mention[] {
	const mentions: Mention[] = [];
	const guildId = guildIdForMessage(message);
	const content = message?.content;
	if (typeof content !== 'string') return [];

	for (const match of content.matchAll(/<@!?(\d+)>|<@&(\d+)>/g)) {
		const mention = match[1] ? userMention(match[1], guildId) : roleMention(match[2], guildId);
		if (mention) mentions.push(mention);
	}

	return mentions;
}

function addMentions(message: any): boolean {
	const id = message?.id;
	if (typeof id !== 'string') return false;
	const mentions = collectMentions(message);
	if (JSON.stringify(messageMentionIndex.get(id)) === JSON.stringify(mentions)) return false;
	messageMentionIndex.set(id, mentions);
	return true;
}

function sendMentions(): void {
	const bridge = getBridge();
	if (!bridge?.setMentionAvatars) return;
	bridge.setMentionAvatars(
		JSON.stringify({
			messages: [...messageMentionIndex].map(([id, mentions]) => ({ id, mentions })),
			showAtSymbol: STORE.get('showAtSymbol', true),
		}),
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
	channels = metro.findByProps('getChannel');
	roles = metro.find(
		(module) => typeof module?.getRole === 'function' && typeof module?.getSortedRoles === 'function',
	);

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
		channels = null;
		roles = null;
		messageMentionIndex.clear();
		getBridge()?.clearMentionAvatars?.();
	},
};
