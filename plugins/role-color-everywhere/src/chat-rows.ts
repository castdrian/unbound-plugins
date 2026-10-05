import { getRoleColorAppearance, type RoleColorStops } from '@shared/role-colors';

export interface Member {
	colorString?: string | null;
	colorStrings?: RoleColorStops | null;
}

export interface MemberStore {
	getMember(guildId: string, userId: string): Member | null | undefined;
}

export interface ChatColorOptions {
	chatMentions: boolean;
	colorChatMessages: boolean;
	messageSaturation: number;
}

export interface ContentNode {
	type?: string;
	userId?: string;
	guildId?: string;
	content?: unknown;
	items?: unknown;
	color?: number;
	roleColor?: number;
	roleColors?: Record<string, number>;
	colorString?: string;
}

export interface ChatMessage {
	authorId?: string;
	content?: unknown;
	embeds?: { description?: unknown }[];
	guildId?: string;
	referencedMessage?: { message?: ChatMessage };
	state?: string;
	textColor?: number;
}

export interface ChatRow {
	message?: ChatMessage;
}

export function hexToArgb(hex: string): number | null {
	if (!/^#[\da-f]{6}$/i.test(hex)) return null;
	return (0xff000000 | Number.parseInt(hex.slice(1), 16)) >>> 0;
}

export function blendArgb(base: number, role: number, saturation: number): number {
	const ratio = Math.min(100, Math.max(0, saturation)) / 100;
	const alpha = base & 0xff000000;
	const red = Math.round(((base >>> 16) & 0xff) * (1 - ratio) + ((role >>> 16) & 0xff) * ratio);
	const green = Math.round(((base >>> 8) & 0xff) * (1 - ratio) + ((role >>> 8) & 0xff) * ratio);
	const blue = Math.round((base & 0xff) * (1 - ratio) + (role & 0xff) * ratio);
	return (alpha | (red << 16) | (green << 8) | blue) >>> 0;
}

export function memberColorNumbers(member: Member | null | undefined): number[] {
	if (!member) return [];
	return getRoleColorAppearance(member.colorStrings, member.colorString)
		.colors.map(hexToArgb)
		.filter((value): value is number => value !== null);
}

function applyMentionColors(
	content: unknown,
	members: MemberStore,
	defaultGuildId: string | undefined,
): void {
	if (!Array.isArray(content)) return;
	const pending: unknown[] = [...content];
	const visited = new Set<object>();
	let count = 0;

	while (pending.length > 0 && count < 400) {
		const value = pending.pop();
		if (!value || typeof value !== 'object' || visited.has(value)) continue;
		visited.add(value);
		count++;
		const node = value as ContentNode;
		if (node.type === 'mention' && typeof node.userId === 'string') {
			const guildId = node.guildId ?? defaultGuildId;
			const colors = guildId ? memberColorNumbers(members.getMember(guildId, node.userId)) : [];
			if (colors.length > 0) {
				node.roleColor = colors[0];
				node.color = colors[0];
				node.colorString = `#${(colors[0] & 0xffffff).toString(16).padStart(6, '0')}`;
				node.roleColors = {
					primaryColor: colors[0],
					...(colors[1] != null ? { secondaryColor: colors[1] } : {}),
					...(colors[2] != null ? { tertiaryColor: colors[2] } : {}),
				};
			}
		}
		if (Array.isArray(node.content)) pending.push(...node.content);
		if (Array.isArray(node.items)) pending.push(...node.items);
	}
}

function applyMessageColors(message: ChatMessage, members: MemberStore, saturation: number): void {
	if (!message.guildId || !message.authorId || message.state === 'SEND_FAILED') return;
	if (typeof message.textColor !== 'number' || saturation <= 0) return;
	const [color] = memberColorNumbers(members.getMember(message.guildId, message.authorId));
	if (color === undefined) return;
	message.textColor = blendArgb(message.textColor, color, saturation);
}

export function applyChatRoleColors(
	row: ChatRow,
	members: MemberStore,
	options: ChatColorOptions,
): void {
	const message = row.message;
	if (!message) return;
	if (options.chatMentions) {
		applyMentionColors(message.content, members, message.guildId);
		for (const embed of message.embeds ?? []) {
			applyMentionColors(embed.description, members, message.guildId);
		}
		const referenced = message.referencedMessage?.message;
		if (referenced) applyMentionColors(referenced.content, members, referenced.guildId);
	}
	if (options.colorChatMessages) applyMessageColors(message, members, options.messageSaturation);
}
