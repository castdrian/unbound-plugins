import { metro, patcher, storage } from '@unbound-app/api';

const ADDON_ID = 'unbound.mention-avatars';
const STORE = storage.getStore(ADDON_ID);
const MENTION_PLACEHOLDER = '\uFFFC';
const ROLE_IMAGE_NAME = 'person.2';

type NativeValue = any;

type NativeHookContext = {
	self: NativeValue;
	selector: string;
	args: NativeValue[];
};

type NativeHookToken = {
	remove(): void;
};

type NativeObjC = {
	getClass(name: string): NativeValue | null;
	alloc(classOrName: string | NativeValue): NativeValue;
	respondsTo(handle: NativeValue, selector: string): boolean;
	call(handle: NativeValue, selector: string, ...args: NativeValue[]): NativeValue;
	getIvar(handle: NativeValue, name: string): NativeValue;
	createAssociationKey(): NativeValue;
	getAssociatedObject(handle: NativeValue, key: NativeValue): NativeValue;
	setAssociatedObject(handle: NativeValue, key: NativeValue, value: NativeValue, policy?: string): void;
	struct(name: string, fields: NativeValue): NativeValue;
	array(handle: NativeValue): NativeValue[];
	data(value: ArrayBuffer | Uint8Array): NativeValue;
	hook(
		className: string,
		selector: string,
		handlers: { after(context: NativeHookContext): void },
	): NativeHookToken;
};

type NativePluginContext = {
	native: {
		objc: NativeObjC;
	};
};

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

type ImageCacheEntry = {
	image: NativeValue | null;
	pending?: Promise<NativeValue | null>;
};

let unpatch: (() => void) | null = null;
let users: { getUser?: (id: string) => User | undefined } | null = null;
let members: { getMember?: (guildId: string, userId: string) => { nick?: string } | undefined } | null = null;
let channels: { getChannel?: (channelId: string) => { guild_id?: string; guildId?: string } | undefined } | null = null;
let roles: {
	getRole?: (guildId: string, roleId: string) => { icon?: string | null; id: string; name?: string } | undefined;
	getSortedRoles?: (guildId: string) => unknown[];
} | null = null;
let objc: NativeObjC | null = null;
let originalTextKey: NativeValue | null = null;
let hookTokens: NativeHookToken[] = [];
let activeCells = new Set<NativeValue>();
const imageCache = new Map<string, ImageCacheEntry>();
const messageMentionIndex = new Map<string, Mention[]>();

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
	if (typeof content !== 'string') return mentions;

	for (const match of content.matchAll(/<@!?([0-9]+)>|<@&([0-9]+)>/g)) {
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

function hydrateMentions(): void {
	const channelId = metro.findByProps('getChannelId')?.getChannelId?.();
	const messages = metro.findStore('Message')?.getMessages?.(channelId)?._array;
	if (!Array.isArray(messages)) return;
	for (const message of messages) addMentions(message);
}

function asNumber(value: NativeValue): number {
	if (typeof value === 'bigint') return Number(value);
	return typeof value === 'number' ? value : Number(value) || 0;
}

function messageIDForCell(cell: NativeValue): string | undefined {
	if (!objc) return;
	const viewModel = objc.getIvar(cell, 'viewModel');
	if (!viewModel || !objc.respondsTo(viewModel, 'message')) return;
	const message = objc.call(viewModel, 'message');
	if (!message || !objc.respondsTo(message, 'id')) return;
	const id = objc.call(message, 'id');
	if (typeof id === 'string') return id;
	if (id && objc.respondsTo(id, 'description')) return String(objc.call(id, 'description'));
}

function range(location: number, length: number): NativeValue {
	return objc?.struct('NSRange', { location, length });
}

function attribute(original: NativeValue, name: string, index: number): NativeValue {
	return objc?.call(original, 'attribute:atIndex:effectiveRange:', name, index, null);
}

function imageForMention(metadata: Mention, color: NativeValue): NativeValue | null {
	if (!objc) return null;
	if (!metadata.avatarURL) {
		if (metadata.type !== 'role') return null;
		const imageClass = objc.getClass('UIImage');
		return imageClass ? objc.call(imageClass, 'systemImageNamed:', ROLE_IMAGE_NAME) : null;
	}

	const cached = imageCache.get(metadata.avatarURL);
	if (cached?.image) return cached.image;
	if (!cached?.pending) {
		const pending = fetch(metadata.avatarURL)
			.then((response) => (response.ok ? response.arrayBuffer() : null))
			.then((bytes) => {
				if (!bytes || !objc) return null;
				const data = objc.data(bytes);
				const imageClass = objc.getClass('UIImage');
				return imageClass ? objc.call(imageClass, 'imageWithData:', data) : null;
			})
			.catch(() => null);
		imageCache.set(metadata.avatarURL, { image: null, pending });
		pending.then((image) => {
			imageCache.set(metadata.avatarURL!, { image });
			for (const cell of activeCells) renderCell(cell);
		});
	}
	return null;
}

function imageAttachment(image: NativeValue, metadata: Mention, attributes: NativeValue): NativeValue | null {
	if (!objc) return null;
	const attachmentClass = objc.getClass('YYTextAttachment');
	if (!attachmentClass) return null;
	const attachment = objc.alloc(attachmentClass);
	const size = 16;
	const leading = metadata.type === 'role' ? 4 : 2;
	const trailing = metadata.type === 'role' ? 2 : 4;
	const insets = objc.struct('UIEdgeInsets', { top: 0, left: leading, bottom: 0, right: trailing });
	objc.call(attachment, 'setValue:forKey:', image, 'content');
	objc.call(attachment, 'setValue:forKey:', 1, 'contentMode');
	objc.call(attachment, 'setValue:forKey:', insets, 'contentInsets');

	const result = objc.alloc('NSMutableAttributedString');
	objc.call(result, 'initWithString:attributes:', MENTION_PLACEHOLDER, attributes);
	objc.call(result, 'addAttribute:value:range:', 'YYTextAttachment', attachment, range(0, 1));
	const runDelegateClass = objc.getClass('YYTextRunDelegate');
	const font = attributes?.NSFont;
	if (runDelegateClass && font) {
		const runDelegate = objc.alloc(runDelegateClass);
		const ascent = asNumber(objc.call(font, 'ascender'));
		const descent = asNumber(objc.call(font, 'descender'));
		objc.call(runDelegate, 'setValue:forKey:', ascent, 'ascent');
		objc.call(runDelegate, 'setValue:forKey:', -descent, 'descent');
		objc.call(runDelegate, 'setValue:forKey:', leading + size + trailing, 'width');
	}
	return result;
}

function attributedMention(text: string, metadata: Mention, attributes: NativeValue, image: NativeValue): NativeValue {
	if (!objc) return null;
	const mentionClass = objc.alloc('NSAttributedString');
	objc.call(mentionClass, 'initWithString:attributes:', text, attributes);
	const avatar = imageAttachment(image, metadata, attributes);
	if (!avatar) return mentionClass;
	const replacement = objc.alloc('NSMutableAttributedString');
	objc.call(replacement, 'init');
	if (metadata.type === 'role') {
		objc.call(replacement, 'appendAttributedString:', mentionClass);
		objc.call(replacement, 'appendAttributedString:', avatar);
	} else {
		objc.call(replacement, 'appendAttributedString:', avatar);
		objc.call(replacement, 'appendAttributedString:', mentionClass);
	}
	return replacement;
}

function mentionAvatarText(original: NativeValue, mentions: Mention[]): NativeValue {
	if (!objc || mentions.length === 0) return original;
	const string = objc.call(original, 'string');
	if (typeof string !== 'string' || string.length === 0) return original;
	const result = objc.call(original, 'mutableCopy');
	let searchIndex = 0;

	for (const metadata of mentions) {
		let bestIndex = -1;
		let bestText = '';
		for (const label of metadata.labels) {
			const mentionText = `@${label}`;
			const index = string.indexOf(mentionText, searchIndex);
			if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
				bestIndex = index;
				bestText = mentionText;
			}
		}
		if (bestIndex === -1) continue;
		const attributes = attribute(original, 'YYTextHighlight', bestIndex);
		if (!attributes) {
			searchIndex = bestIndex + bestText.length;
			continue;
		}
		const foreground = attribute(original, 'NSForegroundColor', bestIndex);
		const font = attribute(original, 'NSFont', bestIndex);
		const image = imageForMention(metadata, foreground);
		if (!image) {
			searchIndex = bestIndex + bestText.length;
			continue;
		}
		const values = { YYTextHighlight: attributes, NSForegroundColor: foreground, NSFont: font };
		const text = STORE.get('showAtSymbol', true) ? bestText : bestText.slice(1);
		const replacement = attributedMention(text, metadata, values, image);
		objc.call(result, 'replaceCharactersInRange:withAttributedString:', range(bestIndex, bestText.length), replacement);
		searchIndex = bestIndex + asNumber(objc.call(replacement, 'length'));
	}

	return result;
}

function textViewsInView(view: NativeValue): NativeValue[] {
	if (!objc) return [];
	const views: NativeValue[] = [];
	if (objc.respondsTo(view, 'setAttributedText:') && objc.respondsTo(view, 'attributedText')) views.push(view);
	if (!objc.respondsTo(view, 'subviews')) return views;
	for (const child of objc.array(objc.call(view, 'subviews'))) views.push(...textViewsInView(child));
	return views;
}

function restoreTextView(view: NativeValue): void {
	if (!objc || !originalTextKey) return;
	const original = objc.getAssociatedObject(view, originalTextKey);
	if (!original) return;
	objc.call(view, 'setAttributedText:', original);
	objc.setAssociatedObject(view, originalTextKey, null, 'retainNonatomic');
}

function updateTextView(view: NativeValue, mentions: Mention[]): void {
	if (!objc || !originalTextKey) return;
	if (mentions.length === 0) {
		restoreTextView(view);
		return;
	}
	let original = objc.getAssociatedObject(view, originalTextKey);
	if (!original) {
		original = objc.call(view, 'attributedText');
		if (!original || asNumber(objc.call(original, 'length')) === 0) return;
		objc.setAssociatedObject(view, originalTextKey, original, 'retainNonatomic');
	}
	const updated = mentionAvatarText(original, mentions);
	if (updated) objc.call(view, 'setAttributedText:', updated);
}

function clearCell(cell: NativeValue): void {
	for (const view of textViewsInView(cell)) restoreTextView(view);
	activeCells.delete(cell);
}

function renderCell(cell: NativeValue): void {
	if (!objc) return;
	activeCells.add(cell);
	const id = messageIDForCell(cell);
	const mentions = id ? messageMentionIndex.get(id) ?? [] : [];
	for (const view of textViewsInView(cell)) updateTextView(view, mentions);
}

function installNativeHooks(): void {
	if (!objc) return;
	const layout = objc.hook('DCDMessageTableViewCell', 'layoutSubviews', { after: ({ self }) => renderCell(self) });
	const reuse = objc.hook('DCDMessageTableViewCell', 'prepareForReuse', { after: ({ self }) => clearCell(self) });
	hookTokens = [layout, reuse];
}

function start(context?: NativePluginContext): void {
	objc = context?.native.objc ?? null;
	if (!objc) return;
	originalTextKey = objc.createAssociationKey();
	users = metro.findByProps('getCurrentUser', 'getUser');
	members = metro.findStore('GuildMember');
	channels = metro.findByProps('getChannel');
	roles = metro.find(
		(module) => typeof module?.getRole === 'function' && typeof module?.getSortedRoles === 'function',
	);

	const target = metro.findByProps('generateMessageRowData');
	if (typeof target?.generateMessageRowData !== 'function') return;
	unpatch = patcher.after(target, 'generateMessageRowData', (ctx) => {
		addMentions(ctx.args[0]?.message);
	});
	hydrateMentions();
	installNativeHooks();
}

function stop(): void {
	unpatch?.();
	unpatch = null;
	for (const token of hookTokens) token.remove();
	hookTokens = [];
	for (const cell of activeCells) clearCell(cell);
	activeCells = new Set();
	users = null;
	members = null;
	channels = null;
	roles = null;
	objc = null;
	originalTextKey = null;
	imageCache.clear();
	messageMentionIndex.clear();
}

export default { start, stop };
