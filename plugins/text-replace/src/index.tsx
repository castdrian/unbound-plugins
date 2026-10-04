import { metro, patcher, storage } from '@unbound-app/api';

import {
	applyRules,
	normalizeRules,
	TEXT_REPLACE_RULES_CHANNEL_ID,
	type TextReplaceRule,
} from '@text-replace/rules';
import { TextReplaceSettingsScreen } from '@text-replace/settings';

const STORE = storage.getStore('unbound.text-replace');
const RIGHT_ACTIONS_PATH = 'modules/chat_input/native/action_buttons/ChatInputRightActions.tsx';
const CHANNEL_MESSAGE_DRAFT_TYPE = 0;
const INDICATOR_MAX_WIDTH = 150;
const unpatches: Array<() => void> = [];
let drafts: any = null;
let selectedChannel: any = null;
let removeModuleListener: (() => boolean) | null = null;
let rightActionsPatched = false;

function getRules(kind: 'stringRules' | 'regexRules'): TextReplaceRule[] {
	return normalizeRules(STORE.get(kind, []));
}

function findMessageArg(args: unknown[]): { content?: string } | null {
	for (const arg of args) {
		if (arg && typeof arg === 'object' && typeof (arg as { content?: unknown }).content === 'string') {
			return arg as { content?: string };
		}
	}

	return null;
}

function findChannelId(args: unknown[]): string | null {
	return typeof args[0] === 'string' ? args[0] : null;
}

function transformMessage(ctx: { args: unknown[] }): void {
	if (findChannelId(ctx.args) === TEXT_REPLACE_RULES_CHANNEL_ID) return;

	const message = findMessageArg(ctx.args);
	if (!message?.content) return;

	message.content = applyRules(message.content, getRules('stringRules'), getRules('regexRules'));
}

function unwrapComponent(mod: any): { holder: any; prop: string } | null {
	let holder = mod;
	let prop = 'default';
	let current = mod?.default;
	let depth = 0;

	while (current && typeof current === 'object' && depth < 5) {
		const next = current.type !== undefined ? 'type' : current.render !== undefined ? 'render' : null;
		if (!next) break;

		holder = current;
		prop = next;
		current = current[next];
		depth++;
	}

	return typeof current === 'function' ? { holder, prop } : null;
}

function modulePath(id: string): string | undefined {
	return (globalThis as any).window?.modules?.get(id)?.__filePath;
}

function getIndicatorColors(): { background: string; text: string } {
	const colors = (metro.common.Theme as any)?.colors ?? {};
	return {
		background: typeof colors.BACKGROUND_ACCENT === 'string' ? colors.BACKGROUND_ACCENT : '#4752c4',
		text: typeof colors.TEXT_NORMAL === 'string' ? colors.TEXT_NORMAL : '#f2f3f5',
	};
}

function TextReplaceIndicator({ channelId }: { channelId: string }) {
	const { React, ReactNative } = metro.common;
	const draft = React.useSyncExternalStore(
		(onChange: () => void) => {
			if (typeof drafts?.addChangeListener !== 'function') return () => undefined;
			drafts.addChangeListener(onChange);
			return () => drafts.removeChangeListener?.(onChange);
		},
		() => drafts?.getDraft?.(channelId, CHANNEL_MESSAGE_DRAFT_TYPE) ?? '',
	);
	const transformed = applyRules(draft, getRules('stringRules'), getRules('regexRules'));
	if (!draft || transformed === draft) return null;

	const colors = getIndicatorColors();
	const preview = transformed.replace(/\s+/g, ' ').trim();
	return (
		<ReactNative.View
			pointerEvents='none'
			style={{
				backgroundColor: colors.background,
				borderRadius: 8,
				justifyContent: 'center',
				marginRight: 4,
				maxWidth: INDICATOR_MAX_WIDTH,
				minHeight: 32,
				paddingHorizontal: 8,
			}}
		>
			<ReactNative.Text numberOfLines={1} ellipsizeMode='tail' style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>
				{`→ ${preview}`}
			</ReactNative.Text>
		</ReactNative.View>
	);
}

function patchRightActions(mod: any): boolean {
	const target = unwrapComponent(mod);
	if (!target || rightActionsPatched) return false;

	const unpatch = patcher.after(target.holder, target.prop, (ctx) => {
		try {
			const result = ctx.result as any;
			if (!result?.props || !drafts) return;

			const channelId = (ctx.args[0] as any)?.channel?.id ?? selectedChannel?.getChannelId?.();
			if (!channelId) return;

			const { React } = metro.common;
			const children = React.Children.toArray(result.props.children);
			children.unshift(<TextReplaceIndicator key='text-replace-indicator' channelId={channelId} />);
			return React.cloneElement(result, null, ...children);
		} catch { }
	});

	unpatches.push(unpatch);
	rightActionsPatched = true;
	return true;
}

function waitForRightActions(): void {
	const existing = metro.findByFilePath(RIGHT_ACTIONS_PATH, { interop: false });
	if (patchRightActions(existing)) return;

	removeModuleListener = metro.addListener((module, id) => {
		if (modulePath(id) !== RIGHT_ACTIONS_PATH || !patchRightActions(module)) return;
		removeModuleListener?.();
		removeModuleListener = null;
	});
}

export default {
	start() {
		STORE.set('stringRules', getRules('stringRules'));
		STORE.set('regexRules', getRules('regexRules'));
		drafts = metro.findByProps('getDraft');
		selectedChannel = metro.findByProps('getLastSelectedChannelId', 'getChannelId');

		const messageActions = metro.findByProps('sendMessage', 'editMessage') as {
			sendMessage?: unknown;
		} | null;
		if (typeof messageActions?.sendMessage !== 'function') return;

		unpatches.push(patcher.before(messageActions, 'sendMessage', transformMessage));
		if (drafts?.getDraft && selectedChannel) waitForRightActions();
	},

	stop() {
		while (unpatches.length) unpatches.pop()!();
		removeModuleListener?.();
		removeModuleListener = null;
		drafts = null;
		selectedChannel = null;
		rightActionsPatched = false;
	},

	getSettingsPanel: () => <TextReplaceSettingsScreen />,
};
