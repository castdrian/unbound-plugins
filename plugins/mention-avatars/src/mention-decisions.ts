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

export type MentionCandidate = {
	avatar?: string | null;
	color?: number;
	id: string;
	icon?: string | null;
	labels?: string[];
	name?: string;
	preferredURL?: string;
	type: MentionType;
};

export type MentionSelectionInput = {
	candidates: MentionCandidate[];
	content: string;
};

export type MentionSelection = {
	complete: boolean;
	mentions: Mention[];
};

export type MentionBatchEntry = {
	id: string;
	input: MentionSelectionInput;
};

export type MentionBatchResult = {
	id: string;
	selection: MentionSelection;
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

export function roleImageSource(role: { color?: number; icon?: string | null; id: string }): {
	avatarURL?: string;
	roleColor?: number;
} {
	return {
		avatarURL: role.icon
			? `https://cdn.discordapp.com/role-icons/${role.id}/${role.icon}.png?size=32&quality=lossless`
			: undefined,
		roleColor: typeof role.color === 'number' && role.color > 0 ? role.color : undefined,
	};
}

function pngURL(url: string): string {
	const png = url.replace(/\.webp(?=\?|$)/, '.png');
	if (/[?&]size=\d+/.test(png))
		return png.replace(/([?&]size=)\d+/, (_, prefix: string) => `${prefix}32`);
	return `${png}${png.includes('?') ? '&' : '?'}size=32`;
}

export function selectMentions(input: MentionSelectionInput): MentionSelection {
	const mentions: Mention[] = [];
	let complete = true;
	for (const token of extractMentionTokens(input.content)) {
		const candidate = input.candidates.find(
			(entry) => entry.id === token.id && entry.type === token.type,
		);
		if (!candidate) {
			complete = false;
			continue;
		}
		if (token.type === 'role') {
			if (!candidate.name) {
				complete = false;
				continue;
			}
			const image = roleImageSource(candidate);
			mentions.push({ ...image, labels: [candidate.name], type: 'role' });
			continue;
		}
		const labels = [...new Set((candidate.labels ?? []).filter(Boolean))];
		if (labels.length === 0) {
			complete = false;
			continue;
		}
		const avatarURL = candidate.preferredURL
			? pngURL(candidate.preferredURL)
			: candidate.avatar
				? `https://cdn.discordapp.com/avatars/${candidate.id}/${candidate.avatar}.png?size=32`
				: undefined;
		mentions.push({ avatarURL, labels, type: 'user' });
	}
	return { complete, mentions };
}

export function selectMentionBatch(entries: MentionBatchEntry[]): MentionBatchResult[] {
	return entries.map(({ id, input }) => ({ id, selection: selectMentions(input) }));
}
