import { metro, patcher } from '@unbound-app/api';

const ROW_GENERATOR_PATH = 'modules/messages/native/renderer/MessageWithContent.tsx';
const REACTION_ACTIONS_PATH = 'modules/reactions/ReactionActionCreators.tsx';
const MARKER = '__unbound-who-reacted:';
const MAX_VISIBLE_SLOTS = 5;
const MAX_AVATARS = MAX_VISIBLE_SLOTS - 1;
const MAX_REACTORS = 100;
const MORE_REACTORS = '__unbound-who-reacted-more:';
const MAX_CACHE_ENTRIES = 500;
const INVALIDATION_EVENTS = [
	'MESSAGE_REACTION_ADD',
	'MESSAGE_REACTION_REMOVE',
	'MESSAGE_REACTION_REMOVE_ALL',
	'MESSAGE_REACTION_REMOVE_EMOJI',
];

type ReactionEmoji = {
	id: string | null;
	name: string;
};

type ReactionUser = {
	avatar?: string | null;
	discriminator?: string;
	getAvatarURL?: (guildId?: string | null, size?: number, animated?: boolean) => string;
	id: string;
};

type SourceMessage = {
	channel_id?: string;
	channelId?: string;
	id?: string;
};

type CachedReaction = {
	state: 'loading' | 'ready';
	users: ReactionUser[];
};

type NativeBridge = {
	chat?: {
		clearReactionAvatarGroups?: () => void;
		setReactionAvatarGroups?: (groups: string) => void;
	};
	supportsFeature?: (feature: string) => boolean;
};

const reactionCache = new Map<string, CachedReaction>();
const reactionRequestVersions = new Map<string, number>();
const staleReactionCache = new Map<string, CachedReaction>();
const nativeGroups = new Map<string, string[]>();
const touchedMessages = new Map<string, SourceMessage>();
const unpatches: Array<() => void> = [];
let dispatcher: any = null;
let reactionActions: any = null;
let runId = 0;
let startupTimer: ReturnType<typeof setTimeout> | null = null;

function getNativeBridge(): NativeBridge | null {
	return (globalThis as any).UnboundNative ?? null;
}

function supportsReactionAvatars(): boolean {
	return getNativeBridge()?.supportsFeature?.('chat.reactionAvatars') === true;
}

function getMessageId(message: SourceMessage | undefined): string | null {
	return message?.id ?? null;
}

function getChannelId(message: SourceMessage | undefined): string | null {
	return message?.channel_id ?? message?.channelId ?? null;
}

function getEmojiKey(emoji: ReactionEmoji): string {
	return emoji.id ?? encodeURIComponent(emoji.name);
}

function getReactionKey(messageId: string, emoji: ReactionEmoji): string {
	return `${messageId}:${getEmojiKey(emoji)}`;
}

function getGroupId(messageId: string, emoji: ReactionEmoji): string {
	return `${MARKER}${getReactionKey(messageId, emoji)}`;
}

function isMarkerEmoji(emoji: unknown): boolean {
	return typeof (emoji as { id?: unknown } | null)?.id === 'string' &&
		(emoji as { id: string }).id.startsWith(MARKER);
}

function getAvatarURL(user: ReactionUser): string {
	const resolved = user.getAvatarURL?.(null, 64, false);
	if (resolved) return resolved;

	if (user.avatar) {
		return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=64`;
	}

	const legacyIndex = Number.parseInt(user.discriminator ?? '', 10);
	const defaultIndex = Number.isFinite(legacyIndex) && legacyIndex > 0
		? legacyIndex % 5
		: Number((BigInt(user.id) >> 22n) % 6n);
	return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
}

function getAvatarURLs(users: ReactionUser[]): string[] {
	if (users.length <= MAX_VISIBLE_SLOTS) return users.map(getAvatarURL);

	return [
		...users.slice(0, MAX_AVATARS).map(getAvatarURL),
		`${MORE_REACTORS}${users.length - MAX_AVATARS}`,
	];
}

function getCurrentUser(): ReactionUser | null {
	return metro.findByProps('getCurrentUser')?.getCurrentUser?.() ?? null;
}

function trimCache(): void {
	while (reactionCache.size >= MAX_CACHE_ENTRIES) {
		const oldest = reactionCache.keys().next().value;
		if (typeof oldest !== 'string') return;
		reactionCache.delete(oldest);
	}
}

function syncNativeGroups(): void {
	const bridge = getNativeBridge();
	if (!bridge?.chat?.setReactionAvatarGroups) return;

	const payload = JSON.stringify(
		Array.from(nativeGroups, ([id, avatarURLs]) => ({ id, avatarURLs })),
	);
	bridge.chat.setReactionAvatarGroups(payload);
}

function refreshMessage(message: SourceMessage): void {
	if (!dispatcher?.dispatch || !message.id) return;
	const reactions = (message as SourceMessage & { reactions?: unknown }).reactions;

	dispatcher.dispatch({
		type: 'MESSAGE_UPDATE',
		message: {
			...message,
			reactions: Array.isArray(reactions) ? [...reactions] : reactions,
		},
		log_edit: false,
	});
}

function refreshMessageAfterReactionUsersLoad(message: SourceMessage, currentRunId: number): void {
	refreshMessage(message);
	setTimeout(() => {
		if (runId === currentRunId) refreshMessage(message);
	}, 200);
}

function orderReactionUsers(key: string, fetchedUsers: ReactionUser[]): ReactionUser[] {
	const previousUsers = staleReactionCache.get(key)?.users ?? [];
	const fetchedById = new Map(fetchedUsers.map((user) => [user.id, user]));
	const orderedUsers: ReactionUser[] = [];
	for (const user of previousUsers) {
		const fetchedUser = fetchedById.get(user.id);
		if (fetchedUser) {
			orderedUsers.push(fetchedUser);
			fetchedById.delete(user.id);
		}
	}
	for (const user of fetchedUsers) {
		const fetchedUser = fetchedById.get(user.id);
		if (fetchedUser) {
			orderedUsers.push(fetchedUser);
			fetchedById.delete(user.id);
		}
	}
	return orderedUsers;
}

function getReactionTypes(reaction: any): number[] {
	const normalCount = reaction.count_details?.normal ?? Math.max(0, (reaction.count ?? 0) - (reaction.burst_count ?? 0));
	const burstCount = reaction.count_details?.burst ?? reaction.burst_count ?? 0;
	const types: number[] = [];
	if (normalCount > 0) types.push(0);
	if (burstCount > 0) types.push(1);
	return types;
}

function loadReactionUsers(
	message: SourceMessage,
	emoji: ReactionEmoji,
	types: number[],
	currentRunId: number,
): void {
	const messageId = getMessageId(message);
	const channelId = getChannelId(message);
	if (!messageId || !channelId || typeof reactionActions?.getReactors !== 'function') return;

	const key = getReactionKey(messageId, emoji);
	if (reactionCache.has(key)) return;

	trimCache();
	const requestVersion = (reactionRequestVersions.get(key) ?? 0) + 1;
	reactionRequestVersions.set(key, requestVersion);
	reactionCache.set(key, { state: 'loading', users: [] });
	void Promise.all(
		types.map((type) => reactionActions.getReactors({
			channelId,
			messageId,
			emoji,
			type,
			limit: MAX_REACTORS,
		})),
	)
		.then((results: ReactionUser[][]) => {
			if (runId !== currentRunId || reactionRequestVersions.get(key) !== requestVersion) return;
			for (const [index, users] of results.entries()) {
				dispatcher?.dispatch?.({
					type: 'MESSAGE_REACTION_ADD_USERS',
					channelId,
					messageId,
					users: users ?? [],
					emoji,
					reactionType: types[index],
				});
			}

			const users = new Map<string, ReactionUser>();
			for (const result of results) {
				for (const user of result ?? []) users.set(user.id, user);
			}
			const resolvedUsers = orderReactionUsers(key, Array.from(users.values()));
			reactionCache.set(key, { state: 'ready', users: resolvedUsers });
			staleReactionCache.delete(key);
			if (resolvedUsers.length) {
				nativeGroups.set(getGroupId(messageId, emoji), getAvatarURLs(resolvedUsers));
			} else {
				nativeGroups.delete(getGroupId(messageId, emoji));
			}
			syncNativeGroups();
			refreshMessageAfterReactionUsersLoad(message, currentRunId);
		})
		.catch(() => {
			if (runId === currentRunId && reactionRequestVersions.get(key) === requestVersion) {
				const stale = staleReactionCache.get(key);
				reactionCache.set(key, { state: 'ready', users: stale?.users ?? [] });
			}
		});
}

function createAvatarReaction(groupId: string, avatarURL: string) {
	return {
		count: 1,
		count_details: { burst: 0, normal: 1 },
		burst_colors: [],
		burst_count: 0,
		burst_me: false,
		me: false,
		me_burst: false,
		emoji: {
			id: groupId,
			name: groupId,
			src: avatarURL,
			displayName: groupId,
		},
	};
}

function addAvatarGroups(result: any, sourceMessage: SourceMessage | undefined, currentRunId: number): void {
	const rowMessage = result?.message;
	const messageId = getMessageId(sourceMessage);
	if (result?.type !== 1 || !rowMessage || !messageId || !Array.isArray(rowMessage.reactions)) return;

	const originalReactions = [...rowMessage.reactions];
	const augmentedReactions = [];
	for (const reaction of originalReactions) {
		augmentedReactions.push(reaction);
		if (isMarkerEmoji(reaction.emoji)) continue;
		if (typeof reaction.emoji?.name !== 'string') continue;

		const emoji: ReactionEmoji = {
			id: reaction.emoji.id ?? null,
			name: reaction.emoji.name,
		};
		const types = getReactionTypes(reaction);
		if (!types.length) continue;

		const key = getReactionKey(messageId, emoji);
		let cached = reactionCache.get(key);
		if (!cached) {
			if (!sourceMessage) continue;
			loadReactionUsers(sourceMessage, emoji, types, currentRunId);
			cached = staleReactionCache.get(key);
		}
		if (!cached?.users.length) continue;

		const groupId = getGroupId(messageId, emoji);
		const avatarURLs = getAvatarURLs(cached.users);
		if (sourceMessage) touchedMessages.set(messageId, sourceMessage);
		nativeGroups.set(groupId, avatarURLs);
		augmentedReactions.push(createAvatarReaction(groupId, avatarURLs[0]));
	}

	rowMessage.reactions = augmentedReactions;
	syncNativeGroups();
}

function invalidateMessage(messageId: string): void {
	const cachePrefix = `${messageId}:`;
	for (const key of reactionCache.keys()) {
		if (!key.startsWith(cachePrefix)) continue;
		const cached = reactionCache.get(key);
		if (cached?.users.length) staleReactionCache.set(key, cached);
		reactionCache.delete(key);
		reactionRequestVersions.set(key, (reactionRequestVersions.get(key) ?? 0) + 1);
	}
}

function onReactionChange(event: any): void {
	const messageId = event?.messageId ?? event?.message_id;
	if (typeof messageId !== 'string') return;

	invalidateMessage(messageId);
	const message = touchedMessages.get(messageId);
	const emoji = event?.emoji as ReactionEmoji | undefined;
	const currentUser = getCurrentUser();
	const userId = event?.userId ?? event?.user_id;
	if (message && emoji?.name && currentUser?.id === userId) {
		const key = getReactionKey(messageId, emoji);
		const users = staleReactionCache.get(key)?.users ?? [];
		const withoutCurrentUser = users.filter((user) => user.id !== currentUser.id);
		const updatedUsers = event?.type === 'MESSAGE_REACTION_REMOVE'
			? withoutCurrentUser
			: [...withoutCurrentUser, currentUser];
		staleReactionCache.set(key, { state: 'ready', users: updatedUsers });
		if (updatedUsers.length) {
			nativeGroups.set(getGroupId(messageId, emoji), getAvatarURLs(updatedUsers));
		} else {
			nativeGroups.delete(getGroupId(messageId, emoji));
		}
		syncNativeGroups();
	}
	if (message) refreshMessage(message);
}

function interceptMarkerActions(): void {
	for (const method of ['addReaction', 'removeReaction']) {
		if (typeof reactionActions?.[method] !== 'function') continue;
		unpatches.push(
			patcher.instead(reactionActions, method, (ctx) => {
				if (isMarkerEmoji(ctx.args[2])) return;
				return ctx.original.apply(ctx.this, ctx.args);
			}),
		);
	}
}

function install(currentRunId: number): void {
	reactionActions = metro.findByFilePath(REACTION_ACTIONS_PATH);
	dispatcher = metro.findByProps('dispatch', 'subscribe');
	const rowGenerator = metro.findByFilePath(ROW_GENERATOR_PATH);
	if (typeof reactionActions?.getReactors !== 'function' ||
		typeof rowGenerator?.generateMessageRowData !== 'function') {
		startupTimer = setTimeout(() => {
			if (runId === currentRunId) install(currentRunId);
		}, 250);
		return;
	}

	unpatches.push(
		patcher.after(rowGenerator, 'generateMessageRowData', (ctx) => {
			try {
				addAvatarGroups(ctx.result, ctx.args[0]?.message, currentRunId);
			} catch { }
		}),
	);
	interceptMarkerActions();
	if (dispatcher?.subscribe) {
		for (const event of INVALIDATION_EVENTS) dispatcher.subscribe(event, onReactionChange);
	}
}

function start(): void {
	if (!supportsReactionAvatars()) return;

	runId++;
	install(runId);
}

function stop(): void {
	runId++;
	if (startupTimer) clearTimeout(startupTimer);
	startupTimer = null;
	for (const unpatch of unpatches.splice(0)) unpatch();
	if (dispatcher?.unsubscribe) {
		for (const event of INVALIDATION_EVENTS) dispatcher.unsubscribe(event, onReactionChange);
	}
	reactionCache.clear();
	reactionRequestVersions.clear();
	staleReactionCache.clear();
	nativeGroups.clear();
	getNativeBridge()?.chat?.clearReactionAvatarGroups?.();
	for (const message of touchedMessages.values()) refreshMessage(message);
	touchedMessages.clear();
	dispatcher = null;
	reactionActions = null;
}

export default {
	start,
	stop,
};
