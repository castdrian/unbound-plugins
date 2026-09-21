import type {
	NativeHookToken,
	NativeObjCBridge,
	NativeObjectHandle,
	PluginContext,
} from '@unbound-app/api/native';
import { metro, patcher, storage } from '@unbound-app/api';

const ADDON_ID = 'unbound.mention-avatars';
const STORE = storage.getStore(ADDON_ID);
const MENTION_PLACEHOLDER = '\uFFFC';
const ROLE_IMAGE_NAME = 'person.2.fill';

type NativeValue = any;

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

type HighlightedRange = {
	index: number;
	length: number;
	text: string;
};

let unpatch: (() => void) | null = null;
let users: { getUser?: (id: string) => User | undefined } | null = null;
let members: { getMember?: (guildId: string, userId: string) => { nick?: string } | undefined } | null = null;
let channels: { getChannel?: (channelId: string) => { guild_id?: string; guildId?: string } | undefined } | null = null;
let roles: {
	getRole?: (guildId: string, roleId: string) => { icon?: string | null; id: string; name?: string } | undefined;
	getSortedRoles?: (guildId: string) => unknown[];
} | null = null;
let objc: NativeObjCBridge | null = null;
let originalTextKey: NativeValue | null = null;
let messageTextKey: NativeValue | null = null;
let pendingRenderKey: NativeValue | null = null;
let hookTokens: NativeHookToken[] = [];
let activeCells = new Map<string, NativeValue>();
const pendingCells = new Set<string>();
const imageCache = new Map<string, ImageCacheEntry>();
const messageMentionIndex = new Map<string, Mention[]>();

function pngURL(url: string): string {
	const png = url.replace(/\.webp(?=\?|$)/, '.png');
	if (/[?&]size=\d+/.test(png)) return png.replace(/([?&]size=)\d+/, (_, prefix: string) => `${prefix}32`);
	return `${png}${png.includes('?') ? '&' : '?'}size=32`;
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

function roleImage(color: NativeValue): NativeValue | null {
	if (!objc) return null;
	const imageClass = objc.getClass('UIImage');
	const image = imageClass ? objc.call(imageClass, 'systemImageNamed:', ROLE_IMAGE_NAME) : null;
	if (!image) return null;
	const colorClass = objc.getClass('UIColor');
	const tint = color ?? (colorClass ? objc.call(colorClass, 'labelColor') : null);
	if (!tint || !objc.respondsTo(image, 'imageWithTintColor:')) return image;
	const tinted = objc.call(image, 'imageWithTintColor:', tint) ?? image;
	const ciImageClass = objc.getClass('CIImage');
	const ciColorClass = objc.getClass('CIColor');
	const contextClass = objc.getClass('CIContext');
	const filterClass = objc.getClass('CIFilter');
	const vectorClass = objc.getClass('CIVector');
	const sourceCGImage = objc.call(image, 'CGImage');
	const cgColor = objc.call(tint, 'CGColor');
	if (!ciImageClass || !ciColorClass || !contextClass || !filterClass || !vectorClass || !sourceCGImage || !cgColor) {
		return tinted;
	}
	const source = objc.call(ciImageClass, 'imageWithCGImage:', sourceCGImage);
	const ciColor = objc.call(ciColorClass, 'colorWithCGColor:', cgColor);
	const matrix = objc.call(filterClass, 'filterWithName:', 'CIColorMatrix');
	if (!source || !ciColor || !matrix) return tinted;
	const zero = objc.call(vectorClass, 'vectorWithX:Y:Z:W:', 0, 0, 0, 0);
	const alpha = objc.call(vectorClass, 'vectorWithX:Y:Z:W:', 0, 0, 0, 1);
	const bias = objc.call(
		vectorClass,
		'vectorWithX:Y:Z:W:',
		asNumber(objc.call(ciColor, 'red')),
		asNumber(objc.call(ciColor, 'green')),
		asNumber(objc.call(ciColor, 'blue')),
		0,
	);
	if (!zero || !alpha || !bias) return tinted;
	objc.call(matrix, 'setValue:forKey:', source, 'inputImage');
	objc.call(matrix, 'setValue:forKey:', zero, 'inputRVector');
	objc.call(matrix, 'setValue:forKey:', zero, 'inputGVector');
	objc.call(matrix, 'setValue:forKey:', zero, 'inputBVector');
	objc.call(matrix, 'setValue:forKey:', alpha, 'inputAVector');
	objc.call(matrix, 'setValue:forKey:', bias, 'inputBiasVector');
	const output = objc.call(matrix, 'outputImage');
	const context = objc.call(contextClass, 'contextWithOptions:', null);
	const rect = objc.struct('CGRect', {
		origin: { x: 0, y: 0 },
		size: { width: 32, height: 32 },
	});
	const cgImage = output && context && objc.call(context, 'createCGImage:fromRect:', output, rect);
	if (!cgImage) return tinted;
	return objc.call(imageClass, 'imageWithCGImage:scale:orientation:', cgImage, 2, 0) ?? tinted;
}

function roundedImage(image: NativeValue): NativeValue | null {
	if (!objc || !image) return image;
	const imageClass = objc.getClass('UIImage');
	const ciImageClass = objc.getClass('CIImage');
	const contextClass = objc.getClass('CIContext');
	const filterClass = objc.getClass('CIFilter');
	const colorClass = objc.getClass('CIColor');
	const vectorClass = objc.getClass('CIVector');
	if (!imageClass || !ciImageClass || !contextClass || !filterClass || !colorClass || !vectorClass) return image;
	const sourceCGImage = objc.call(image, 'CGImage');
	if (!sourceCGImage) return image;
	const source = objc.call(ciImageClass, 'imageWithCGImage:', sourceCGImage);
	const mask = objc.call(filterClass, 'filterWithName:', 'CIRadialGradient');
	if (!source || !mask) return image;
	const white = objc.call(colorClass, 'colorWithRed:green:blue:alpha:', 1, 1, 1, 1);
	const clear = objc.call(colorClass, 'colorWithRed:green:blue:alpha:', 0, 0, 0, 0);
	const center = objc.call(vectorClass, 'vectorWithX:Y:', 16, 16);
	if (!white || !clear || !center) return image;
	objc.call(mask, 'setValue:forKey:', center, 'inputCenter');
	objc.call(mask, 'setValue:forKey:', 15.5, 'inputRadius0');
	objc.call(mask, 'setValue:forKey:', 16, 'inputRadius1');
	objc.call(mask, 'setValue:forKey:', white, 'inputColor0');
	objc.call(mask, 'setValue:forKey:', clear, 'inputColor1');
	const maskImage = objc.call(mask, 'outputImage');
	const blend = objc.call(filterClass, 'filterWithName:', 'CIBlendWithMask');
	if (!maskImage || !blend) return image;
	objc.call(blend, 'setValue:forKey:', source, 'inputImage');
	objc.call(blend, 'setValue:forKey:', maskImage, 'inputMaskImage');
	const output = objc.call(blend, 'outputImage');
	if (!output) return image;
	const rect = objc.struct('CGRect', {
		origin: { x: 0, y: 0 },
		size: { width: 32, height: 32 },
	});
	const context = objc.call(contextClass, 'contextWithOptions:', null);
	const cgImage = context && objc.call(context, 'createCGImage:fromRect:', output, rect);
	if (!cgImage) return image;
	return objc.call(imageClass, 'imageWithCGImage:scale:orientation:', cgImage, 2, objc.call(image, 'imageOrientation') ?? 0) ?? image;
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

function cellKey(cell: NativeValue): string | undefined {
	if (!objc) return;
	const className = objc.className(cell) ?? '';
	if (objc.respondsTo(cell, 'hash')) return `${className}:${String(objc.call(cell, 'hash'))}`;
	if (!objc.respondsTo(cell, 'description')) return;
	const description = objc.call(cell, 'description');
	return typeof description === 'string' ? `${className}:${description}` : undefined;
}

function range(location: number, length: number): NativeValue {
	return objc?.struct('NSRange', { location, length });
}

function attributes(original: NativeValue, index: number): NativeValue {
	return objc?.call(original, 'attributesAtIndex:effectiveRange:', index, null);
}

function nextHighlightedRange(value: NativeValue, string: string, start: number): HighlightedRange | null {
	if (!objc) return null;
	for (let index = start; index < string.length; index++) {
		const values = attributes(value, index);
		if (!values?.YYTextHighlight) continue;
		let end = index + 1;
		while (end < string.length) {
			const nextValues = attributes(value, end);
			if (!nextValues?.YYTextHighlight) break;
			end++;
		}
		return { index, length: end - index, text: string.slice(index, end) };
	}
	return null;
}

function imageForMention(metadata: Mention, color: NativeValue): NativeValue | null {
	if (!objc) return null;
	if (!metadata.avatarURL) {
		if (metadata.type !== 'role') return null;
		return roleImage(color);
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
				const image = imageClass ? objc.call(imageClass, 'imageWithData:', data) : null;
				return image ? roundedImage(image) : null;
			})
			.catch(() => null);
		imageCache.set(metadata.avatarURL, { image: null, pending });
		pending.then((image) => {
			imageCache.set(metadata.avatarURL!, { image });
			for (const cell of activeCells.values()) scheduleCellRender(cell);
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
		if (objc.respondsTo(runDelegate, 'CTRunDelegate')) {
			const coreTextRunDelegate = objc.call(runDelegate, 'CTRunDelegate');
			if (coreTextRunDelegate) {
				objc.call(result, 'addAttribute:value:range:', 'CTRunDelegate', coreTextRunDelegate, range(0, 1));
			}
		}
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
	const result = objc.call(original, 'mutableCopy');
	if (!result) return original;
	let searchIndex = 0;
	const remaining = mentions.map((metadata, index) => ({ index, metadata }));

	while (remaining.length > 0) {
		const string = objc.call(result, 'string');
		if (typeof string !== 'string' || searchIndex >= string.length) break;
		const highlighted = nextHighlightedRange(result, string, searchIndex);
		if (!highlighted) break;
		if (!highlighted.text.includes('@')) {
			searchIndex = highlighted.index + highlighted.length;
			continue;
		}
		let bestMetadataIndex = -1;
		let bestIndex = -1;
		let bestText = '';
		for (let metadataIndex = 0; metadataIndex < remaining.length; metadataIndex++) {
			for (const label of remaining[metadataIndex].metadata.labels) {
				const mentionText = `@${label}`;
				const index = highlighted.text.indexOf(mentionText);
				const absoluteIndex = index === -1 ? -1 : highlighted.index + index;
				if (
					absoluteIndex !== -1 &&
					(bestIndex === -1 ||
						absoluteIndex < bestIndex ||
						(absoluteIndex === bestIndex && mentionText.length > bestText.length))
				) {
					bestMetadataIndex = metadataIndex;
					bestIndex = absoluteIndex;
					bestText = mentionText;
				}
			}
		}
		if (bestIndex === -1) {
			searchIndex = highlighted.index + highlighted.length;
			continue;
		}
		const [{ metadata }] = remaining.splice(bestMetadataIndex, 1);
		const values = attributes(result, bestIndex);
		if (!values?.YYTextHighlight) {
			searchIndex = highlighted.index + highlighted.length;
			continue;
		}
		const image = imageForMention(metadata, values.NSColor);
		if (!image) {
			searchIndex = highlighted.index + highlighted.length;
			continue;
		}
		const text = STORE.get('showAtSymbol', true) ? bestText : bestText.slice(1);
		const replacement = attributedMention(text, metadata, values, image);
		objc.call(
			result as NativeObjectHandle,
			'replaceCharactersInRange:withAttributedString:',
			range(bestIndex, bestText.length),
			replacement,
		);
		searchIndex = bestIndex + asNumber(objc.call(replacement, 'length'));
	}

	return result;
}

function textViewsInView(view: NativeValue): NativeValue[] {
	if (!objc) return [];
	const views: NativeValue[] = [];
	if (objc.respondsTo(view, 'setAttributedText:') && objc.respondsTo(view, 'attributedText')) views.push(view);
	if (!objc.respondsTo(view, 'subviews')) return views;
	const children = objc.call(view, 'subviews');
	if (!Array.isArray(children)) return views;
	for (const child of children) views.push(...textViewsInView(child));
	return views;
}

function restoreTextView(view: NativeValue): void {
	if (!objc || !originalTextKey || !messageTextKey) return;
	const original = objc.getAssociatedObject(view, originalTextKey);
	if (original) objc.call(view, 'setAttributedText:', original);
	objc.setAssociatedObject(view, originalTextKey, null, 'retainNonatomic');
	objc.setAssociatedObject(view, messageTextKey, null, 'retainNonatomic');
}

function updateTextView(view: NativeValue, messageID: string | undefined, mentions: Mention[]): boolean {
	if (!objc || !originalTextKey || !messageTextKey || !messageID || mentions.length === 0) {
		restoreTextView(view);
		return false;
	}
	const storedMessageID = objc.getAssociatedObject(view, messageTextKey);
	if (storedMessageID && storedMessageID !== messageID) restoreTextView(view);
	let original = objc.getAssociatedObject(view, originalTextKey);
	if (!original) {
		original = objc.call(view, 'attributedText');
		if (!original || asNumber(objc.call(original, 'length')) === 0) return false;
		objc.setAssociatedObject(view, originalTextKey, original, 'retainNonatomic');
	}
	const updated = mentionAvatarText(original, mentions);
	if (!updated) return false;
	objc.setAssociatedObject(view, messageTextKey, messageID, 'retainNonatomic');
	const current = objc.call(view, 'attributedText');
	if (current && objc.call(updated, 'isEqual:', current)) return false;
	objc.call(view, 'setAttributedText:', updated);
	return true;
}

function clearCell(cell: NativeValue): void {
	for (const view of textViewsInView(cell)) restoreTextView(view);
	if (objc) objc.call(cell, 'setNeedsLayout');
	const key = cellKey(cell);
	if (key) {
		activeCells.delete(key);
		pendingCells.delete(key);
	}
	if (objc && pendingRenderKey) objc.setAssociatedObject(cell, pendingRenderKey, null, 'retainNonatomic');
}

function renderCell(cell: NativeValue): void {
	if (!objc) return;
	const key = cellKey(cell);
	if (key) activeCells.set(key, cell);
	const id = messageIDForCell(cell);
	const mentions = id ? messageMentionIndex.get(id) ?? [] : [];
	let changed = false;
	for (const view of textViewsInView(cell)) changed ||= updateTextView(view, id, mentions);
	if (changed) objc.call(cell, 'setNeedsLayout');
}

function scheduleCellRender(cell: NativeValue): void {
	if (!objc || !pendingRenderKey) return;
	const key = cellKey(cell);
	if (!key || pendingCells.has(key)) return;
	const bridge = objc;
	const associationKey = pendingRenderKey;
	pendingCells.add(key);
	bridge.setAssociatedObject(cell, associationKey, cell, 'retainNonatomic');
	setTimeout(() => {
		pendingCells.delete(key);
		if (objc !== bridge) return;
		const retainedCell = bridge.getAssociatedObject(cell, associationKey) ?? cell;
		bridge.setAssociatedObject(cell, associationKey, null, 'retainNonatomic');
		renderCell(retainedCell);
	}, 0);
}

function installNativeHooks(): void {
	if (!objc) return;
	const lifecycle = objc.hook('DCDMessageTableViewCell', 'didMoveToWindow', {
		after: ({ self }) => scheduleCellRender(self),
	});
	const layout = objc.hook('DCDMessageTableViewCell', 'layoutSubviews', {
		after: ({ self }) => scheduleCellRender(self),
	});
	const reuse = objc.hook('DCDMessageTableViewCell', 'prepareForReuse', { after: ({ self }) => clearCell(self) });
	hookTokens = [lifecycle, layout, reuse];
}

function start(context?: PluginContext): void {
	objc = context?.native.objc ?? null;
	if (!objc) return;
	originalTextKey = objc.createAssociationKey();
	messageTextKey = objc.createAssociationKey();
	pendingRenderKey = objc.createAssociationKey();
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
	for (const cell of activeCells.values()) clearCell(cell);
	activeCells.clear();
	users = null;
	members = null;
	channels = null;
	roles = null;
	objc = null;
	originalTextKey = null;
	messageTextKey = null;
	pendingRenderKey = null;
	pendingCells.clear();
	imageCache.clear();
	messageMentionIndex.clear();
}

export default { start, stop };
