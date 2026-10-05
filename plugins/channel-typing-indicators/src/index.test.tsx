import { afterEach, describe, expect, mock, test } from 'bun:test';

let patchHandler: ((context: any) => any) | null = null;
let unpatchCount = 0;
let moduleListenerCount = 0;
let moduleAvailable = true;
const target = { type: () => null };
const typingListeners = new Set<() => void>();
const typingStore = {
	getTypingUsers: () => ({}),
	addChangeListener(listener: () => void) {
		typingListeners.add(listener);
	},
	removeChangeListener(listener: () => void) {
		typingListeners.delete(listener);
	},
};
const react = {
	createElement(type: any, props: any, ...children: any[]) {
		return { type, props: { ...props, children: children.length === 1 ? children[0] : children } };
	},
	cloneElement(element: any, props: any, children: any) {
		return { ...element, props: { ...element.props, ...props, children } };
	},
	useState(initial: any) {
		return [typeof initial === 'function' ? initial() : initial, () => {}];
	},
	useEffect(effect: () => void | (() => void)) {
		effect();
	},
};

mock.module('@unbound-app/api', () => ({
	metro: {
		common: {
			React: react,
			Theme: {
				colors: { TEXT_MUTED: 'muted' },
				internal: { resolveSemanticColor: () => '#96979e' },
				themes: { DARK: 'darker' },
			},
		},
		find: () => ({ theme: 'darker' }),
		findByProps: (...props: string[]) => {
			if (props.includes('getTypingUsers')) return typingStore;
			if (props.includes('getCurrentUser'))
				return { getCurrentUser: () => ({ id: 'self' }), getUser: () => null };
			if (props.includes('isChannelMuted')) return { isChannelMuted: () => false };
			if (props.includes('isBlocked')) return { isBlocked: () => false };
			return {};
		},
		findByFilePath: () => (moduleAvailable ? { default: target } : null),
		addListener: () => {
			moduleListenerCount++;
			return () => true;
		},
	},
	patcher: {
		after: (_holder: any, _key: string, handler: (context: any) => any) => {
			patchHandler = handler;
			return () => {
				unpatchCount++;
			};
		},
	},
	storage: { getStore: () => ({ useSettingsStore: () => ({ get: () => false }) }) },
}));

mock.module('@shared/settings-ui', () => ({
	SettingsScrollView: () => null,
	SettingsSection: () => null,
	SettingsSwitchRow: () => null,
}));

const {
	default: plugin,
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

afterEach(() => {
	plugin.stop();
	patchHandler = null;
	unpatchCount = 0;
	moduleListenerCount = 0;
	moduleAvailable = true;
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
		expect(unpatchCount).toBe(1);
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

	test('waits for a late-loaded channel module', () => {
		moduleAvailable = false;
		plugin.start();
		expect(moduleListenerCount).toBe(1);
		expect(patchHandler).toBeNull();
	});
});
