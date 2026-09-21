import type {
	NativeHookToken,
	NativeObjCBridge,
	NativeObjectHandle,
	PluginContext,
} from '@unbound-app/api/native';
import { metro, patcher, storage } from '@unbound-app/api';

import type { ImageCacheEntry, Mention } from '@mention-avatars/logic';
import {
	cellRenderDecision,
	containsMentionText,
	extractMentionTokens,
	imageCacheAction,
	mentionImageMetrics,
	roleImageSource,
	selectMentionLabel,
} from '@mention-avatars/logic';

const ADDON_ID = 'unbound.mention-avatars';
const STORE = storage.getStore(ADDON_ID);
const MENTION_PLACEHOLDER = '\uFFFC';
const ROLE_IMAGE_NAME = 'person.2.fill';

type NativeValue = any;

type User = {
	avatar?: string | null;
	getAvatarURL?: (guildId?: string | null, size?: number, animated?: boolean) => string;
	globalName?: string | null;
	id: string;
	username?: string;
};

type HighlightedRange = {
	index: number;
	length: number;
	text: string;
};

type CollectedMentions = {
	complete: boolean;
	mentions: Mention[];
};

type TextViewState = {
	messageID: string;
	original: NativeValue;
	originalString: string;
};

let unpatch: (() => void) | null = null;
let users: { getUser?: (id: string) => User | undefined } | null = null;
let members: {
	getMember?: (guildId: string, userId: string) => { nick?: string } | undefined;
} | null = null;
let channels: {
	getChannel?: (channelId: string) => { guild_id?: string; guildId?: string } | undefined;
} | null = null;
let roles: {
	getRole?: (
		guildId: string,
		roleId: string,
	) => { color?: number; icon?: string | null; id: string; name?: string } | undefined;
	getSortedRoles?: (guildId: string) => unknown[];
} | null = null;
let objc: NativeObjCBridge | null = null;
let hookTokens: NativeHookToken[] = [];
let activeCells = new Map<string, NativeValue>();
const pendingCells = new Set<string>();
const pendingCellRefs = new Map<string, NativeValue>();
const imageCache = new Map<string, ImageCacheEntry>();
const messageMentionIndex = new Map<string, Mention[]>();
const unresolvedMessageIDs = new Set<string>();
const textViewStates = new Map<string, TextViewState>();
let hydratedMessageKey: string | null = null;
let lifecycleToken = 0;

function nativeCall(handle: NativeValue, selector: string, ...args: NativeValue[]): NativeValue {
	if (!objc) return null;
	try {
		return objc.invoke(handle, selector, args, { thread: 'main' });
	} catch {
		return null;
	}
}

function pngURL(url: string): string {
	const png = url.replace(/\.webp(?=\?|$)/, '.png');
	if (/[?&]size=\d+/.test(png))
		return png.replace(/([?&]size=)\d+/, (_, prefix: string) => `${prefix}32`);
	return `${png}${png.includes('?') ? '&' : '?'}size=32`;
}

function userAvatarURL(user: User, guildId?: string): string | undefined {
	const resolved = user.getAvatarURL?.(guildId ?? null, 32, false);
	if (resolved) return pngURL(resolved);
	if (user.avatar)
		return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=32`;
	return undefined;
}

function userMention(userId: string, guildId?: string): Mention | undefined {
	const user = users?.getUser?.(userId);
	if (!user) return;

	const labels = [
		members?.getMember?.(guildId ?? '', userId)?.nick,
		user.globalName,
		user.username,
	].filter((label): label is string => Boolean(label));
	if (labels.length === 0) return;
	return { avatarURL: userAvatarURL(user, guildId), labels: [...new Set(labels)], type: 'user' };
}

function roleMention(roleId: string, guildId?: string): Mention | undefined {
	if (!guildId) return;
	const role =
		roles?.getRole?.(guildId, roleId) ??
		(roles?.getSortedRoles?.(guildId)?.find((candidate: any) => candidate?.id === roleId) as
			| { color?: number; icon?: string | null; id: string; name?: string }
			| undefined);
	if (!role?.name) return;

	const image = roleImageSource(role);
	return {
		avatarURL: image.avatarURL,
		labels: [role.name],
		roleColor: image.roleColor,
		type: 'role',
	};
}

function guildIdForMessage(message: any): string | undefined {
	const directGuildId = message?.guild_id ?? message?.guildId;
	if (directGuildId) return directGuildId;
	const channelId = message?.channel_id ?? message?.channelId;
	const channel = channelId ? channels?.getChannel?.(channelId) : undefined;
	return channel?.guild_id ?? channel?.guildId;
}

function collectMentions(message: any): CollectedMentions {
	const mentions: Mention[] = [];
	let complete = true;
	const guildId = guildIdForMessage(message);
	const content = message?.content;
	if (typeof content !== 'string') return { complete, mentions };

	for (const token of extractMentionTokens(content)) {
		const mention =
			token.type === 'user' ? userMention(token.id, guildId) : roleMention(token.id, guildId);
		if (mention) mentions.push(mention);
		else complete = false;
	}

	return { complete, mentions };
}

function addMentions(message: any): boolean {
	const id = message?.id;
	if (typeof id !== 'string') return false;
	const { complete, mentions } = collectMentions(message);
	if (!complete) {
		unresolvedMessageIDs.add(id);
		if (JSON.stringify(messageMentionIndex.get(id)) === JSON.stringify(mentions)) return false;
		messageMentionIndex.set(id, mentions);
		return true;
	}
	unresolvedMessageIDs.delete(id);
	if (JSON.stringify(messageMentionIndex.get(id)) === JSON.stringify(mentions)) return false;
	messageMentionIndex.set(id, mentions);
	return true;
}

function hydrateMentions(): void {
	const channelId = metro.findByProps('getChannelId')?.getChannelId?.();
	const messages = metro.findStore('Message')?.getMessages?.(channelId)?._array;
	if (!Array.isArray(messages)) return;
	const messageKey = `${channelId}:${messages.length}:${messages[messages.length - 1]?.id ?? ''}`;
	if (messageKey === hydratedMessageKey && unresolvedMessageIDs.size === 0) return;
	hydratedMessageKey = messageKey;
	for (const message of messages) addMentions(message);
}

function hydrateMessage(messageID: string | undefined): boolean {
	if (!messageID) return false;
	const channelId = metro.findByProps('getChannelId')?.getChannelId?.();
	const message = metro.findStore('Message')?.getMessage?.(channelId, messageID);
	if (!message) return false;
	addMentions(message);
	return true;
}

function asNumber(value: NativeValue): number {
	if (typeof value === 'bigint') return Number(value);
	return typeof value === 'number' ? value : Number(value) || 0;
}

function roleColor(value: number | undefined): NativeValue | null {
	if (!objc || value === undefined || value <= 0) return null;
	const colorClass = objc.getClass('UIColor');
	if (!colorClass) return null;
	return nativeCall(
		colorClass,
		'colorWithRed:green:blue:alpha:',
		((value >> 16) & 0xff) / 255,
		((value >> 8) & 0xff) / 255,
		(value & 0xff) / 255,
		1,
	);
}

function roleImage(metadata: Mention, color: NativeValue): NativeValue | null {
	if (!objc) return null;
	const imageClass = objc.getClass('UIImage');
	const configurationClass = objc.getClass('UIImageSymbolConfiguration');
	const configuration = configurationClass
		? nativeCall(configurationClass, 'configurationWithPointSize:weight:scale:', 14, 0, 1)
		: null;
	const image = imageClass
		? configuration && objc.respondsTo(imageClass, 'systemImageNamed:withConfiguration:')
			? nativeCall(
					imageClass,
					'systemImageNamed:withConfiguration:',
					ROLE_IMAGE_NAME,
					configuration,
				)
			: nativeCall(imageClass, 'systemImageNamed:', ROLE_IMAGE_NAME)
		: null;
	if (!image) return null;
	const colorClass = objc.getClass('UIColor');
	const tint =
		roleColor(metadata.roleColor) ??
		color ??
		(colorClass ? nativeCall(colorClass, 'labelColor') : null);
	if (!tint || !objc.respondsTo(image, 'imageWithTintColor:')) return image;
	const ciImageClass = objc.getClass('CIImage');
	const ciColorClass = objc.getClass('CIColor');
	const contextClass = objc.getClass('CIContext');
	const filterClass = objc.getClass('CIFilter');
	const vectorClass = objc.getClass('CIVector');
	const sourceCGImage = nativeCall(image, 'CGImage');
	const cgColor = nativeCall(tint, 'CGColor');
	if (
		ciImageClass &&
		ciColorClass &&
		contextClass &&
		filterClass &&
		vectorClass &&
		sourceCGImage &&
		cgColor
	) {
		const source = nativeCall(ciImageClass, 'imageWithCGImage:', sourceCGImage);
		const ciColor = nativeCall(ciColorClass, 'colorWithCGColor:', cgColor);
		const matrix = nativeCall(filterClass, 'filterWithName:', 'CIColorMatrix');
		if (source && ciColor && matrix) {
			const zero = nativeCall(vectorClass, 'vectorWithX:Y:Z:W:', 0, 0, 0, 0);
			const alpha = nativeCall(vectorClass, 'vectorWithX:Y:Z:W:', 0, 0, 0, 1);
			const bias = nativeCall(
				vectorClass,
				'vectorWithX:Y:Z:W:',
				asNumber(nativeCall(ciColor, 'red')),
				asNumber(nativeCall(ciColor, 'green')),
				asNumber(nativeCall(ciColor, 'blue')),
				0,
			);
			if (zero && alpha && bias) {
				nativeCall(matrix, 'setValue:forKey:', source, 'inputImage');
				nativeCall(matrix, 'setValue:forKey:', zero, 'inputRVector');
				nativeCall(matrix, 'setValue:forKey:', zero, 'inputGVector');
				nativeCall(matrix, 'setValue:forKey:', zero, 'inputBVector');
				nativeCall(matrix, 'setValue:forKey:', alpha, 'inputAVector');
				nativeCall(matrix, 'setValue:forKey:', bias, 'inputBiasVector');
				const output = nativeCall(matrix, 'outputImage');
				const transform = objc.struct('CGAffineTransform', {
					a: 1,
					b: 0,
					c: 0,
					d: 1,
					tx: 4,
					ty: 5.375,
				});
				const centered = output ? nativeCall(output, 'imageByApplyingTransform:', transform) : null;
				const context = nativeCall(contextClass, 'contextWithOptions:', null);
				const rect = objc.struct('CGRect', {
					origin: { x: 0, y: 0 },
					size: { width: 32, height: 32 },
				});
				const cgImage =
					centered && context && nativeCall(context, 'createCGImage:fromRect:', centered, rect);
				if (cgImage)
					return (
						nativeCall(imageClass, 'imageWithCGImage:scale:orientation:', cgImage, 2, 0) ?? image
					);
			}
		}
	}
	if (objc.respondsTo(image, 'imageWithTintColor:renderingMode:')) {
		return nativeCall(image, 'imageWithTintColor:renderingMode:', tint, 1) ?? image;
	}
	return nativeCall(image, 'imageWithTintColor:', tint) ?? image;
}

function roundedImage(image: NativeValue): NativeValue | null {
	if (!objc || !image) return image;
	const imageClass = objc.getClass('UIImage');
	const ciImageClass = objc.getClass('CIImage');
	const contextClass = objc.getClass('CIContext');
	const filterClass = objc.getClass('CIFilter');
	const colorClass = objc.getClass('CIColor');
	const vectorClass = objc.getClass('CIVector');
	if (!imageClass || !ciImageClass || !contextClass || !filterClass || !colorClass || !vectorClass)
		return image;
	const sourceCGImage = nativeCall(image, 'CGImage');
	if (!sourceCGImage) return image;
	const source = nativeCall(ciImageClass, 'imageWithCGImage:', sourceCGImage);
	const mask = nativeCall(filterClass, 'filterWithName:', 'CIRadialGradient');
	if (!source || !mask) return image;
	const white = nativeCall(colorClass, 'colorWithRed:green:blue:alpha:', 1, 1, 1, 1);
	const clear = nativeCall(colorClass, 'colorWithRed:green:blue:alpha:', 0, 0, 0, 0);
	const center = nativeCall(vectorClass, 'vectorWithX:Y:', 16, 16);
	if (!white || !clear || !center) return image;
	nativeCall(mask, 'setValue:forKey:', center, 'inputCenter');
	nativeCall(mask, 'setValue:forKey:', 15.5, 'inputRadius0');
	nativeCall(mask, 'setValue:forKey:', 16, 'inputRadius1');
	nativeCall(mask, 'setValue:forKey:', white, 'inputColor0');
	nativeCall(mask, 'setValue:forKey:', clear, 'inputColor1');
	const maskImage = nativeCall(mask, 'outputImage');
	const blend = nativeCall(filterClass, 'filterWithName:', 'CIBlendWithMask');
	if (!maskImage || !blend) return image;
	nativeCall(blend, 'setValue:forKey:', source, 'inputImage');
	nativeCall(blend, 'setValue:forKey:', maskImage, 'inputMaskImage');
	const output = nativeCall(blend, 'outputImage');
	if (!output) return image;
	const rect = objc.struct('CGRect', {
		origin: { x: 0, y: 0 },
		size: { width: 32, height: 32 },
	});
	const context = nativeCall(contextClass, 'contextWithOptions:', null);
	const cgImage = context && nativeCall(context, 'createCGImage:fromRect:', output, rect);
	if (!cgImage) return image;
	return (
		nativeCall(
			imageClass,
			'imageWithCGImage:scale:orientation:',
			cgImage,
			2,
			nativeCall(image, 'imageOrientation') ?? 0,
		) ?? image
	);
}

function messageIDForCell(cell: NativeValue): string | undefined {
	if (!objc) return;
	const viewModel = objc.getIvar(cell, 'viewModel');
	if (!viewModel || !objc.respondsTo(viewModel, 'message')) return;
	const message = nativeCall(viewModel, 'message');
	if (!message || !objc.respondsTo(message, 'id')) return;
	const id = nativeCall(message, 'id');
	if (typeof id === 'string') return id;
	if (id && objc.respondsTo(id, 'description')) return String(nativeCall(id, 'description'));
}

function cellKey(cell: NativeValue): string | undefined {
	if (!objc) return;
	const className = objc.className(cell) ?? '';
	if (objc.respondsTo(cell, 'hash')) return `${className}:${String(nativeCall(cell, 'hash'))}`;
	if (!objc.respondsTo(cell, 'description')) return;
	const description = nativeCall(cell, 'description');
	return typeof description === 'string' ? `${className}:${description}` : undefined;
}

function range(location: number, length: number): NativeValue {
	return objc?.struct('NSRange', { location, length });
}

function attributes(original: NativeValue, index: number): NativeValue {
	return objc ? nativeCall(original, 'attributesAtIndex:effectiveRange:', index, null) : null;
}

function attributedStringText(value: NativeValue): string | undefined {
	if (!objc || !value) return;
	const string = nativeCall(value, 'string');
	return typeof string === 'string' ? string : undefined;
}

function nextHighlightedRange(
	value: NativeValue,
	string: string,
	start: number,
): HighlightedRange | null {
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

function nextMentionRange(
	value: NativeValue,
	string: string,
	start: number,
	labels: string[],
): HighlightedRange | null {
	let fallback: HighlightedRange | null = null;
	let searchIndex = start;
	while (searchIndex < string.length) {
		const highlighted = nextHighlightedRange(value, string, searchIndex);
		if (!highlighted) return fallback;
		searchIndex = highlighted.index + highlighted.length;
		if (!highlighted.text.includes('@')) continue;
		fallback ??= highlighted;
		if (labels.some((label) => highlighted.text.includes(`@${label}`))) return highlighted;
	}
	return fallback;
}

function imageForMention(metadata: Mention, color: NativeValue): NativeValue | null {
	if (!objc) return null;
	if (!metadata.avatarURL) {
		if (metadata.type !== 'role') return null;
		return roleImage(metadata, color);
	}

	const cached = imageCache.get(metadata.avatarURL);
	const action = imageCacheAction(cached);
	if (action === 'cached') return cached?.image ?? null;
	if (action === 'pending' || action === 'retry') return null;
	if (action === 'load') {
		const token = lifecycleToken;
		const pending = fetch(metadata.avatarURL)
			.then((response) => (response.ok ? response.arrayBuffer() : null))
			.then((bytes) => {
				if (!bytes || !objc) return null;
				const data = objc.data(bytes);
				const imageClass = objc.getClass('UIImage');
				const image = imageClass ? nativeCall(imageClass, 'imageWithData:', data) : null;
				return image ? (metadata.type === 'user' ? roundedImage(image) : image) : null;
			})
			.catch(() => null);
		imageCache.set(metadata.avatarURL, { image: null, pending });
		pending.then((image) => {
			if (token !== lifecycleToken || !objc) return;
			imageCache.set(
				metadata.avatarURL!,
				image ? { image } : { image: null, retryAt: Date.now() + 5000 },
			);
			for (const cell of activeCells.values()) scheduleCellRender(cell);
		});
	}
	return null;
}

function imageAttachment(
	image: NativeValue,
	metadata: Mention,
	attributes: NativeValue,
): NativeValue | null {
	if (!objc) return null;
	const attachmentClass = objc.getClass('YYTextAttachment');
	if (!attachmentClass) return null;
	const attachment = objc.alloc(attachmentClass);
	const { leading, size, trailing } = mentionImageMetrics(metadata.type);
	const insets = objc.struct('UIEdgeInsets', {
		top: 0,
		left: leading,
		bottom: 0,
		right: trailing,
	});
	nativeCall(attachment, 'setValue:forKey:', image, 'content');
	nativeCall(attachment, 'setValue:forKey:', 1, 'contentMode');
	nativeCall(attachment, 'setValue:forKey:', insets, 'contentInsets');

	const result = objc.alloc('NSMutableAttributedString');
	nativeCall(result, 'initWithString:attributes:', MENTION_PLACEHOLDER, attributes);
	nativeCall(result, 'addAttribute:value:range:', 'YYTextAttachment', attachment, range(0, 1));
	const runDelegateClass = objc.getClass('YYTextRunDelegate');
	const font = attributes?.NSFont;
	if (runDelegateClass && font) {
		const runDelegate = objc.alloc(runDelegateClass);
		const ascent = asNumber(nativeCall(font, 'ascender'));
		const descent = asNumber(nativeCall(font, 'descender'));
		nativeCall(runDelegate, 'setValue:forKey:', ascent, 'ascent');
		nativeCall(runDelegate, 'setValue:forKey:', -descent, 'descent');
		nativeCall(runDelegate, 'setValue:forKey:', leading + size + trailing, 'width');
		if (objc.respondsTo(runDelegate, 'CTRunDelegate')) {
			const coreTextRunDelegate = nativeCall(runDelegate, 'CTRunDelegate');
			if (coreTextRunDelegate) {
				nativeCall(
					result,
					'addAttribute:value:range:',
					'CTRunDelegate',
					coreTextRunDelegate,
					range(0, 1),
				);
			}
		}
	}
	return result;
}

function attributedMention(
	text: string,
	metadata: Mention,
	attributes: NativeValue,
	image: NativeValue,
): NativeValue {
	if (!objc) return null;
	const mentionClass = objc.alloc('NSAttributedString');
	nativeCall(mentionClass, 'initWithString:attributes:', text, attributes);
	const avatar = imageAttachment(image, metadata, attributes);
	if (!avatar) return mentionClass;
	const replacement = objc.alloc('NSMutableAttributedString');
	nativeCall(replacement, 'init');
	if (metadata.type === 'role') {
		nativeCall(replacement, 'appendAttributedString:', mentionClass);
		nativeCall(replacement, 'appendAttributedString:', avatar);
	} else {
		nativeCall(replacement, 'appendAttributedString:', avatar);
		nativeCall(replacement, 'appendAttributedString:', mentionClass);
	}
	return replacement;
}

function mentionAvatarText(original: NativeValue, mentions: Mention[]): NativeValue {
	if (!objc || mentions.length === 0) return original;
	const result = nativeCall(original, 'mutableCopy');
	if (!result) return original;
	let searchIndex = 0;
	for (const metadata of mentions) {
		const string = nativeCall(result, 'string');
		if (typeof string !== 'string' || searchIndex >= string.length) break;
		const highlighted = nextMentionRange(result, string, searchIndex, metadata.labels);
		if (!highlighted) break;
		const atOffset = highlighted.text.indexOf('@');
		if (atOffset === -1) continue;
		const matchedLabel = selectMentionLabel(highlighted.text, metadata.labels);
		const fallbackText = highlighted.text.slice(atOffset);
		const boundary = fallbackText.search(/[\u2068\u2069]/u);
		const mentionText = matchedLabel
			? `@${matchedLabel}`
			: boundary === -1
				? fallbackText
				: fallbackText.slice(0, boundary);
		const mentionIndex = highlighted.index + atOffset;
		const values = attributes(result, mentionIndex);
		if (!values?.YYTextHighlight) {
			searchIndex = mentionIndex + mentionText.length;
			continue;
		}
		const image = imageForMention(metadata, values.NSColor);
		if (!image) {
			searchIndex = mentionIndex + mentionText.length;
			continue;
		}
		const label = matchedLabel ?? metadata.labels[0] ?? mentionText.slice(1);
		const text = STORE.get('showAtSymbol', true) ? `@${label}` : label;
		let replacementIndex = mentionIndex;
		let replacementLength = mentionText.length;
		while (
			replacementIndex > highlighted.index &&
			string[replacementIndex - 1] === MENTION_PLACEHOLDER &&
			attributes(result, replacementIndex - 1)?.YYTextAttachment
		) {
			replacementIndex--;
			replacementLength++;
		}
		let replacementEnd = mentionIndex + mentionText.length;
		while (
			string[replacementEnd] === MENTION_PLACEHOLDER &&
			attributes(result, replacementEnd)?.YYTextAttachment
		) {
			replacementEnd++;
			replacementLength++;
		}
		const replacement = attributedMention(text, metadata, values, image);
		nativeCall(
			result as NativeObjectHandle,
			'replaceCharactersInRange:withAttributedString:',
			range(replacementIndex, replacementLength),
			replacement,
		);
		searchIndex = replacementIndex + asNumber(nativeCall(replacement, 'length'));
	}

	return result;
}

function textViewsInView(view: NativeValue): NativeValue[] {
	if (!objc) return [];
	const views: NativeValue[] = [];
	if (objc.respondsTo(view, 'setAttributedText:') && objc.respondsTo(view, 'attributedText'))
		views.push(view);
	if (!objc.respondsTo(view, 'subviews')) return views;
	const children = nativeCall(view, 'subviews');
	if (!Array.isArray(children)) return views;
	for (const child of children) views.push(...textViewsInView(child));
	return views;
}

function viewKey(view: NativeValue): string | undefined {
	return cellKey(view);
}

function restoreTextView(view: NativeValue): void {
	if (!objc) return;
	const key = viewKey(view);
	if (!key) return;
	const state = textViewStates.get(key);
	if (!state) return;
	const current = nativeCall(view, 'attributedText');
	const currentString = attributedStringText(current);
	if (currentString?.includes(MENTION_PLACEHOLDER))
		nativeCall(view, 'setAttributedText:', state.original);
	textViewStates.delete(key);
}

function updateTextView(
	view: NativeValue,
	messageID: string | undefined,
	mentions: Mention[],
): boolean {
	if (!objc || !messageID) {
		restoreTextView(view);
		return false;
	}
	const key = viewKey(view);
	if (!key) return false;
	const current = nativeCall(view, 'attributedText');
	const currentString = attributedStringText(current);
	if (!current || !currentString) return false;
	const storedState = textViewStates.get(key);
	if (storedState?.messageID && storedState.messageID !== messageID) {
		textViewStates.delete(key);
	}
	if (mentions.length === 0) {
		restoreTextView(view);
		return false;
	}
	const currentState = textViewStates.get(key);
	let original = currentState?.original;
	let originalString = currentState?.originalString;
	if (
		currentState &&
		!currentString.includes(MENTION_PLACEHOLDER) &&
		(currentString !== currentState.originalString ||
			!containsMentionText(currentState.originalString, mentions)) &&
		containsMentionText(currentString, mentions)
	) {
		original = current;
		originalString = currentString;
	}
	if (!original) {
		original = current;
		originalString = currentString;
	}
	const updated = mentionAvatarText(original, mentions);
	if (!updated) return false;
	textViewStates.set(key, {
		messageID,
		original,
		originalString: originalString ?? currentString,
	});
	if (current && nativeCall(updated, 'isEqual:', current)) return false;
	nativeCall(view, 'setAttributedText:', updated);
	return true;
}

function clearCell(cell: NativeValue): void {
	for (const view of textViewsInView(cell)) restoreTextView(view);
	resetCell(cell);
}

function resetCell(cell: NativeValue): void {
	for (const view of textViewsInView(cell)) {
		const key = viewKey(view);
		if (key) textViewStates.delete(key);
	}
	const key = cellKey(cell);
	if (key) {
		activeCells.delete(key);
		pendingCells.delete(key);
		pendingCellRefs.delete(key);
	}
}

function renderCell(cell: NativeValue): boolean {
	if (!objc) return false;
	hydrateMentions();
	const key = cellKey(cell);
	if (key) activeCells.set(key, cell);
	const id = messageIDForCell(cell);
	const messageHydrated = hydrateMessage(id);
	const mentions = id ? (messageMentionIndex.get(id) ?? []) : [];
	const views = textViewsInView(cell);
	let changed = false;
	for (const view of views) {
		const viewChanged = updateTextView(view, id, mentions);
		changed ||= viewChanged;
	}
	if (changed) nativeCall(cell, 'setNeedsLayout');
	return cellRenderDecision(id, messageHydrated, unresolvedMessageIDs.has(id), mentions) !== 'idle';
}

function scheduleCellRender(cell: NativeValue, attempt: number = 0): void {
	if (!objc) return;
	const key = cellKey(cell);
	if (!key || pendingCells.has(key)) return;
	const bridge = objc;
	pendingCells.add(key);
	pendingCellRefs.set(key, cell);
	setTimeout(() => {
		pendingCells.delete(key);
		const retainedCell = pendingCellRefs.get(key);
		pendingCellRefs.delete(key);
		if (objc !== bridge) return;
		if (!retainedCell) return;
		const retry = renderCell(retainedCell);
		if (retry && attempt < 12) {
			setTimeout(() => scheduleCellRender(retainedCell, attempt + 1), 100);
		}
	}, 0);
}

function scheduleVisibleCells(view: NativeValue): void {
	if (!objc) return;
	if (objc.className(view) === 'DCDMessageTableViewCell') {
		scheduleCellRender(view);
	}
	if (!objc.respondsTo(view, 'subviews')) return;
	const children = nativeCall(view, 'subviews');
	if (!Array.isArray(children)) return;
	for (const child of children) scheduleVisibleCells(child);
}

function installNativeHooks(): void {
	if (!objc) return;
	const lifecycle = objc.hook('DCDMessageTableViewCell', 'didMoveToWindow', {
		after: ({ self }) => scheduleCellRender(self),
	});
	const layout = objc.hook('DCDMessageTableViewCell', 'layoutSubviews', {
		after: ({ self }) => scheduleCellRender(self),
	});
	const reuse = objc.hook('DCDMessageTableViewCell', 'prepareForReuse', {
		after: ({ self }) => {
			resetCell(self);
			scheduleCellRender(self);
		},
	});
	hookTokens = [lifecycle, layout, reuse];
}

function start(context?: PluginContext): void {
	lifecycleToken++;
	objc = context?.native.objc ?? null;
	if (!objc) return;
	users = metro.findByProps('getCurrentUser', 'getUser');
	members = metro.findStore('GuildMember');
	channels = metro.findByProps('getChannel');
	roles = metro.find(
		(module) =>
			typeof module?.getRole === 'function' && typeof module?.getSortedRoles === 'function',
	);

	const target = metro.findByProps('generateMessageRowData');
	if (typeof target?.generateMessageRowData !== 'function') return;
	unpatch = patcher.after(target, 'generateMessageRowData', (ctx) => {
		addMentions(ctx.args[0]?.message);
	});
	hydrateMentions();
	installNativeHooks();
	const windowClass = objc.getClass('UIWindow');
	const keyWindow = windowClass ? nativeCall(windowClass, 'keyWindow') : null;
	if (keyWindow) scheduleVisibleCells(keyWindow);
}

function stop(): void {
	lifecycleToken++;
	unpatch?.();
	unpatch = null;
	for (const token of hookTokens) token.remove();
	hookTokens = [];
	for (const cell of activeCells.values()) clearCell(cell);
	activeCells.clear();
	pendingCellRefs.clear();
	textViewStates.clear();
	users = null;
	members = null;
	channels = null;
	roles = null;
	objc = null;
	pendingCells.clear();
	imageCache.clear();
	messageMentionIndex.clear();
	unresolvedMessageIDs.clear();
	hydratedMessageKey = null;
}

export default { start, stop };
