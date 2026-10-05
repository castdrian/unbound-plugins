import { afterEach, describe, expect, mock, test } from 'bun:test';

let patchHandler: ((context: any) => any) | null = null;
let threadPatchHandler: ((context: any) => any) | null = null;
let threadRendererPatchHandler: ((context: any) => any) | null = null;
let unpatchCount = 0;
let moduleListenerCount = 0;
let moduleAvailable = true;
let selectedChannelId: string | null = null;
let typingUserSnapshot: Record<string, number> = {};
let nextDotIndex = 0;
let dotAnimation: any = null;
const settingsValues = new Map<string, unknown>();
const target = { type: () => null };
const threadModule = { default: () => null };
const typingListeners = new Set<() => void>();
const typingStore = {
	getTypingUsers: () => typingUserSnapshot,
	addChangeListener(listener: () => void) {
		typingListeners.add(listener);
	},
	removeChangeListener(listener: () => void) {
		typingListeners.delete(listener);
	},
};
const react = {
	createElement(type: any, props: any, ...children: any[]) {
		return {
			type,
			props: {
				...props,
				children: children.length
					? children.length === 1
						? children[0]
						: children
					: props?.children,
			},
		};
	},
	cloneElement(element: any, props: any, ...children: any[]) {
		return {
			...element,
			props: {
				...element.props,
				...props,
				children: children.length ? children[0] : element.props.children,
			},
		};
	},
	useState(initial: any) {
		return [typeof initial === 'function' ? initial() : initial, () => {}];
	},
	useEffect(effect: () => void | (() => void)) {
		effect();
	},
	useRef(value: unknown) {
		return { current: value };
	},
};
const animated = {
	Value: class {
		index = nextDotIndex++;
		constructor(_value: number) {}
	},
	View: 'AnimatedView',
	timing(value: { index: number }, options: { toValue: number }) {
		return { kind: 'timing', index: value.index, toValue: options.toValue };
	},
	parallel(children: any[]) {
		return { kind: 'parallel', children };
	},
	sequence(children: any[]) {
		return { kind: 'sequence', children };
	},
	delay(duration: number) {
		return { kind: 'delay', duration };
	},
	loop(sequence: any) {
		dotAnimation = sequence;
		return { start() {}, stop() {} };
	},
};

mock.module('@unbound-app/api', () => ({
	metro: {
		common: {
			React: react,
			ReactNative: { View: 'View', Animated: animated },
			Theme: {
				colors: { TEXT_MUTED: 'muted' },
				internal: { resolveSemanticColor: () => '#96979e' },
				themes: { DARK: 'darker' },
			},
		},
		find: () => ({ theme: 'darker' }),
		findByProps: (...props: string[]) => {
			if (props.includes('getTypingUsers')) return typingStore;
			if (props.includes('getChannelId')) return { getChannelId: () => selectedChannelId };
			if (props.includes('getCurrentUser'))
				return { getCurrentUser: () => ({ id: 'self' }), getUser: (id: string) => ({ id }) };
			if (props.includes('isChannelMuted')) return { isChannelMuted: () => false };
			if (props.includes('isBlocked')) return { isBlocked: () => false };
			return {};
		},
		findByFilePath: (path: string) =>
			moduleAvailable
				? path.includes('ThreadChannel')
					? threadModule
					: { default: target }
				: null,
		addListener: () => {
			moduleListenerCount++;
			return () => true;
		},
	},
	patcher: {
		after: (_holder: any, key: string, handler: (context: any) => any) => {
			if (key === 'default') threadPatchHandler = handler;
			else if (key === 'render') threadRendererPatchHandler = handler;
			else patchHandler = handler;
			return () => {
				unpatchCount++;
			};
		},
	},
	storage: {
		getStore: () => ({
			useSettingsStore: () => ({
				get: (key: string, fallback: unknown) => settingsValues.get(key) ?? fallback,
				set: (key: string, value: unknown) => settingsValues.set(key, value),
			}),
		}),
	},
}));

mock.module('@shared/settings-ui', () => ({
	SettingsRow: () => null,
	SettingsScrollView: () => null,
	SettingsSection: () => null,
	SettingsSwitchRow: () => null,
}));

const {
	default: plugin,
	insertThreadTypingIndicator,
	insertTypingIndicator,
	sameIds,
	visibleTypingIds,
} = await import('@channel-typing-indicators/index');

function channelRow(channelId: string) {
	const channel = { id: channelId, guild_id: 'guild' };
	const info = { type: 'ChannelInfo', props: { channel } };
	const content = {
		type: 'View',
		props: { children: [{ type: 'Icon' }, { type: 'Text' }, info] },
	};
	const row = {
		type: 'Pressable',
		props: { accessibilityRole: 'button', children: [false, content] },
	};
	return { type: 'Root', props: { children: [null, row, false] } };
}

function threadRow(channelId: string): any {
	const channel = { id: channelId, guild_id: 'guild', type: 11 };
	const row = {
		type: 'ThreadRow',
		props: { channel, accessibilityRole: 'button', channelInfo: null },
	};
	const container = { type: 'View', props: { children: [false, null, row] } };
	return { type: 'Fragment', props: { children: [null, null, container] } };
}

afterEach(() => {
	plugin.stop();
	patchHandler = null;
	threadPatchHandler = null;
	threadRendererPatchHandler = null;
	unpatchCount = 0;
	moduleListenerCount = 0;
	moduleAvailable = true;
	selectedChannelId = null;
	typingUserSnapshot = {};
	nextDotIndex = 0;
	dotAnimation = null;
	settingsValues.clear();
	typingListeners.clear();
});

describe('channel typing user selection', () => {
	test('hides the current user and blocked users by default', () => {
		const typing = { self: 1, blocked: 2, visible: 3 };
		expect(visibleTypingIds(typing, 'self', (id) => id === 'blocked', false)).toEqual(['visible']);
	});

	test('optionally includes blocked users while still hiding the current user', () => {
		const typing = { self: 1, blocked: 2, visible: 3 };
		expect(visibleTypingIds(typing, 'self', () => true, true)).toEqual(['blocked', 'visible']);
	});

	test('hides ignored users unless they are explicitly included', () => {
		const typing = { ignored: 1, visible: 2 };
		expect(
			visibleTypingIds(
				typing,
				undefined,
				() => false,
				false,
				(id) => id === 'ignored',
				false,
			),
		).toEqual(['visible']);
		expect(
			visibleTypingIds(
				typing,
				undefined,
				() => false,
				false,
				(id) => id === 'ignored',
				true,
			),
		).toEqual(['ignored', 'visible']);
	});

	test('ignores unchanged typing snapshots', () => {
		expect(sameIds(['a', 'b'], ['a', 'b'])).toBe(true);
		expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(false);
		expect(sameIds(['a'], ['a', 'b'])).toBe(false);
	});
});

describe('channel row integration', () => {
	test('inserts the indicator inside the original row before channel info', () => {
		const channel = { id: 'channel', guild_id: 'guild' };
		const original = channelRow(channel.id);
		const updated = insertTypingIndicator(original, channel, false);
		const row = updated.props.children[1];
		const children = row.props.children[1].props.children;

		expect(updated.type).toBe('Root');
		expect(row.type).toBe('Pressable');
		expect(children).toHaveLength(4);
		expect(children[2].props.channel).toBe(channel);
		expect(children[3].type).toBe('ChannelInfo');
		expect(insertTypingIndicator(updated, channel, false)).toBe(updated);
	});

	test('does not alter an unfamiliar row layout', () => {
		const original = { type: 'Root', props: { children: ['unchanged'] } };
		expect(insertTypingIndicator(original, { id: 'channel' }, false)).toBe(original);
	});

	test('adds typing to thread rows without replacing their native layout', () => {
		const channel = { id: 'thread', guild_id: 'guild' };
		const original = threadRow(channel.id);
		const updated = insertThreadTypingIndicator(original, channel, false);
		const row = updated.props.children[2].props.children[2];
		expect(updated.type).toBe('Fragment');
		expect(row.type).toBe('ThreadRow');
		expect(row.props.channelInfo.props.channel).toBe(channel);
		expect(insertThreadTypingIndicator(updated, channel, false)).toBe(updated);
	});

	test('preserves existing thread channel information', () => {
		const channel = { id: 'thread', guild_id: 'guild' };
		const original = threadRow(channel.id);
		original.props.children[2].props.children[2].props.channelInfo = {
			type: 'ExistingBadge',
			props: {},
		};
		const updated = insertThreadTypingIndicator(original, channel, false);
		const info = updated.props.children[2].props.children[2].props.channelInfo;
		expect(info.props.children[0].type).toBe('ExistingBadge');
		expect(info.props.children[1].props.channel).toBe(channel);
		expect(insertThreadTypingIndicator(updated, channel, false)).toBe(updated);
	});

	test('installs one patch and removes it on stop', () => {
		plugin.start();
		plugin.start();
		expect(patchHandler).toBeFunction();
		expect(moduleListenerCount).toBe(0);

		const original = channelRow('channel');
		const updated = patchHandler?.({
			args: [{ channel: { id: 'channel', guild_id: 'guild' }, muted: false }],
			result: original,
		});
		expect(updated.props.children[1].props.children[1].props.children).toHaveLength(4);

		plugin.stop();
		expect(unpatchCount).toBe(2);
	});

	test('patches the rendered thread row and removes both thread hooks on stop', () => {
		plugin.start();
		const outer = threadPatchHandler?.({
			result: { type: () => null, props: { channel: { id: 'thread' } } },
		});
		expect(outer.type).toBeFunction();
		const channel = { id: 'thread', guild_id: 'guild' };
		const updated = threadRendererPatchHandler?.({
			args: [{ channel, muted: false }],
			result: threadRow(channel.id),
		});
		expect(updated.props.children[2].props.children[2].props.channelInfo.props.channel).toBe(
			channel,
		);
		plugin.stop();
		expect(unpatchCount).toBe(3);
	});

	test('removes mounted row listeners when disabled', () => {
		plugin.start();
		const original = channelRow('channel');
		const updated = patchHandler?.({
			args: [{ channel: { id: 'channel', guild_id: 'guild' }, muted: false }],
			result: original,
		});
		const indicator = updated.props.children[1].props.children[1].props.children[2];
		indicator.type(indicator.props);
		expect(typingListeners.size).toBe(1);

		plugin.stop();
		expect(typingListeners.size).toBe(0);
	});

	test('can hide the selected channel without hiding other typing channels', () => {
		settingsValues.set('includeCurrentChannel', false);
		selectedChannelId = 'channel';
		typingUserSnapshot = { other: 1 };
		plugin.start();
		const updated = patchHandler?.({
			args: [{ channel: { id: 'channel', guild_id: 'guild' }, muted: false }],
			result: channelRow('channel'),
		});
		const indicator = updated.props.children[1].props.children[1].props.children[2];
		expect(indicator.type(indicator.props)).toBeNull();
		selectedChannelId = 'different';
		expect(indicator.type(indicator.props)).not.toBeNull();
	});

	test('supports avatars-only and dots-only display modes', () => {
		typingUserSnapshot = { other: 1 };
		plugin.start();
		const updated = patchHandler?.({
			args: [{ channel: { id: 'channel', guild_id: 'guild' }, muted: false }],
			result: channelRow('channel'),
		});
		const indicator = updated.props.children[1].props.children[1].props.children[2];
		settingsValues.set('indicatorMode', 2);
		const avatarsOnly = indicator.type(indicator.props);
		expect(avatarsOnly.props.children[0]).not.toBeNull();
		expect(avatarsOnly.props.children[1]).toBeNull();
		settingsValues.set('indicatorMode', 1);
		const dotsOnly = indicator.type(indicator.props);
		expect(dotsOnly.props.children[0]).toBeNull();
		expect(dotsOnly.props.children[1]).not.toBeNull();
	});

	test('animates the dots from left to right', () => {
		typingUserSnapshot = { other: 1 };
		plugin.start();
		const updated = patchHandler?.({
			args: [{ channel: { id: 'channel', guild_id: 'guild' }, muted: false }],
			result: channelRow('channel'),
		});
		const indicator = updated.props.children[1].props.children[1].props.children[2];
		const dots = indicator.type(indicator.props).props.children[1];
		dots.type(dots.props);
		const brightening = dotAnimation.children
			.flatMap((step: any) => (step.kind === 'parallel' ? step.children : [step]))
			.filter((step: any) => step.kind === 'timing' && step.toValue === 1)
			.map((step: any) => step.index);
		expect(brightening).toEqual([0, 1, 2]);
	});

	test('waits for a late-loaded channel module', () => {
		moduleAvailable = false;
		plugin.start();
		expect(moduleListenerCount).toBe(1);
		expect(patchHandler).toBeNull();
	});
});
