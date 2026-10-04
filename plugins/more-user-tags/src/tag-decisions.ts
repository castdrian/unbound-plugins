import {
	getContrastingTextColor,
	getRoleColorAppearance,
	type RoleColorAppearance,
	type RoleColorStops,
} from '@more-user-tags/role-colors';

export type PermissionName =
	| 'ADMINISTRATOR'
	| 'MANAGE_GUILD'
	| 'MANAGE_CHANNELS'
	| 'MANAGE_ROLES'
	| 'MANAGE_WEBHOOKS'
	| 'MANAGE_MESSAGES'
	| 'KICK_MEMBERS'
	| 'BAN_MEMBERS'
	| 'MOVE_MEMBERS'
	| 'MUTE_MEMBERS'
	| 'DEAFEN_MEMBERS';

export type TagDefinition = {
	color: string;
	description: string;
	displayName: string;
	name: string;
	permissions?: PermissionName[];
};

export type TagDecisionInput = {
	bot: boolean;
	coloredTags: boolean;
	enabled: Record<string, boolean>;
	enhancedRoleColors: boolean;
	guildOwnerId?: string;
	id: string;
	memberColor?: string;
	memberColors?: RoleColorStops;
	opTagText?: string | null;
	permissions: PermissionName[];
	useOpTagStyle: boolean;
	useRoleColor: boolean;
	userId?: string;
	webhookId?: string;
};

export type TagDecision = {
	appearance: RoleColorAppearance;
	background?: string;
	id: string;
	style: 'normal' | 'op';
	tagText: string;
	textColor?: string;
};

export const TAGS: TagDefinition[] = [
	{
		name: 'WEBHOOK',
		color: '#5865F2',
		displayName: 'Webhook',
		description: 'Messages sent by webhooks',
	},
	{ name: 'OWNER', color: '#F0B232', displayName: 'Owner', description: 'Owns the server' },
	{
		name: 'ADMINISTRATOR',
		color: '#DA373C',
		displayName: 'Admin',
		description: 'Has the administrator permission',
		permissions: ['ADMINISTRATOR'],
	},
	{
		name: 'MODERATOR_STAFF',
		color: '#248046',
		displayName: 'Staff',
		description: 'Can manage the server, channels or roles',
		permissions: ['MANAGE_GUILD', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_WEBHOOKS'],
	},
	{
		name: 'MODERATOR',
		color: '#4E7FFF',
		displayName: 'Mod',
		description: 'Can manage messages or kick/ban people',
		permissions: ['MANAGE_MESSAGES', 'KICK_MEMBERS', 'BAN_MEMBERS'],
	},
	{
		name: 'VOICE_MODERATOR',
		color: '#059669',
		displayName: 'VC Mod',
		description: 'Can manage voice chats',
		permissions: ['MOVE_MEMBERS', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS'],
	},
];

export function decideTag(input: TagDecisionInput): TagDecision | null {
	const tag = TAGS.find((candidate) => {
		if (input.enabled[candidate.name] === false) return false;
		if (candidate.name === 'WEBHOOK') return Boolean(input.webhookId) && input.bot;
		if (candidate.name === 'OWNER')
			return Boolean(input.guildOwnerId) && input.guildOwnerId === input.userId;
		return (
			!input.bot &&
			Boolean(candidate.permissions?.some((permission) => input.permissions.includes(permission)))
		);
	});
	if (!tag) return null;
	const roleAppearance = input.useRoleColor
		? getRoleColorAppearance(input.memberColors, input.memberColor, input.enhancedRoleColors)
		: { colors: [], style: 'solid' as const };
	const appearance: RoleColorAppearance =
		roleAppearance.colors.length > 0
			? roleAppearance
			: { colors: input.coloredTags ? [tag.color] : [], style: 'solid' };
	const background = appearance.colors[0];
	return {
		appearance,
		background,
		id: input.id,
		style: input.useOpTagStyle ? 'op' : 'normal',
		tagText: input.opTagText ? `${input.opTagText} · ${tag.displayName}` : tag.displayName,
		textColor: background ? getContrastingTextColor(appearance.colors) : undefined,
	};
}

export function decideTagBatch(inputs: TagDecisionInput[]): Array<TagDecision | null> {
	return inputs.map(decideTag);
}
