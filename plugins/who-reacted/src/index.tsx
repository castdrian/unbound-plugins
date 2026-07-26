import { metro, native, patcher } from '@unbound-app/api';

const MARKER = '__unbound-who-reacted:';
const Patcher = patcher.createPatcher('unbound.who-reacted');

type ReactionEmoji = {
	id: string | null;
	name: string;
	};

type ReactionUser = {
	avatar: string | null;
	id: string;
	username: string;
	};

type CachedReaction = {
	state: 'loading' | 'ready';
	users: ReactionUser[];
};

const reactions = new Map<string, CachedReaction>();
const unpatches: Array<() => void> = [];

function getReactionKey(messageId: string, emoji: ReactionEmoji, type: number): string {
	return `${messageId}:${emoji.id ?? emoji.name}:${type}`;
}

function getAvatarURL(user: ReactionUser): string | null {
	if (!user.avatar) return null;
	return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=64`;
}

function loadReactionUsers(channelId: string, messageId: string, emoji: ReactionEmoji, type: number): void {
	const key = getReactionKey(messageId, emoji, type);
	if (reactions.has(key)) return;

	reactions.set(key, { state: 'loading', users: [] });
	const actions = metro.findByFilePath('modules/reactions/ReactionActionCreators.tsx');
	if (typeof actions?.getReactors !== 'function') return;

	void actions
		.getReactors({ channelId, messageId, emoji, type })
		.then((users: ReactionUser[]) => reactions.set(key, { state: 'ready', users }));
}

function addAvatarReactions(row: any): void {
	const message = row?.message;
	const channelId = message?.channel_id ?? message?.channelId;
	if (row?.type !== 1 || !message?.reactions || !channelId) return;

	const avatarGroups: native.ReactionAvatarGroup[] = [];
	for (const reaction of message.reactions) {
		if (reaction.emoji?.id?.startsWith(MARKER)) continue;

		const emoji: ReactionEmoji = { id: reaction.emoji?.id ?? null, name: reaction.emoji?.name };
		const type = reaction.burst_count > 0 ? 1 : 0;
		const key = getReactionKey(message.id, emoji, type);
		const cached = reactions.get(key);
		if (!cached) {
			loadReactionUsers(channelId, message.id, emoji, type);
			continue;
		}
		if (cached.state !== 'ready') continue;

		const groupId = `${MARKER}${key}`;
		const users = cached.users.slice(0, 5);
		const avatarURLs = users.map(getAvatarURL).filter((url): url is string => Boolean(url));
		if (!avatarURLs.length) continue;

		avatarGroups.push({ id: groupId, avatarURLs });
		for (let index = 0; index < avatarURLs.length; index++) {
			const user = users[index];
			row.message.reactions.push({
				count: 1,
				count_details: { burst: 0, normal: 1 },
				burst_colors: [],
				burst_count: 0,
				burst_me: false,
				me: false,
				me_burst: false,
				emoji: {
					id: `${groupId}:${index}`,
					name: `${groupId}:${index}`,
					src: avatarURLs[index],
					displayName: `${groupId}:${index}`,
				},
			});
		}
	}

	native.chat.setReactionAvatarGroups(avatarGroups);
}

function start(): void {
	const ChatManager = metro.findByName('ChatManager');
	if (!ChatManager?.prototype?.createRow) return;


	unpatches.push(Patcher.before(ChatManager.prototype, 'createRow', ({ args }) => addAvatarReactions(args[0])));

	const actions = metro.findByFilePath('modules/reactions/ReactionActionCreators.tsx');
	if (typeof actions?.addReaction !== 'function') return;

	unpatches.push(Patcher.instead(actions, 'addReaction', ({ args, original, this: self }) => {
		if (typeof args[2]?.id === 'string' && args[2].id.startsWith(MARKER)) return;
		return original.apply(self, args);
	}));
}

export default {
	start,
	stop() {
		for (const unpatch of unpatches.splice(0)) unpatch();
		reactions.clear();
		native.chat.clearReactionAvatarGroups();
	},
};
