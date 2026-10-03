import {
	getSettingsColors,
	SettingsCard,
	SettingsRow,
	SettingsScrollView,
	SettingsSection,
} from '@shared/settings-ui';
import bash from '@shikijs/langs/bash';
import c from '@shikijs/langs/c';
import cpp from '@shikijs/langs/cpp';
import css from '@shikijs/langs/css';
import go from '@shikijs/langs/go';
import html from '@shikijs/langs/html';
import java from '@shikijs/langs/java';
import javascript from '@shikijs/langs/javascript';
import json from '@shikijs/langs/json';
import jsonc from '@shikijs/langs/jsonc';
import kotlin from '@shikijs/langs/kotlin';
import markdown from '@shikijs/langs/markdown';
import python from '@shikijs/langs/python';
import rust from '@shikijs/langs/rust';
import sql from '@shikijs/langs/sql';
import swift from '@shikijs/langs/swift';
import tsx from '@shikijs/langs/tsx';
import typescript from '@shikijs/langs/typescript';
import yaml from '@shikijs/langs/yaml';
import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import { metro, storage } from '@unbound-app/api';
import type {
	NativeHookToken,
	NativeObjCBridge,
	NativeObjectHandle,
	PluginContext,
} from '@unbound-app/api/native';
import { useState } from 'react';
import type { HighlighterCore, ThemedToken } from 'shiki';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

import {
	DEFAULT_THEME,
	getLanguageMetadata,
	grammarUrl,
	loadLanguageCatalog,
	resolveCatalogLanguage,
	THEME_IDS,
	themeLabel,
	themeUrl,
} from './catalog';
import devicons from './devicons.json';

const ADDON_ID = 'unbound.shiki-codeblocks';
const MAX_CODE_LENGTH = 6000;
const MAX_CACHE_ENTRIES = 96;
const MAX_SURFACES = 96;
const MAX_ROW_RETRIES = 4;
const STORE = storage.getStore(ADDON_ID);
const THEME_BACKGROUNDS = { dark: '#1e1e1e', light: '#ffffff' } as const;
const LANGUAGES = [
	bash,
	c,
	cpp,
	css,
	go,
	html,
	java,
	javascript,
	json,
	jsonc,
	kotlin,
	markdown,
	python,
	rust,
	sql,
	swift,
	tsx,
	typescript,
	yaml,
];

type LanguageId = string;
type ThemeName = string;
type TokenLines = ThemedToken[][];
type CodeBlockFence = { code: string; language: LanguageId };
type CodeBlockPlacement = { block: CodeBlockFence; start: number; end: number };
type RawMessage = { content?: unknown };
type MessageStore = {
	getMessage?: (channelId: string, messageId: string) => RawMessage | null;
};
type SelectedChannel = {
	getChannelId?: () => string | undefined;
	getLastSelectedChannelId?: () => string | undefined;
};
type NativeCodePart = {
	codeLabel: NativeObjectHandle;
	code: string;
	copyButton: NativeObjectHandle;
	copyHook: NativeHookToken | null;
	header: NativeObjectHandle;
	height: number;
	host: NativeObjectHandle;
	iconView: NativeObjectHandle | null;
	language: LanguageId;
	languageLabel: NativeObjectHandle;
	placement: CodeBlockPlacement;
};
type NativeCodeBlockState = {
	cell: NativeObjectHandle;
	cellHook: NativeHookToken | null;
	iconMode: 'disabled' | 'greyscale' | 'colored';
	label: NativeObjectHandle;
	labelKey: string;
	lightTheme: boolean;
	opacity: number;
	overflow: 'wrap' | 'scroll';
	original: NativeObjectHandle;
	parts: NativeCodePart[];
	rendered: NativeObjectHandle | null;
	renderedText: string | null;
	rowRetries: number;
	rowTimer: ReturnType<typeof setTimeout> | null;
	settleTimers: ReturnType<typeof setTimeout>[];
	theme: ThemeName;
	width: number;
};
type NativeColorSpan = { color: string; length: number; location: number };
type NativeFrameValue = {
	height?: number;
	origin?: { x?: number; y?: number };
	size?: { height?: number; width?: number };
	value?: NativeFrameValue;
	width?: number;
	x?: number;
	y?: number;
};
type NativeCodeMarkup = { spans: NativeColorSpan[]; text: string };
type NativeCodeHost = {
	codeLabel: NativeObjectHandle;
	copyButton: NativeObjectHandle;
	header: NativeObjectHandle;
	host: NativeObjectHandle;
	iconView: NativeObjectHandle | null;
	languageLabel: NativeObjectHandle;
};
type CodeBlockLayout = { contentHeight: number; contentWidth: number; height: number };
type ThemeAppearance = { background: string; foreground: string; light: boolean };
const LANGUAGE_ALIASES: Record<string, LanguageId> = {
	bash: 'bash',
	c: 'c',
	cc: 'cpp',
	cpp: 'cpp',
	css: 'css',
	cxx: 'cpp',
	go: 'go',
	golang: 'go',
	h: 'c',
	html: 'html',
	java: 'java',
	js: 'javascript',
	json: 'json',
	jsonc: 'jsonc',
	jsx: 'javascript',
	kt: 'kotlin',
	kts: 'kotlin',
	kotlin: 'kotlin',
	md: 'markdown',
	markdown: 'markdown',
	py: 'python',
	python: 'python',
	rs: 'rust',
	rust: 'rust',
	sh: 'bash',
	shell: 'bash',
	sql: 'sql',
	swift: 'swift',
	ts: 'typescript',
	tsx: 'tsx',
	typescript: 'typescript',
	yml: 'yaml',
	yaml: 'yaml',
};

const LANGUAGE_LABELS: Record<LanguageId, string> = {
	bash: 'Bash',
	c: 'C',
	cpp: 'C++',
	css: 'CSS',
	go: 'Go',
	html: 'HTML',
	java: 'Java',
	javascript: 'JavaScript',
	json: 'JSON',
	jsonc: 'JSONC',
	kotlin: 'Kotlin',
	markdown: 'Markdown',
	python: 'Python',
	rust: 'Rust',
	sql: 'SQL',
	swift: 'Swift',
	tsx: 'TSX',
	typescript: 'TypeScript',
	yaml: 'YAML',
};

const THEME_MODULES = [darkPlus, lightPlus];
const LOCAL_GRAMMARS = new Map<string, (typeof LANGUAGES)[number]>();
for (const registration of LANGUAGES) {
	for (const language of registration) {
		for (const name of [language.name, ...(language.aliases ?? [])]) {
			LOCAL_GRAMMARS.set(name, registration);
		}
	}
}
const DEVICON_LANGUAGES = devicons.languages as Record<string, string>;
const DEVICON_IMAGES = devicons.images as Record<string, string>;
const NATIVE_LANGUAGE_IDS = new Set(Object.values(LANGUAGE_ALIASES));
const pendingLanguages = new Map<string, Promise<void>>();
const pendingThemes = new Map<string, Promise<void>>();
let started = false;
let removeSettingsListener: (() => void) | null = null;
let highlighterPromise: Promise<HighlighterCore | null> | null = null;
let loadedHighlighter: HighlighterCore | null = null;
const tokenCache = new Map<string, TokenLines>();
let objc: NativeObjCBridge | null = null;
let nativeCodeHook: NativeHookToken | null = null;
let initialScanTimer: ReturnType<typeof setTimeout> | null = null;
let messageStore: MessageStore | null = null;
let selectedChannel: SelectedChannel | null = null;
const nativeColors = new Map<string, NativeObjectHandle>();
const nativeImages = new Map<string, NativeObjectHandle>();
const surfacesByLabel = new Map<string, NativeCodeBlockState>();
const applyingLabels = new Set<string>();

function nativeCall(handle: NativeObjectHandle, selector: string, ...args: unknown[]): unknown {
	if (!objc || !handle || args.some((argument) => argument === null || argument === undefined)) {
		return null;
	}
	try {
		return objc.invoke(handle, selector, args, { thread: 'main' });
	} catch {
		return null;
	}
}

function currentTheme(): ThemeName {
	const custom = String(STORE.get('customTheme', '')).trim();
	return custom ? `custom:${custom}` : String(STORE.get('theme', DEFAULT_THEME));
}

function currentOpacity(): number {
	const value = Number(STORE.get('bgOpacity', 100));
	return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 100;
}

function currentOverflow(): 'wrap' | 'scroll' {
	return STORE.get('lineOverflow', 'wrap') === 'scroll' ? 'scroll' : 'wrap';
}

function currentIconMode(): 'disabled' | 'greyscale' | 'colored' {
	const mode = STORE.get('useDevIcon', 'greyscale');
	return mode === 'disabled' || mode === 'colored' ? mode : 'greyscale';
}

function isLightTheme(theme: ThemeName): boolean {
	return /(?:light|latte|dawn|ochin)/i.test(theme);
}

function themeAppearance(theme: ThemeName): ThemeAppearance {
	const fallback = isLightTheme(theme);
	if (!loadedHighlighter) {
		return {
			background: THEME_BACKGROUNDS[fallback ? 'light' : 'dark'],
			foreground: fallback ? '#333333' : '#d4d4d4',
			light: fallback,
		};
	}
	const resolved = loadedHighlighter.getLoadedThemes().includes(theme)
		? loadedHighlighter.getTheme(theme)
		: null;
	const background = resolved?.bg ?? THEME_BACKGROUNDS[fallback ? 'light' : 'dark'];
	const foreground = resolved?.fg ?? (fallback ? '#333333' : '#d4d4d4');
	const rgb = background.replace('#', '').slice(0, 6);
	const light = /^[\da-f]{6}$/i.test(rgb)
		? (Number.parseInt(rgb.slice(0, 2), 16) * 299 +
				Number.parseInt(rgb.slice(2, 4), 16) * 587 +
				Number.parseInt(rgb.slice(4, 6), 16) * 114) /
				1000 >
			150
		: fallback;
	return { background, foreground, light };
}

function normalizeCode(code: string): string {
	return code
		.replaceAll('\r\n', '\n')
		.replaceAll('\u200B', '')
		.replace(/^\n+/, '')
		.replace(/\n+$/, '');
}

export function parseFencedCodeBlocks(content: string): CodeBlockFence[] {
	const fences =
		/(?:^|\n)[\t ]{0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)\r?\n[\t ]{0,3}(`{3,}|~{3,})[\t ]*(?=\r?\n|$)/g;
	const blocks: CodeBlockFence[] = [];

	for (;;) {
		const match = fences.exec(content);
		if (!match) break;
		const opening = match[1];
		const closing = match[4];
		if (opening[0] !== closing[0] || closing.length < opening.length) continue;
		const language = resolveLanguage(match[2].trim().split(/[\t ]+/, 1)[0]);
		if (!language) continue;
		blocks.push({ code: normalizeCode(match[3]), language });
	}

	return blocks;
}

export function matchCodeBlock(
	blocks: CodeBlockFence[],
	renderedCode: string,
): CodeBlockFence | undefined {
	const normalized = normalizeCode(renderedCode);
	return blocks.find((block) => block.code === normalized);
}

export function locateCodeBlocks(blocks: CodeBlockFence[], rendered: string): CodeBlockPlacement[] {
	if (!blocks.length || blocks.some((block) => !block.code)) return [];
	const counts = new Map<string, number>();
	for (const block of blocks) counts.set(block.code, (counts.get(block.code) ?? 0) + 1);
	for (const [code, expected] of counts) {
		let found = 0;
		let cursor = 0;
		while (cursor < rendered.length) {
			const location = rendered.indexOf(code, cursor);
			if (location < 0) break;
			found++;
			cursor = location + code.length;
		}
		if (found !== expected) return [];
	}
	const placements: CodeBlockPlacement[] = [];
	let cursor = 0;
	for (const block of blocks) {
		const codeStart = rendered.indexOf(block.code, cursor);
		if (codeStart < 0) return [];
		const codeEnd = codeStart + block.code.length;
		if (codeStart > 0 && rendered[codeStart - 1] !== '\n') return [];
		if (codeEnd < rendered.length && rendered[codeEnd] !== '\n') return [];
		let start = codeStart;
		let end = codeEnd;
		while (start > cursor && rendered[start - 1] === '\n') start--;
		while (end < rendered.length && rendered[end] === '\n') end++;
		placements.push({ block, start, end });
		cursor = end;
	}
	return placements;
}

function nativeString(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (!objc || !value || typeof value !== 'object') return;
	const handle = value as NativeObjectHandle;
	if (!objc.respondsTo(handle, 'description')) return;
	const description = nativeCall(handle, 'description');
	return typeof description === 'string' ? description : undefined;
}

function nativeLabelKey(label: NativeObjectHandle): string {
	const hash = nativeCall(label, 'hash');
	if (hash !== null && hash !== undefined) return String(hash);
	return nativeString(nativeCall(label, 'description')) ?? 'unknown';
}

function nativeCellForLabel(label: NativeObjectHandle): NativeObjectHandle | null {
	if (!objc) return null;
	let current: NativeObjectHandle | null = label;
	for (let depth = 0; depth < 14 && current; depth++) {
		if ((objc.className(current) ?? '').includes('DCDMessageTableViewCell')) return current;
		current = nativeCall(current, 'superview') as NativeObjectHandle | null;
	}
	return null;
}

function messageIdForCell(cell: NativeObjectHandle): string | undefined {
	if (!objc) return;
	try {
		const viewModel = objc.getIvar(cell, 'viewModel') as NativeObjectHandle | null;
		if (!viewModel || !objc.respondsTo(viewModel, 'message')) return;
		const message = nativeCall(viewModel, 'message') as NativeObjectHandle | null;
		if (!message) return;
		return nativeString(nativeCall(message, 'id'));
	} catch {
		return;
	}
}

function currentChannelId(): string | undefined {
	return selectedChannel?.getChannelId?.() ?? selectedChannel?.getLastSelectedChannelId?.();
}

function messageContent(channelId: string, messageId: string): string | undefined {
	const content = messageStore?.getMessage?.(channelId, messageId)?.content;
	return typeof content === 'string' ? content : undefined;
}

function nativeRange(location: number, length: number): unknown {
	return objc?.struct('NSRange', { location, length }) ?? null;
}

function nativeFrame(width: number, height: number): unknown {
	return objc?.struct('CGRect', { origin: { x: 0, y: 0 }, size: { width, height } }) ?? null;
}

function nativePositionedFrame(x: number, y: number, width: number, height: number): unknown {
	return objc?.struct('CGRect', { origin: { x, y }, size: { width, height } }) ?? null;
}

function nativeFrameMeasurement(view: NativeObjectHandle) {
	const raw = nativeCall(view, 'frame') as NativeFrameValue | null;
	const frame = raw?.value ?? raw;
	return {
		height: Number(frame?.size?.height ?? frame?.height ?? 0),
		width: Number(frame?.size?.width ?? frame?.width ?? 0),
		x: Number(frame?.origin?.x ?? frame?.x ?? 0),
		y: Number(frame?.origin?.y ?? frame?.y ?? 0),
	};
}

function nativeLabelBottomInCell(label: NativeObjectHandle): number {
	if (!objc) return 0;
	let current: NativeObjectHandle | null = label;
	let bottom = nativeFrameMeasurement(label).height;
	for (let depth = 0; depth < 14 && current; depth++) {
		bottom += nativeFrameMeasurement(current).y;
		const parent = nativeCall(current, 'superview') as NativeObjectHandle | null;
		if (!parent) return 0;
		if ((objc.className(parent) ?? '').includes('DCDMessageTableViewCell')) return bottom;
		current = parent;
	}
	return 0;
}

export function shouldCorrectRow(
	cellHeight: number,
	contentHeight: number,
	labelBottom: number,
): boolean {
	return Math.max(contentHeight, labelBottom) > cellHeight + 1;
}

function nativeColor(hex: string, alpha: number = 1): NativeObjectHandle | null {
	const key = `${hex}:${alpha}`;
	const cached = nativeColors.get(key);
	if (cached) return cached;
	if (!objc) return null;
	const value = hex.replace('#', '');
	if (!/^[\da-f]{6}$/i.test(value)) return null;
	const colorClass = objc.getClass('UIColor');
	if (!colorClass) return null;
	const red = Number.parseInt(value.slice(0, 2), 16) / 255;
	const green = Number.parseInt(value.slice(2, 4), 16) / 255;
	const blue = Number.parseInt(value.slice(4, 6), 16) / 255;
	try {
		const color = objc.invoke(
			colorClass,
			'colorWithRed:green:blue:alpha:',
			[red, green, blue, alpha],
			{
				thread: 'main',
			},
		) as NativeObjectHandle | null;
		if (color) nativeColors.set(key, color);
		return color;
	} catch {
		return null;
	}
}

function nativeFont(size: number, weight: number, monospaced: boolean): NativeObjectHandle | null {
	if (!objc) return null;
	const fontClass = objc.getClass('UIFont');
	if (!fontClass) return null;
	const selector = monospaced ? 'monospacedSystemFontOfSize:weight:' : 'systemFontOfSize:weight:';
	try {
		return objc.invoke(fontClass, selector, [size, weight], {
			thread: 'main',
		}) as NativeObjectHandle | null;
	} catch {
		return null;
	}
}

function nativeDevicon(language: string, mode: 'greyscale' | 'colored'): NativeObjectHandle | null {
	if (!objc) return null;
	const iconName = DEVICON_LANGUAGES[language];
	const data = iconName ? DEVICON_IMAGES[iconName] : null;
	if (!data) return null;
	const key = `${iconName}:${mode}`;
	const cached = nativeImages.get(key);
	if (cached) return cached;
	try {
		const decoded = objc.data(Uint8Array.from(atob(data), (character) => character.charCodeAt(0)));
		const imageClass = objc.getClass('UIImage');
		if (!decoded || !imageClass) return null;
		const original = nativeCall(imageClass, 'imageWithData:', decoded) as NativeObjectHandle | null;
		if (!original) return null;
		const image =
			mode === 'greyscale'
				? (nativeCall(original, 'imageWithRenderingMode:', 2) as NativeObjectHandle | null)
				: original;
		if (image) nativeImages.set(key, image);
		return image;
	} catch {
		return null;
	}
}

export function codeBlockLayout(
	code: string,
	width: number,
	overflow: 'wrap' | 'scroll',
): CodeBlockLayout {
	const lines = code.split('\n');
	const contentWidth = Math.max(
		width - 24,
		(Math.max(...lines.map((line) => line.replaceAll('\t', '    ').length)) + 4) * 9,
	);
	const charactersPerLine = Math.max(12, Math.floor((width - 44) / 7.25));
	const lineCount =
		overflow === 'scroll'
			? lines.length
			: lines.reduce(
					(count, line) => count + Math.max(1, Math.ceil((line.length + 4) / charactersPerLine)),
					0,
				);
	const contentHeight = Math.max(26, 2 + lineCount * 18);
	return { contentHeight, contentWidth, height: Math.min(520, 50 + contentHeight) };
}

export function codeScrollHeight(measuredHeight: number, viewportHeight: number): number {
	return Math.max(viewportHeight, Math.ceil(measuredHeight) + 2);
}

function fitCodeContent(label: NativeObjectHandle): void {
	if (!objc) return;
	const scroll = nativeCall(label, 'superview') as NativeObjectHandle | null;
	if (!scroll || !objc.respondsTo(scroll, 'setContentSize:')) return;
	const frame = nativeFrameMeasurement(label);
	const viewport = nativeFrameMeasurement(scroll);
	const measuredValue = nativeCall(
		label,
		'sizeThatFits:',
		objc.struct('CGSize', { width: frame.width, height: 10000 }),
	) as NativeFrameValue | null;
	const measured = measuredValue?.value ?? measuredValue;
	const contentHeight = codeScrollHeight(Number(measured?.height ?? frame.height), viewport.height);
	nativeCall(label, 'setFrame:', nativePositionedFrame(0, 0, frame.width, contentHeight));
	nativeCall(
		scroll,
		'setContentSize:',
		objc.struct('CGSize', { width: frame.width, height: contentHeight }),
	);
}

function measureCodeBlockWidth(cell: NativeObjectHandle, label: NativeObjectHandle): number {
	if (!objc) return 0;
	const labelFrame = nativeFrameMeasurement(label);
	const cellFrame = nativeFrameMeasurement(cell);
	if (labelFrame.width > 80) return labelFrame.width;
	let current = label;
	let left = 0;
	for (let depth = 0; depth < 14; depth++) {
		left += nativeFrameMeasurement(current).x;
		const parent = nativeCall(current, 'superview') as NativeObjectHandle | null;
		if (!parent || parent === cell) break;
		current = parent;
	}
	const availableWidth = cellFrame.width - left - 12;
	return Number.isFinite(availableWidth) && availableWidth > 80 ? availableWidth : 0;
}

function createNativeHost(
	width: number,
	height: number,
	code: string,
	language: LanguageId,
	lightTheme: boolean,
	opacity: number,
	overflow: 'wrap' | 'scroll',
	contentHeight: number,
	contentWidth: number,
	iconMode: 'disabled' | 'greyscale' | 'colored',
): NativeCodeHost | null {
	if (!objc) return null;
	try {
		const host = objc.alloc('UIView');
		nativeCall(host, 'setFrame:', nativeFrame(width, height));
		nativeCall(
			host,
			'setBackgroundColor:',
			nativeColor(THEME_BACKGROUNDS[lightTheme ? 'light' : 'dark'], opacity / 100),
		);
		const layer = nativeCall(host, 'layer') as NativeObjectHandle | null;
		if (layer) {
			nativeCall(layer, 'setCornerRadius:', 8);
			nativeCall(layer, 'setMasksToBounds:', true);
		}
		const header = objc.alloc('UIView');
		nativeCall(header, 'setFrame:', nativeFrame(width, 34));
		nativeCall(header, 'setBackgroundColor:', nativeColor(lightTheme ? '#f3f3f3' : '#181818'));
		nativeCall(host, 'addSubview:', header);
		const icon = iconMode === 'disabled' ? null : nativeDevicon(language, iconMode);
		const iconView = icon ? objc.alloc('UIImageView') : null;
		if (iconView && icon) {
			nativeCall(iconView, 'setFrame:', nativePositionedFrame(12, 9, 16, 16));
			nativeCall(iconView, 'setImage:', icon);
			nativeCall(iconView, 'setContentMode:', 1);
			if (iconMode === 'greyscale') {
				nativeCall(iconView, 'setTintColor:', nativeColor(lightTheme ? '#333333' : '#d4d4d4'));
			}
			nativeCall(header, 'addSubview:', iconView);
		}
		const languageX = iconView ? 34 : 12;
		const languageLabel = objc.alloc('UILabel');
		nativeCall(
			languageLabel,
			'setFrame:',
			nativePositionedFrame(languageX, 0, width - languageX - 76, 34),
		);
		nativeCall(
			languageLabel,
			'setText:',
			getLanguageMetadata(language)?.displayName ?? LANGUAGE_LABELS[language] ?? language,
		);
		nativeCall(languageLabel, 'setTextColor:', nativeColor(lightTheme ? '#333333' : '#d4d4d4'));
		nativeCall(languageLabel, 'setFont:', nativeFont(11, 0.3, false));
		nativeCall(header, 'addSubview:', languageLabel);
		const copyButton = objc.alloc('UIButton');
		nativeCall(copyButton, 'setFrame:', nativePositionedFrame(width - 70, 0, 58, 34));
		nativeCall(copyButton, 'setTitle:forState:', 'Copy', 0);
		nativeCall(
			copyButton,
			'setTitleColor:forState:',
			nativeColor(lightTheme ? '#333333' : '#d4d4d4'),
			0,
		);
		const titleLabel = nativeCall(copyButton, 'titleLabel') as NativeObjectHandle | null;
		if (titleLabel) nativeCall(titleLabel, 'setFont:', nativeFont(11, 0.2, false));
		nativeCall(copyButton, 'addTarget:action:forControlEvents:', copyButton, 'setNeedsDisplay', 64);
		nativeCall(header, 'addSubview:', copyButton);
		const codeLabel = objc.alloc('UILabel');
		const viewportWidth = width - 24;
		const viewportHeight = height - 50;
		const needsScrollView = overflow === 'scroll' || contentHeight > viewportHeight;
		nativeCall(
			codeLabel,
			'setFrame:',
			nativePositionedFrame(
				needsScrollView ? 0 : 12,
				needsScrollView ? 0 : 42,
				overflow === 'scroll' ? contentWidth : viewportWidth,
				contentHeight,
			),
		);
		nativeCall(codeLabel, 'setNumberOfLines:', 0);
		nativeCall(codeLabel, 'setLineBreakMode:', overflow === 'scroll' ? 2 : 0);
		nativeCall(codeLabel, 'setTextColor:', nativeColor(lightTheme ? '#333333' : '#d4d4d4'));
		nativeCall(codeLabel, 'setFont:', nativeFont(12, 0, true));
		nativeCall(codeLabel, 'setText:', code);
		if (needsScrollView) {
			const scroll = objc.alloc('UIScrollView');
			nativeCall(scroll, 'setFrame:', nativePositionedFrame(12, 42, viewportWidth, viewportHeight));
			nativeCall(
				scroll,
				'setContentSize:',
				objc.struct('CGSize', {
					width: overflow === 'scroll' ? contentWidth : viewportWidth,
					height: contentHeight,
				}),
			);
			nativeCall(scroll, 'setShowsHorizontalScrollIndicator:', overflow === 'scroll');
			nativeCall(scroll, 'setShowsVerticalScrollIndicator:', contentHeight > viewportHeight);
			nativeCall(scroll, 'addSubview:', codeLabel);
			nativeCall(host, 'addSubview:', scroll);
			fitCodeContent(codeLabel);
		} else {
			nativeCall(host, 'addSubview:', codeLabel);
		}
		return { codeLabel, copyButton, header, host, iconView, languageLabel };
	} catch {
		return null;
	}
}

function createNativeAttachment(state: NativeCodeBlockState): NativeObjectHandle | null {
	if (!objc) return null;
	const attachmentClass = objc.getClass('YYTextAttachment');
	if (!attachmentClass) return null;
	try {
		const originalText = nativeString(nativeCall(state.original, 'string')) ?? '';
		const attributedText = objc.alloc('NSMutableAttributedString');
		nativeCall(attributedText, 'initWithString:', '');
		const delegateClass = objc.getClass('YYTextRunDelegate');
		let cursor = 0;
		for (const part of state.parts) {
			const { start, end } = part.placement;
			if (start > cursor) {
				const before = nativeCall(
					state.original,
					'attributedSubstringFromRange:',
					nativeRange(cursor, start - cursor),
				) as NativeObjectHandle | null;
				if (!before) return null;
				nativeCall(attributedText, 'appendAttributedString:', before);
			}
			const attachment = objc.alloc(attachmentClass);
			nativeCall(attachment, 'setValue:forKey:', part.host, 'content');
			nativeCall(attachment, 'setValue:forKey:', 1, 'contentMode');
			const separator = start > cursor ? '\n\u200B\n' : '\u200B\n';
			const insertion = objc.alloc('NSMutableAttributedString');
			nativeCall(
				insertion,
				'initWithString:attributes:',
				`${separator}\uFFFC${end < originalText.length ? '\n' : ''}`,
				{ NSFont: nativeFont(1, 0, false) },
			);
			nativeCall(
				insertion,
				'addAttribute:value:range:',
				'YYTextAttachment',
				attachment,
				nativeRange(separator.length, 1),
			);
			if (delegateClass) {
				const delegate = objc.alloc(delegateClass);
				nativeCall(delegate, 'setValue:forKey:', part.height, 'ascent');
				nativeCall(delegate, 'setValue:forKey:', 0, 'descent');
				nativeCall(delegate, 'setValue:forKey:', state.width, 'width');
				const coreDelegate = nativeCall(delegate, 'CTRunDelegate');
				if (coreDelegate) {
					nativeCall(
						insertion,
						'addAttribute:value:range:',
						'CTRunDelegate',
						coreDelegate,
						nativeRange(separator.length, 1),
					);
				}
			}
			nativeCall(attributedText, 'appendAttributedString:', insertion);
			cursor = end;
		}
		if (cursor < originalText.length) {
			const after = nativeCall(
				state.original,
				'attributedSubstringFromRange:',
				nativeRange(cursor, originalText.length - cursor),
			) as NativeObjectHandle | null;
			if (!after) return null;
			nativeCall(attributedText, 'appendAttributedString:', after);
		}
		return attributedText;
	} catch {
		return null;
	}
}

function tableForCell(cell: NativeObjectHandle): NativeObjectHandle | null {
	if (!objc) return null;
	let current: NativeObjectHandle | null = cell;
	for (let depth = 0; depth < 14 && current; depth++) {
		if (objc.respondsTo(current, 'beginUpdates') && objc.respondsTo(current, 'endUpdates')) {
			return current;
		}
		current = nativeCall(current, 'superview') as NativeObjectHandle | null;
	}
	return null;
}

function scheduleRowCorrection(state: NativeCodeBlockState, delay: number = 16): void {
	if (state.rowTimer || state.rowRetries >= MAX_ROW_RETRIES) return;
	state.rowTimer = setTimeout(() => {
		state.rowTimer = null;
		if (!objc || surfacesByLabel.get(state.labelKey) !== state) return;
		nativeCall(state.label, 'layoutIfNeeded');
		nativeCall(state.cell, 'layoutIfNeeded');
		const contentView = nativeCall(state.cell, 'contentView') as NativeObjectHandle | null;
		if (!contentView) return;
		const contentHeight = nativeFrameMeasurement(contentView).height;
		const cellHeight = nativeFrameMeasurement(state.cell).height;
		const labelBottom = nativeLabelBottomInCell(state.label);
		if (!shouldCorrectRow(cellHeight, contentHeight, labelBottom)) {
			state.rowRetries = 0;
			return;
		}
		const table = tableForCell(state.cell);
		if (!table) return;
		if (
			nativeCall(table, 'isTracking') ||
			nativeCall(table, 'isDragging') ||
			nativeCall(table, 'isDecelerating')
		) {
			return;
		}
		state.rowRetries++;
		nativeCall(table, 'beginUpdates');
		nativeCall(table, 'endUpdates');
		scheduleRowCorrection(state, 80);
	}, delay);
}

function updateNativeRow(state: NativeCodeBlockState): void {
	if (!objc) return;
	nativeCall(state.label, 'invalidateIntrinsicContentSize');
	nativeCall(state.label, 'setNeedsLayout');
	nativeCall(state.cell, 'setNeedsUpdateConstraints');
	nativeCall(state.cell, 'setNeedsLayout');
	const table = tableForCell(state.cell);
	if (!table) return;
	nativeCall(table, 'beginUpdates');
	nativeCall(table, 'endUpdates');
	scheduleRowCorrection(state, 32);
}

function applyNativeSurface(state: NativeCodeBlockState, updateRow: boolean = true): boolean {
	if (!objc || state.parts.some((part) => part.height <= 0)) return false;
	const attributedText = createNativeAttachment(state);
	if (!attributedText) return false;
	state.rendered = attributedText;
	state.renderedText = nativeString(nativeCall(attributedText, 'string')) ?? null;
	applyingLabels.add(state.labelKey);
	try {
		nativeCall(state.label, 'setAttributedText:', attributedText);
		nativeCall(state.label, 'setNeedsLayout');
		if (updateRow) updateNativeRow(state);
		return true;
	} finally {
		applyingLabels.delete(state.labelKey);
	}
}

function removeNativeSurface(state: NativeCodeBlockState, restore: boolean): void {
	for (const timer of state.settleTimers) clearTimeout(timer);
	state.settleTimers = [];
	if (state.rowTimer) clearTimeout(state.rowTimer);
	state.rowTimer = null;
	state.cellHook?.remove();
	state.cellHook = null;
	for (const part of state.parts) {
		part.copyHook?.remove();
		part.copyHook = null;
	}
	if (restore && objc && state.rendered) {
		const current = nativeCall(state.label, 'attributedText') as NativeObjectHandle | null;
		const currentText = current ? nativeString(nativeCall(current, 'string')) : undefined;
		if (currentText === state.renderedText) {
			applyingLabels.add(state.labelKey);
			nativeCall(state.label, 'setAttributedText:', state.original);
			applyingLabels.delete(state.labelKey);
			updateNativeRow(state);
		}
	}
	if (surfacesByLabel.get(state.labelKey) === state) surfacesByLabel.delete(state.labelKey);
}

export function buildNativeCodeMarkup(tokens: TokenLines, lightTheme: boolean): NativeCodeMarkup {
	const parts: string[] = [];
	const spans: NativeColorSpan[] = [];
	let location = 0;
	function append(content: string, color: string): void {
		if (!content) return;
		const previous = spans[spans.length - 1];
		if (previous?.color === color && previous.location + previous.length === location) {
			previous.length += content.length;
		} else {
			spans.push({ color, length: content.length, location });
		}
		parts.push(content);
		location += content.length;
	}

	for (let lineIndex = 0; lineIndex < tokens.length; lineIndex++) {
		append(`${String(lineIndex + 1).padStart(2, ' ')} `, lightTheme ? '#8a8a8a' : '#858585');
		for (const token of tokens[lineIndex]) {
			append(token.content, token.color ?? (lightTheme ? '#333333' : '#d4d4d4'));
		}
		if (lineIndex < tokens.length - 1) {
			parts.push('\n');
			location++;
		}
	}

	return { spans, text: parts.join('') };
}

function nativeCodeAttributedString(
	tokens: TokenLines,
	lightTheme: boolean,
	overflow: 'wrap' | 'scroll',
): NativeObjectHandle | null {
	if (!objc) return null;
	try {
		const { spans, text } = buildNativeCodeMarkup(tokens, lightTheme);
		const attributedText = objc.alloc('NSMutableAttributedString');
		nativeCall(attributedText, 'initWithString:', text);
		nativeCall(
			attributedText,
			'addAttribute:value:range:',
			'NSFont',
			nativeFont(12, 0, true),
			nativeRange(0, text.length),
		);
		nativeCall(
			attributedText,
			'addAttribute:value:range:',
			'NSColor',
			nativeColor(lightTheme ? '#333333' : '#d4d4d4'),
			nativeRange(0, text.length),
		);
		if (overflow === 'wrap') {
			const paragraph = objc.alloc('NSMutableParagraphStyle');
			nativeCall(paragraph, 'setFirstLineHeadIndent:', 0);
			nativeCall(paragraph, 'setHeadIndent:', 22);
			nativeCall(
				attributedText,
				'addAttribute:value:range:',
				'NSParagraphStyle',
				paragraph,
				nativeRange(0, text.length),
			);
		}
		for (const span of spans) {
			nativeCall(
				attributedText,
				'addAttribute:value:range:',
				'NSColor',
				nativeColor(span.color),
				nativeRange(span.location, span.length),
			);
		}
		return attributedText;
	} catch {
		return null;
	}
}

function paintNativeTheme(state: NativeCodeBlockState): void {
	const appearance = themeAppearance(state.theme);
	state.lightTheme = appearance.light;
	for (const part of state.parts) {
		nativeCall(
			part.host,
			'setBackgroundColor:',
			nativeColor(appearance.background, state.opacity / 100),
		);
		nativeCall(
			part.header,
			'setBackgroundColor:',
			nativeColor(appearance.background, state.opacity / 100),
		);
		nativeCall(part.languageLabel, 'setTextColor:', nativeColor(appearance.foreground));
		nativeCall(part.codeLabel, 'setTextColor:', nativeColor(appearance.foreground));
		nativeCall(part.copyButton, 'setTitleColor:forState:', nativeColor(appearance.foreground), 0);
		if (state.iconMode === 'greyscale' && part.iconView) {
			nativeCall(part.iconView, 'setTintColor:', nativeColor(appearance.foreground));
		}
	}
}

function applyNativeTheme(state: NativeCodeBlockState, theme: ThemeName): void {
	state.theme = theme;
	state.opacity = currentOpacity();
	paintNativeTheme(state);
	void Promise.all(
		state.parts.map((part) =>
			getTokens(part.code, part.language, theme).catch((error) => {
				console.error(`Failed to tokenize ${part.language} code block:`, error);
				return null;
			}),
		),
	)
		.then((tokensByPart) => {
			if (surfacesByLabel.get(state.labelKey) !== state || state.theme !== theme) return;
			paintNativeTheme(state);
			for (let index = 0; index < state.parts.length; index++) {
				const tokens = tokensByPart[index];
				if (!tokens) continue;
				const attributedCode = nativeCodeAttributedString(tokens, state.lightTheme, state.overflow);
				if (attributedCode) {
					nativeCall(state.parts[index].codeLabel, 'setAttributedText:', attributedCode);
					fitCodeContent(state.parts[index].codeLabel);
				}
			}
		})
		.catch((error) => {
			console.error('Failed to render Shiki code blocks after a theme change:', error);
		});
}

function mountNativeCodeBlock(
	label: NativeObjectHandle,
	cell: NativeObjectHandle,
	original: NativeObjectHandle,
	placements: CodeBlockPlacement[],
): void {
	if (!objc) return;
	const key = nativeLabelKey(label);
	const previous = surfacesByLabel.get(key);
	const width = measureCodeBlockWidth(cell, label);
	if (
		previous?.parts.length === placements.length &&
		previous.parts.every(
			(part, index) =>
				part.code === placements[index].block.code &&
				part.language === placements[index].block.language &&
				part.placement.start === placements[index].start &&
				part.placement.end === placements[index].end,
		) &&
		previous.width === width &&
		previous.overflow === currentOverflow() &&
		previous.iconMode === currentIconMode()
	) {
		previous.original = original;
		previous.cell = cell;
		applyNativeSurface(previous, false);
		return;
	}
	if (previous) removeNativeSurface(previous, false);
	if (width < 80) return;
	const theme = currentTheme();
	const lightTheme = isLightTheme(theme);
	const opacity = currentOpacity();
	const overflow = currentOverflow();
	const iconMode = currentIconMode();
	const parts: NativeCodePart[] = [];
	for (const placement of placements) {
		const { code, language } = placement.block;
		const layout = codeBlockLayout(code, width, overflow);
		const nativeHost = createNativeHost(
			width,
			layout.height,
			code,
			language,
			lightTheme,
			opacity,
			overflow,
			layout.contentHeight,
			layout.contentWidth,
			iconMode,
		);
		if (!nativeHost) return;
		parts.push({
			code,
			codeLabel: nativeHost.codeLabel,
			copyButton: nativeHost.copyButton,
			copyHook: null,
			header: nativeHost.header,
			height: layout.height,
			host: nativeHost.host,
			iconView: nativeHost.iconView,
			language,
			languageLabel: nativeHost.languageLabel,
			placement,
		});
	}
	const state: NativeCodeBlockState = {
		cell,
		cellHook: null,
		iconMode,
		label,
		labelKey: key,
		lightTheme,
		opacity,
		overflow,
		original,
		parts,
		rendered: null,
		renderedText: null,
		rowRetries: 0,
		rowTimer: null,
		settleTimers: [],
		theme,
		width,
	};
	surfacesByLabel.set(key, state);
	try {
		state.cellHook = objc.hook(
			'DCDMessageTableViewCell',
			'layoutSubviews',
			{ after: () => scheduleRowCorrection(state) },
			{ instance: cell },
		);
	} catch {
		state.cellHook = null;
	}
	if (surfacesByLabel.size > MAX_SURFACES) {
		const oldestKey = surfacesByLabel.keys().next().value;
		if (oldestKey && oldestKey !== key) {
			const oldest = surfacesByLabel.get(oldestKey);
			if (oldest) removeNativeSurface(oldest, false);
		}
	}
	for (const part of parts) {
		try {
			part.copyHook = objc.hook(
				'UIButton',
				'sendActionsForControlEvents:',
				{
					after: ({ args }) => {
						if (!(Number(args[0]) & 64) || surfacesByLabel.get(key) !== state) return;
						const pasteboardClass = objc?.getClass('UIPasteboard');
						if (!pasteboardClass) return;
						const pasteboard = nativeCall(
							pasteboardClass,
							'generalPasteboard',
						) as NativeObjectHandle | null;
						if (pasteboard) nativeCall(pasteboard, 'setString:', part.code);
					},
				},
				{ instance: part.copyButton },
			);
		} catch {
			nativeCall(part.copyButton, 'setHidden:', true);
		}
	}
	if (!applyNativeSurface(state)) {
		removeNativeSurface(state, false);
		return;
	}
	for (const delay of [160, 700, 1800]) {
		state.settleTimers.push(setTimeout(() => scheduleRowCorrection(state, 0), delay));
	}
	applyNativeTheme(state, theme);
}

function renderNativeCodeBlock(label: NativeObjectHandle, original: NativeObjectHandle): void {
	if (!objc) return;
	const key = nativeLabelKey(label);
	if (applyingLabels.has(key)) return;
	const rendered = nativeString(nativeCall(original, 'string'));
	if (rendered === undefined) return;
	const previous = surfacesByLabel.get(key);
	if (rendered === previous?.renderedText) return;
	const cell = nativeCellForLabel(label);
	if (!cell) {
		if (previous) removeNativeSurface(previous, false);
		return;
	}
	const messageId = messageIdForCell(cell);
	const channelId = currentChannelId();
	if (!messageId || !channelId) return;
	const content = messageContent(channelId, messageId);
	if (content === undefined) return;
	const placements = locateCodeBlocks(parseFencedCodeBlocks(content), rendered);
	if (!placements.length || placements.some((item) => item.block.code.length > MAX_CODE_LENGTH)) {
		const previous = surfacesByLabel.get(key);
		if (previous) removeNativeSurface(previous, false);
		return;
	}
	const fallback = STORE.get('tryHljs', 'secondary');
	if (
		fallback === 'always' ||
		(fallback === 'primary' &&
			placements.some((item) => NATIVE_LANGUAGE_IDS.has(item.block.language)))
	) {
		const previous = surfacesByLabel.get(key);
		if (previous) removeNativeSurface(previous, false);
		return;
	}
	mountNativeCodeBlock(label, cell, original, placements);
}

function nativeSubviews(view: NativeObjectHandle): NativeObjectHandle[] {
	if (!objc) return [];
	const subviews = nativeCall(view, 'subviews');
	if (Array.isArray(subviews)) return subviews as NativeObjectHandle[];
	if (!subviews || typeof subviews !== 'object') return [];
	try {
		return objc.array(subviews as NativeObjectHandle);
	} catch {
		return [];
	}
}

function renderVisibleCodeBlocks(): void {
	if (!objc || !currentChannelId()) return;
	const applicationClass = objc.getClass('UIApplication');
	if (!applicationClass) return;
	const application = nativeCall(
		applicationClass,
		'sharedApplication',
	) as NativeObjectHandle | null;
	const window = application
		? (nativeCall(application, 'keyWindow') as NativeObjectHandle | null)
		: null;
	if (!window) return;
	const pending = [window];
	let inspected = 0;
	while (pending.length && inspected < 800) {
		const view = pending.pop();
		if (!view) continue;
		inspected++;
		if ((objc.className(view) ?? '').includes('DCDReusableYYLabel')) {
			const attributed = nativeCall(view, 'attributedText') as NativeObjectHandle | null;
			if (attributed) renderNativeCodeBlock(view, attributed);
			continue;
		}
		pending.push(...nativeSubviews(view));
	}
}

function installNativeRenderer(context?: PluginContext): void {
	objc = context?.native.objc ?? null;
	if (!objc) return;
	messageStore = metro.findByProps('getMessage', 'getLastMessage') as MessageStore | null;
	selectedChannel = metro.findByProps(
		'getLastSelectedChannelId',
		'getChannelId',
	) as SelectedChannel | null;
	removeSettingsListener = STORE.addListener(
		(payload) =>
			['theme', 'customTheme', 'bgOpacity', 'lineOverflow', 'tryHljs', 'useDevIcon'].includes(
				payload.key,
			),
		(payload) => {
			if (payload.key === 'lineOverflow' || payload.key === 'useDevIcon') {
				for (const state of [...surfacesByLabel.values()]) {
					removeNativeSurface(state, false);
					mountNativeCodeBlock(
						state.label,
						state.cell,
						state.original,
						state.parts.map((part) => part.placement),
					);
				}
				return;
			}
			if (payload.key === 'tryHljs') {
				for (const state of [...surfacesByLabel.values()]) {
					removeNativeSurface(state, true);
					renderNativeCodeBlock(state.label, state.original);
				}
				return;
			}
			const theme = currentTheme();
			for (const state of surfacesByLabel.values()) applyNativeTheme(state, theme);
		},
	);
	void loadLanguageCatalog()
		.then(() => {
			for (const state of surfacesByLabel.values()) {
				for (const part of state.parts) {
					const name = getLanguageMetadata(part.language)?.displayName;
					if (name) nativeCall(part.languageLabel, 'setText:', name);
				}
			}
		})
		.catch((error) => {
			console.error('Failed to load the Shiki language catalog:', error);
		});
	nativeCodeHook = objc.hook('DCDReusableYYLabel', 'setAttributedText:', {
		after: ({ self, args }) => {
			const original = args[0] as NativeObjectHandle | undefined;
			if (original) renderNativeCodeBlock(self, original);
		},
	});
	initialScanTimer = setTimeout(() => {
		initialScanTimer = null;
		if (nativeCodeHook?.active && surfacesByLabel.size === 0) renderVisibleCodeBlocks();
	}, 300);
}

export function resolveLanguage(language: unknown): LanguageId | null {
	if (typeof language !== 'string') return null;
	const name = language.trim().toLowerCase();
	return LANGUAGE_ALIASES[name] ?? resolveCatalogLanguage(name);
}

function createHighlighter(): Promise<HighlighterCore | null> {
	if (highlighterPromise) return highlighterPromise;

	highlighterPromise = createHighlighterCore({
		langs: [],
		themes: THEME_MODULES,
		engine: createJavaScriptRegexEngine({ target: 'ES2018', forgiving: true }),
	})
		.then((highlighter) => {
			loadedHighlighter = highlighter;
			return highlighter;
		})
		.catch((error) => {
			console.error('Failed to initialize the Shiki highlighter:', error);
			return null;
		});
	return highlighterPromise;
}

function cacheKey(code: string, language: LanguageId, theme: ThemeName): string {
	return `${theme}\u0000${language}\u0000${code}`;
}

async function loadGrammar(highlighter: HighlighterCore, language: LanguageId): Promise<void> {
	if (highlighter.getLoadedLanguages().includes(language)) return;
	let pending = pendingLanguages.get(language);
	if (!pending) {
		const local = LOCAL_GRAMMARS.get(language);
		pending = (
			local
				? highlighter.loadLanguage(local)
				: fetch(grammarUrl(language))
						.then((response) => {
							if (!response.ok) throw new Error(`Grammar ${language} returned ${response.status}`);
							return response.json();
						})
						.then((grammar) =>
							highlighter.loadLanguage({
								...grammar,
								name: language,
								scopeName: getLanguageMetadata(language)?.scopeName ?? grammar.scopeName,
							}),
						)
		).finally(() => pendingLanguages.delete(language));
		pendingLanguages.set(language, pending);
	}
	await pending;
}

async function loadTheme(highlighter: HighlighterCore, theme: ThemeName): Promise<void> {
	if (highlighter.getLoadedThemes().includes(theme)) return;
	let pending = pendingThemes.get(theme);
	if (!pending) {
		pending = fetch(themeUrl(theme))
			.then((response) => {
				if (!response.ok) throw new Error(`Theme ${theme} returned ${response.status}`);
				return response.json();
			})
			.then((definition) => highlighter.loadTheme({ ...definition, name: theme }))
			.finally(() => pendingThemes.delete(theme));
		pendingThemes.set(theme, pending);
	}
	await pending;
}

function rememberTokens(key: string, tokens: TokenLines): void {
	tokenCache.delete(key);
	tokenCache.set(key, tokens);
	if (tokenCache.size > MAX_CACHE_ENTRIES) {
		const oldestKey = tokenCache.keys().next().value;
		if (oldestKey !== undefined) tokenCache.delete(oldestKey);
	}
}

export async function getTokens(
	code: string,
	language: LanguageId,
	theme: ThemeName,
): Promise<TokenLines | null> {
	const key = cacheKey(code, language, theme);
	const cached = tokenCache.get(key);
	if (cached) return cached;

	const highlighter = await createHighlighter();
	if (!highlighter) return null;

	await Promise.all([loadGrammar(highlighter, language), loadTheme(highlighter, theme)]);
	const tokens = highlighter.codeToTokensBase(code, { lang: language, theme });
	rememberTokens(key, tokens);
	return tokens;
}

function ShikiSettings() {
	const state = STORE.useSettingsStore();
	const ReactNative = metro.common.ReactNative;
	const colors = getSettingsColors();
	const [themePickerOpen, setThemePickerOpen] = useState(false);
	const [fallbackPickerOpen, setFallbackPickerOpen] = useState(false);
	const [themeQuery, setThemeQuery] = useState('');
	const [customTheme, setCustomTheme] = useState(String(state.get('customTheme', '')));
	const [opacity, setOpacity] = useState(String(state.get('bgOpacity', 100)));
	const selectedTheme = String(state.get('theme', DEFAULT_THEME));
	const selectedFallback = String(state.get('tryHljs', 'secondary'));
	const fallbackOptions = [
		{ label: 'Never', value: 'never' },
		{ label: 'Prefer Shiki', value: 'secondary' },
		{ label: 'Prefer Discord highlighting', value: 'primary' },
		{ label: 'Always use Discord highlighting', value: 'always' },
	];
	const visibleThemes = THEME_IDS.filter((theme) =>
		themeLabel(theme).toLowerCase().includes(themeQuery.toLowerCase()),
	);

	function saveCustomTheme(): void {
		const url = customTheme.trim();
		if (url && (!/^https:\/\//.test(url) || !/\.json(?:\?.*)?$/.test(url))) return;
		state.set('customTheme', url);
	}

	function saveOpacity(): void {
		const value = Number(opacity);
		if (!Number.isFinite(value)) return;
		const normalized = Math.max(0, Math.min(100, Math.round(value)));
		state.set('bgOpacity', normalized);
		setOpacity(String(normalized));
	}

	return (
		<SettingsScrollView>
			<SettingsSection title='Appearance'>
				<SettingsRow
					label='Language icons'
					description='Show Devicon language marks in the code-block header.'
					trailing={state.get('useDevIcon', 'greyscale')}
					onPress={() => {
						const modes = ['disabled', 'greyscale', 'colored'];
						const current = String(state.get('useDevIcon', 'greyscale'));
						state.set('useDevIcon', modes[(modes.indexOf(current) + 1) % modes.length]);
					}}
				/>
				<SettingsRow
					label='Theme'
					description='Choose a VS Code theme for syntax colors.'
					trailing={themeLabel(selectedTheme)}
					onPress={() => setThemePickerOpen(!themePickerOpen)}
				/>
				{themePickerOpen ? (
					<SettingsCard>
						<ReactNative.TextInput
							value={themeQuery}
							onChangeText={setThemeQuery}
							placeholder='Search themes'
							placeholderTextColor={colors.muted}
							style={{ color: colors.text, fontSize: 16, minHeight: 44 }}
						/>
						{visibleThemes.map((theme) => (
							<ReactNative.Pressable
								key={theme}
								onPress={() => {
									state.set('theme', theme);
									setThemePickerOpen(false);
								}}
								style={{ minHeight: 40, justifyContent: 'center' }}
							>
								<ReactNative.Text style={{ color: colors.text, fontSize: 15 }}>
									{themeLabel(theme)}
									{selectedTheme === theme ? ' ✓' : ''}
								</ReactNative.Text>
							</ReactNative.Pressable>
						))}
					</SettingsCard>
				) : null}
				<SettingsCard>
					<ReactNative.Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>
						Custom theme URL
					</ReactNative.Text>
					<ReactNative.Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>
						An HTTPS link to a VS Code theme JSON file overrides the selected theme.
					</ReactNative.Text>
					<ReactNative.TextInput
						value={customTheme}
						onChangeText={setCustomTheme}
						onEndEditing={saveCustomTheme}
						onSubmitEditing={saveCustomTheme}
						autoCapitalize='none'
						placeholder='https://example.com/theme.json'
						placeholderTextColor={colors.muted}
						style={{ color: colors.text, fontSize: 14, minHeight: 44 }}
					/>
				</SettingsCard>
				<SettingsCard>
					<ReactNative.Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>
						Background opacity (%)
					</ReactNative.Text>
					<ReactNative.TextInput
						value={opacity}
						onChangeText={setOpacity}
						onEndEditing={saveOpacity}
						onSubmitEditing={saveOpacity}
						keyboardType='number-pad'
						style={{ color: colors.text, fontSize: 16, minHeight: 44 }}
					/>
				</SettingsCard>
			</SettingsSection>
			<SettingsSection title='Highlighting'>
				<SettingsRow
					label='Long lines'
					description='Choose between wrapping code and scrolling horizontally.'
					trailing={state.get('lineOverflow', 'wrap') === 'scroll' ? 'Horizontal scroll' : 'Wrap'}
					onPress={() =>
						state.set(
							'lineOverflow',
							state.get('lineOverflow', 'wrap') === 'scroll' ? 'wrap' : 'scroll',
						)
					}
				/>
				<SettingsRow
					label='Highlighting preference'
					description='Choose when Discord’s built-in highlighter takes priority.'
					trailing={fallbackOptions.find((option) => option.value === selectedFallback)?.label}
					onPress={() => setFallbackPickerOpen(!fallbackPickerOpen)}
				/>
				{fallbackPickerOpen ? (
					<SettingsCard>
						{fallbackOptions.map((option) => (
							<ReactNative.Pressable
								key={option.value}
								onPress={() => {
									state.set('tryHljs', option.value);
									setFallbackPickerOpen(false);
								}}
								style={{ minHeight: 42, justifyContent: 'center' }}
							>
								<ReactNative.Text style={{ color: colors.text, fontSize: 15 }}>
									{option.label}
									{selectedFallback === option.value ? ' ✓' : ''}
								</ReactNative.Text>
							</ReactNative.Pressable>
						))}
					</SettingsCard>
				) : null}
			</SettingsSection>
		</SettingsScrollView>
	);
}

export default {
	start(context?: PluginContext) {
		if (started) return;
		started = true;
		installNativeRenderer(context);
	},
	stop() {
		started = false;
		if (initialScanTimer) clearTimeout(initialScanTimer);
		initialScanTimer = null;
		nativeCodeHook?.remove();
		nativeCodeHook = null;
		removeSettingsListener?.();
		removeSettingsListener = null;
		for (const state of surfacesByLabel.values()) removeNativeSurface(state, true);
		surfacesByLabel.clear();
		applyingLabels.clear();
		objc = null;
		messageStore = null;
		selectedChannel = null;
		highlighterPromise = null;
		loadedHighlighter = null;
		tokenCache.clear();
		nativeColors.clear();
		nativeImages.clear();
	},
	getSettingsPanel: () => <ShikiSettings />,
};
