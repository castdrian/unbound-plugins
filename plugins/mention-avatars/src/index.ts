import {
	extractMentionTokens,
	type MentionBatchEntry,
	type MentionBatchResult,
	type MentionCandidate,
	type MentionSelectionInput,
	selectMentionBatch,
	selectMentionLabel,
	selectMentions,
} from '@mention-avatars/mention-decisions';
import { metro, patcher, storage } from '@unbound-app/api';

export {
	extractMentionTokens,
	roleImageSource,
	selectMentionLabel,
} from '@mention-avatars/mention-decisions';

import type {
	NativeHookToken,
	NativeObjCBridge,
	NativeObjectHandle,
	NativeWorkerBridge,
	PluginContext,
} from '@unbound-app/api/native';

export type MentionType = 'role' | 'user';

export type Mention = {
	avatarURL?: string;
	labels: string[];
	roleColor?: number;
	type: MentionType;
};

export type ImageCacheEntry = {
	image: unknown | null;
	pending?: Promise<unknown | null>;
	retryAt?: number;
};

type ImageCacheAction = 'cached' | 'pending' | 'retry' | 'load';

type CellRenderDecision = 'idle' | 'render' | 'retry';

type MentionImageMetrics = {
	leading: number;
	size: number;
	trailing: number;
};

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

export function shouldHandleChannelChange(
	previousChannelId: string | undefined,
	nextChannelId: string | undefined,
): boolean {
	return Boolean(nextChannelId) && previousChannelId !== nextChannelId;
}

export function mentionCellLifecycleAction(
	attached: boolean,
	reused: boolean,
): 'preserve' | 'render' | 'reset' {
	if (reused) return 'reset';
	return attached ? 'render' : 'preserve';
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
	return mentions.every((metadata) =>
		metadata.labels.some((label) => {
			const prefix = `@${label}`;
			let searchIndex = 0;
			while (searchIndex < value.length) {
				const index = value.indexOf(prefix, searchIndex);
				if (index === -1) return false;
				const next = value[index + prefix.length];
				if (!next || next === '\u2068' || next === '\u2069' || /\s/u.test(next)) return true;
				searchIndex = index + 1;
			}
			return false;
		}),
	);
}

const ADDON_ID = 'unbound.mention-avatars';
const STORE = storage.getStore(ADDON_ID);
const MENTION_PLACEHOLDER = '\uFFFC';
const ROLE_IMAGE_NAME = 'person.2.fill';
export const ROLE_SYMBOL_METRICS = { pointSize: 14 } as const;
const MAX_VISIBLE_CELL_SCAN_DEPTH = 40;
const MAX_VISIBLE_CELL_SCAN_NODES = 1_600;

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

type SelectedChannel = {
	addChangeListener?: (listener: () => void) => void;
	getChannelId?: () => string | undefined;
	getLastSelectedChannelId?: () => string | undefined;
	removeChangeListener?: (listener: () => void) => void;
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
let selectedChannel: SelectedChannel | null = null;
let roles: {
	getRole?: (
		guildId: string,
		roleId: string,
	) => { color?: number; icon?: string | null; id: string; name?: string } | undefined;
	getSortedRoles?: (guildId: string) => unknown[];
} | null = null;
let objc: NativeObjCBridge | null = null;
let worker: NativeWorkerBridge | null = null;
let hookTokens: NativeHookToken[] = [];
const activeCells = new Map<string, NativeValue>();
const pendingCells = new Set<string>();
const pendingCellRefs = new Map<string, NativeValue>();
const imageCache = new Map<string, ImageCacheEntry>();
const messageMentionIndex = new Map<string, Mention[]>();
const unresolvedMessageIDs = new Set<string>();
const textViewStates = new Map<string, TextViewState>();
const pendingWorkerSelections = new Map<string, MentionSelectionInput>();
const workerSelectionSignatures = new Map<string, string>();
let hydratedMessageKey: string | null = null;
let lifecycleToken = 0;
let channelScanTimeouts: ReturnType<typeof setTimeout>[] = [];
let workerSelectionTimer: ReturnType<typeof setTimeout> | null = null;
let currentChannelId: string | undefined;

function nativeCall(handle: NativeValue, selector: string, ...args: NativeValue[]): NativeValue {
	if (!objc) return null;
	try {
		return objc.invoke(handle, selector, args, { thread: 'main' });
	} catch {
		return null;
	}
}

function userCandidate(userId: string, guildId?: string): MentionCandidate | undefined {
	const user = users?.getUser?.(userId);
	if (!user) return;

	const labels = [
		members?.getMember?.(guildId ?? '', userId)?.nick,
		user.globalName,
		user.username,
	].filter((label): label is string => Boolean(label));
	return {
		avatar: user.avatar,
		id: userId,
		labels,
		preferredURL: user.getAvatarURL?.(guildId ?? null, 32, false),
		type: 'user',
	};
}

function roleCandidate(roleId: string, guildId?: string): MentionCandidate | undefined {
	if (!guildId) return;
	const role =
		roles?.getRole?.(guildId, roleId) ??
		(roles?.getSortedRoles?.(guildId)?.find((candidate: any) => candidate?.id === roleId) as
			| { color?: number; icon?: string | null; id: string; name?: string }
			| undefined);
	if (!role) return;
	return {
		color: role.color,
		icon: role.icon,
		id: roleId,
		name: role.name,
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

function mentionSelectionInput(message: any): MentionSelectionInput {
	const guildId = guildIdForMessage(message);
	const content = message?.content;
	if (typeof content !== 'string') return { candidates: [], content: '' };
	const candidates = extractMentionTokens(content)
		.map((token) =>
			token.type === 'user' ? userCandidate(token.id, guildId) : roleCandidate(token.id, guildId),
		)
		.filter((candidate): candidate is MentionCandidate => Boolean(candidate));
	return { candidates, content };
}

function isMentionBatchResult(value: unknown): value is MentionBatchResult[] {
	if (!Array.isArray(value)) return false;
	return value.every((entry: unknown) => {
		if (!entry || typeof entry !== 'object') return false;
		const result = entry as MentionBatchResult;
		return (
			typeof result.id === 'string' &&
			typeof result.selection?.complete === 'boolean' &&
			Array.isArray(result.selection.mentions) &&
			result.selection.mentions.every(
				(mention) =>
					Array.isArray(mention.labels) && (mention.type === 'user' || mention.type === 'role'),
			)
		);
	});
}

function flushWorkerSelections(): void {
	workerSelectionTimer = null;
	if (!worker?.available || pendingWorkerSelections.size === 0) return;
	const batch: MentionBatchEntry[] = [...pendingWorkerSelections.entries()]
		.slice(0, 16)
		.map(([id, input]) => ({ id, input }));
	for (const { id } of batch) pendingWorkerSelections.delete(id);
	const signatures = new Map(batch.map(({ id, input }) => [id, JSON.stringify(input)]));
	const token = lifecycleToken;
	void worker
		.run('selectBatch', batch, selectMentionBatch, isMentionBatchResult)
		.then((results) => {
			if (token !== lifecycleToken) return;
			let changed = false;
			for (const { id, selection } of results) {
				if (!signatures.has(id)) continue;
				if (workerSelectionSignatures.get(id) !== signatures.get(id)) continue;
				const previous = messageMentionIndex.get(id);
				messageMentionIndex.set(id, selection.mentions);
				if (selection.complete) unresolvedMessageIDs.delete(id);
				else unresolvedMessageIDs.add(id);
				changed ||= JSON.stringify(previous) !== JSON.stringify(selection.mentions);
			}
			if (changed) scanVisibleMessageCells();
		})
		.catch(() => undefined)
		.finally(() => {
			if (token !== lifecycleToken || pendingWorkerSelections.size === 0) return;
			workerSelectionTimer = setTimeout(flushWorkerSelections, 250);
		});
}

function queueWorkerSelection(id: string, input: MentionSelectionInput): void {
	if (!worker?.available || extractMentionTokens(input.content).length === 0) return;
	const signature = JSON.stringify(input);
	if (workerSelectionSignatures.get(id) === signature) return;
	workerSelectionSignatures.set(id, signature);
	pendingWorkerSelections.set(id, input);
	if (workerSelectionTimer) clearTimeout(workerSelectionTimer);
	workerSelectionTimer = setTimeout(flushWorkerSelections, 250);
}

function addMentions(message: any): boolean {
	const id = message?.id;
	if (typeof id !== 'string') return false;
	const input = mentionSelectionInput(message);
	const { complete, mentions } = selectMentions(input);
	queueWorkerSelection(id, input);
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

export function tintRoleSymbol(image: NativeValue, tint: NativeValue): NativeValue {
	if (!objc || !tint) return image;
	if (objc.respondsTo(image, 'imageWithTintColor:renderingMode:')) {
		return nativeCall(image, 'imageWithTintColor:renderingMode:', tint, 1) ?? image;
	}
	if (objc.respondsTo(image, 'imageWithTintColor:')) {
		return nativeCall(image, 'imageWithTintColor:', tint) ?? image;
	}
	return image;
}

function roleImage(metadata: Mention): NativeValue | null {
	if (!objc) return null;
	const imageClass = objc.getClass('UIImage');
	const configurationClass = objc.getClass('UIImageSymbolConfiguration');
	const configuration = configurationClass
		? nativeCall(
				configurationClass,
				'configurationWithPointSize:weight:scale:',
				ROLE_SYMBOL_METRICS.pointSize,
				0,
				1,
			)
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
	const tint = metadata.roleColor
		? roleColor(metadata.roleColor)
		: colorClass
			? nativeCall(colorClass, 'labelColor')
			: null;
	return tintRoleSymbol(image, tint);
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
	let searchIndex = start;
	while (searchIndex < string.length) {
		const highlighted = nextHighlightedRange(value, string, searchIndex);
		if (!highlighted) return null;
		searchIndex = highlighted.index + highlighted.length;
		if (!highlighted.text.includes('@')) continue;
		if (selectMentionLabel(highlighted.text, labels)) return highlighted;
	}
	return null;
}

function imageForMention(metadata: Mention): NativeValue | null {
	if (!objc) return null;
	if (!metadata.avatarURL) {
		if (metadata.type !== 'role') return null;
		return roleImage(metadata);
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
		const image = imageForMention(metadata);
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
	const queue = [{ depth: 0, view }];
	for (let index = 0; index < queue.length && index < MAX_VISIBLE_CELL_SCAN_NODES; index++) {
		const node = queue[index];
		if (!node) continue;
		const className = objc.className(node.view) ?? '';
		if (className.includes('DCDMessageTableViewCell')) {
			if (nativeCall(node.view, 'window')) {
				scheduleCellRender(node.view);
			}
			continue;
		}
		if (node.depth >= MAX_VISIBLE_CELL_SCAN_DEPTH) continue;
		const children = nativeCall(node.view, 'subviews');
		if (Array.isArray(children)) {
			for (const child of children) queue.push({ depth: node.depth + 1, view: child });
			continue;
		}
		if (!children || typeof children !== 'object') continue;
		try {
			for (const child of objc.array(children)) queue.push({ depth: node.depth + 1, view: child });
		} catch {}
	}
}

function scanVisibleMessageCells(): void {
	if (!objc) return;
	const applicationClass = objc.getClass('UIApplication');
	const application = applicationClass ? nativeCall(applicationClass, 'sharedApplication') : null;
	if (!application) return;
	const windows = nativeCall(application, 'windows');
	if (Array.isArray(windows)) {
		for (const window of windows) scheduleVisibleCells(window);
		return;
	}
	if (!windows || typeof windows !== 'object') return;
	try {
		const windowList = objc.array(windows);
		for (const window of windowList) scheduleVisibleCells(window);
	} catch {
		return;
	}
}

function scheduleVisibleCellScans(): void {
	for (const timeout of channelScanTimeouts) clearTimeout(timeout);
	channelScanTimeouts = [];
	const token = lifecycleToken;
	for (const delay of [0, 100, 500, 1_500, 3_000]) {
		const timeout = setTimeout(() => {
			channelScanTimeouts = channelScanTimeouts.filter((candidate) => candidate !== timeout);
			if (token !== lifecycleToken || !objc) return;
			scanVisibleMessageCells();
		}, delay);
		channelScanTimeouts.push(timeout);
	}
}

function onSelectedChannelChange(): void {
	const nextChannelId =
		selectedChannel?.getChannelId?.() ?? selectedChannel?.getLastSelectedChannelId?.();
	if (!shouldHandleChannelChange(currentChannelId, nextChannelId)) return;
	currentChannelId = nextChannelId;
	for (const cell of [...activeCells.values()]) clearCell(cell);
	activeCells.clear();
	pendingCells.clear();
	pendingCellRefs.clear();
	textViewStates.clear();
	messageMentionIndex.clear();
	unresolvedMessageIDs.clear();
	pendingWorkerSelections.clear();
	workerSelectionSignatures.clear();
	if (workerSelectionTimer) clearTimeout(workerSelectionTimer);
	workerSelectionTimer = null;
	hydratedMessageKey = null;
	scheduleVisibleCellScans();
}

function installNativeHooks(): void {
	if (!objc) return;
	const lifecycle = objc.hook('DCDMessageTableViewCell', 'didMoveToWindow', {
		after: ({ self }) => {
			const action = mentionCellLifecycleAction(Boolean(nativeCall(self, 'window')), false);
			if (action === 'render') scheduleCellRender(self);
		},
	});
	const layout = objc.hook('DCDMessageTableViewCell', 'layoutSubviews', {
		after: ({ self }) => scheduleCellRender(self),
	});
	const reuse = objc.hook('DCDMessageTableViewCell', 'prepareForReuse', {
		after: ({ self }) => {
			const action = mentionCellLifecycleAction(false, true);
			if (action === 'reset') resetCell(self);
			scheduleCellRender(self);
		},
	});
	hookTokens = [lifecycle, layout, reuse];
}

function start(context?: PluginContext): void {
	lifecycleToken++;
	objc = context?.native.objc ?? null;
	worker = context?.native.worker ?? null;
	if (!objc) return;
	users = metro.findByProps('getCurrentUser', 'getUser');
	members = metro.findStore('GuildMember');
	channels = metro.findByProps('getChannel');
	selectedChannel = metro.findByProps('getChannelId', 'getLastSelectedChannelId');
	currentChannelId =
		selectedChannel?.getChannelId?.() ?? selectedChannel?.getLastSelectedChannelId?.();
	roles = metro.find(
		(module) =>
			typeof module?.getRole === 'function' && typeof module?.getSortedRoles === 'function',
	);

	const target = metro.findByProps('generateMessageRowData');
	if (typeof target?.generateMessageRowData !== 'function') return;
	unpatch = patcher.after(target, 'generateMessageRowData', (ctx) => {
		addMentions(ctx.args[0]?.message);
	});
	selectedChannel?.addChangeListener?.(onSelectedChannelChange);
	hydrateMentions();
	installNativeHooks();
	scheduleVisibleCellScans();
}

function stop(): void {
	lifecycleToken++;
	worker = null;
	pendingWorkerSelections.clear();
	workerSelectionSignatures.clear();
	if (workerSelectionTimer) clearTimeout(workerSelectionTimer);
	workerSelectionTimer = null;
	unpatch?.();
	unpatch = null;
	for (const token of hookTokens) token.remove();
	hookTokens = [];
	selectedChannel?.removeChangeListener?.(onSelectedChannelChange);
	selectedChannel = null;
	currentChannelId = undefined;
	for (const timeout of channelScanTimeouts) clearTimeout(timeout);
	channelScanTimeouts = [];
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
