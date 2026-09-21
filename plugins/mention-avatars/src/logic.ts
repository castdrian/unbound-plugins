export type MentionType = 'role' | 'user';

export type Mention = {
	avatarURL?: string;
	labels: string[];
	roleColor?: number;
	type: MentionType;
};

export type MentionToken = {
	id: string;
	type: MentionType;
};

export type ImageCacheEntry = {
	image: unknown | null;
	pending?: Promise<unknown | null>;
	retryAt?: number;
};

export type ImageCacheAction = 'cached' | 'pending' | 'retry' | 'load';

export type CellRenderDecision = 'idle' | 'render' | 'retry';

export type MentionImageMetrics = {
	leading: number;
	size: number;
	trailing: number;
};

export type RoleImageSource = {
	avatarURL?: string;
	roleColor?: number;
};

export function extractMentionTokens(content: string): MentionToken[] {
	return [...content.matchAll(/<@!?([0-9]+)>|<@&([0-9]+)>/g)].map((match) => ({
		id: match[1] ?? match[2],
		type: match[1] ? 'user' : 'role',
	}));
}

export function selectMentionLabel(text: string, labels: string[]): string | undefined {
	const atOffset = text.indexOf('@');
	if (atOffset === -1) return undefined;

	const mentionText = text.slice(atOffset);
	return [...labels]
		.sort((left, right) => right.length - left.length)
		.find((label) => {
			const prefix = `@${label}`;
			if (!mentionText.startsWith(prefix)) return false;
			const next = mentionText[prefix.length];
			return !next || next === '\u2068' || next === '\u2069' || /\s/u.test(next);
		});
}

export function mentionImageMetrics(type: MentionType): MentionImageMetrics {
	return {
		size: 16,
		leading: type === 'role' ? 4 : 2,
		trailing: type === 'role' ? 2 : 4,
	};
}

export function imageCacheAction(
	entry: ImageCacheEntry | undefined,
	now: number = Date.now(),
): ImageCacheAction {
	if (entry?.image) return 'cached';
	if (entry?.pending) return 'pending';
	if (entry?.retryAt && entry.retryAt > now) return 'retry';
	return 'load';
}

export function roleImageSource(role: {
	color?: number;
	icon?: string | null;
	id: string;
}): RoleImageSource {
	return {
		avatarURL: role.icon
			? `https://cdn.discordapp.com/role-icons/${role.id}/${role.icon}.png?size=32&quality=lossless`
			: undefined,
		roleColor: typeof role.color === 'number' && role.color > 0 ? role.color : undefined,
	};
}

export function cellRenderDecision(
	messageID: string | undefined,
	messageHydrated: boolean,
	unresolved: boolean,
	mentions: Mention[],
): CellRenderDecision {
	if (!messageID) return 'idle';
	if (!messageHydrated || unresolved) return 'retry';
	return mentions.length > 0 ? 'render' : 'idle';
}

export function containsMentionText(value: string, mentions: Mention[]): boolean {
	return mentions.every((metadata) => metadata.labels.some((label) => value.includes(`@${label}`)));
}
