import { afterEach, describe, expect, mock, test } from 'bun:test';

const removed: string[] = [];
const hooks: string[] = [];
const nativeCalls: string[] = [];
const channelListeners = new Set<() => void>();

const selectedChannel = {
	addChangeListener: (listener: () => void) => channelListeners.add(listener),
	getChannelId: () => 'channel',
	getLastSelectedChannelId: () => 'channel',
	removeChangeListener: (listener: () => void) => channelListeners.delete(listener),
};

const native = {
	objc: {
		array: (value: unknown) => value,
		alloc: (value: unknown) => value,
		className: (target: { name?: string }) =>
			target?.name === 'cell' ? 'DCDMessageTableViewCell' : 'UIView',
		data: () => ({ imageData: true }),
		getClass: (name: string) => ({ name }),
		getIvar: () => null,
		invoke: (target: { name?: string }, selector: string) => {
			nativeCalls.push(`${target.name}:${selector}`);
			if (target.name === 'UIApplication' && selector === 'sharedApplication')
				return { name: 'application' };
			if (target.name === 'application' && selector === 'windows') return [{ name: 'window' }];
			if (target.name === 'window' && selector === 'subviews') return [{ name: 'cell' }];
			if (target.name === 'cell' && selector === 'window') return { name: 'window' };
			if (target.name === 'cell' && selector === 'hash') return 1;
			if (target.name === 'cell' && selector === 'subviews') return [];
			return null;
		},
		hook: (_className: string, selector: string) => {
			hooks.push(selector);
			return {
				active: true,
				remove: () => removed.push(selector),
			};
		},
		respondsTo: (target: { name?: string }, selector: string) =>
			(target.name === 'cell' && selector === 'hash') ||
			((target.name === 'window' || target.name === 'cell') && selector === 'subviews'),
		struct: (name: string, fields: unknown) => ({ name, fields }),
	},
};

const target = { generateMessageRowData: () => undefined };

mock.module('@unbound-app/api', () => ({
	metro: {
		find: () => ({ getRole: () => undefined, getSortedRoles: () => [] }),
		findByProps: (...props: string[]) => {
			if (props.includes('generateMessageRowData')) return target;
			if (props.includes('getLastSelectedChannelId')) return selectedChannel;
			if (props.includes('getChannelId')) return selectedChannel;
			if (props.includes('getChannel')) return { getChannel: () => undefined };
			if (props.includes('getCurrentUser')) return { getUser: () => undefined };
			return undefined;
		},
		findStore: (name: string) => {
			if (name === 'Message') return { getMessages: () => ({ _array: [] }) };
			return {};
		},
		patcher: {
			after: () => () => undefined,
		},
	},
	patcher: {
		after: () => () => undefined,
	},
	storage: {
		getStore: () => ({
			get: (_key: string, fallback: unknown) => fallback,
		}),
	},
}));

const {
	cellRenderDecision,
	containsMentionText,
	default: plugin,
	extractMentionTokens,
	imageCacheAction,
	mentionImageMetrics,
	roleIconColorSource,
	roleImageSource,
	roleSymbolTransformScale,
	ROLE_SYMBOL_METRICS,
	selectMentionLabel,
	shouldHandleChannelChange,
} = await import('@mention-avatars/index');

afterEach(() => {
	plugin.stop?.();
	hooks.length = 0;
	removed.length = 0;
	nativeCalls.length = 0;
	channelListeners.clear();
});

describe('mention token matching', () => {
	test('preserves message order for adjacent user and role mentions', () => {
		expect(extractMentionTokens('Hi <@123> and <@&456>')).toEqual([
			{ id: '123', type: 'user' },
			{ id: '456', type: 'role' },
		]);
	});

	test('matches the complete visible label instead of a shared prefix', () => {
		expect(selectMentionLabel('@autosupport', ['auto', 'autosupport'])).toBe('autosupport');
		expect(selectMentionLabel('@dylib.dev\u2069', ['autosupport', 'dylib.dev'])).toBe('dylib.dev');
		expect(selectMentionLabel('@autosupporter', ['autosupport'])).toBeUndefined();
	});

	test('checks every mention label before replacing a saved string', () => {
		expect(
			containsMentionText('@autosupport @dylib.dev', [
				{ labels: ['autosupport'], type: 'user' },
				{ labels: ['dylib.dev'], type: 'user' },
			]),
		).toBe(true);
		expect(containsMentionText('@autosupporter', [{ labels: ['autosupport'], type: 'user' }])).toBe(
			false,
		);
	});
});

describe('mention image decisions', () => {
	test('matches the verified SE role symbol size and crop offset', () => {
		expect(ROLE_SYMBOL_METRICS).toEqual({ pointSize: 14, rasterScale: 2, tx: 4, ty: 5.375 });
	});

	test('normalizes SF Symbol raster scale across device pixel densities', () => {
		expect(roleSymbolTransformScale(2)).toBe(1);
		expect(roleSymbolTransformScale(3)).toBeCloseTo(2 / 3);
		expect(roleSymbolTransformScale(0)).toBe(1);
	});

	test('uses the original role and user attachment metrics', () => {
		expect(mentionImageMetrics('role')).toEqual({ leading: 4, size: 16, trailing: 2 });
		expect(mentionImageMetrics('user')).toEqual({ leading: 2, size: 16, trailing: 4 });
	});

	test('falls back to role color when the role has no custom icon', () => {
		expect(roleImageSource({ id: '123', color: 0x336699, icon: null })).toEqual({
			avatarURL: undefined,
			roleColor: 0x336699,
		});
	});

	test('prefers the attributed foreground color for role icons', () => {
		expect(roleIconColorSource({}, 0x336699)).toBe('foreground');
		expect(roleIconColorSource(null, 0x336699)).toBe('role');
		expect(roleIconColorSource(null, undefined)).toBe('label');
	});

	test('does not start duplicate image requests while pending or in retry delay', () => {
		const pending = Promise.resolve(null);
		expect(imageCacheAction({ image: null, pending }, 100)).toBe('pending');
		expect(imageCacheAction({ image: null, retryAt: 200 }, 100)).toBe('retry');
		expect(imageCacheAction({ image: null, retryAt: 100 }, 100)).toBe('load');
	});
});

describe('mention channel lifecycle', () => {
	test('ignores store notifications that keep the selected channel', () => {
		expect(shouldHandleChannelChange('channel', 'channel')).toBe(false);
	});

	test('handles transitions to a different or unavailable channel', () => {
		expect(shouldHandleChannelChange('channel', 'another-channel')).toBe(true);
		expect(shouldHandleChannelChange('channel', undefined)).toBe(true);
		expect(shouldHandleChannelChange(undefined, 'channel')).toBe(true);
	});
});

describe('cell reuse rendering', () => {
	test('retries when a reused cell has unresolved message data', () => {
		expect(cellRenderDecision('message', true, true, [])).toBe('retry');
		expect(cellRenderDecision('message', false, false, [])).toBe('retry');
	});

	test('renders known mentions and idles for an empty cell', () => {
		expect(cellRenderDecision('message', true, false, [{ labels: ['member'], type: 'user' }])).toBe(
			'render',
		);
		expect(cellRenderDecision(undefined, true, false, [])).toBe('idle');
	});
});

describe('mention avatars native lifecycle', () => {
	test('installs generic cell lifecycle hooks through the scoped native facade', () => {
		plugin.start?.({ native } as never);

		expect(hooks).toEqual(['didMoveToWindow', 'layoutSubviews', 'prepareForReuse']);
	});

	test('removes every native hook when the plugin stops', () => {
		plugin.start?.({ native } as never);
		plugin.stop?.();

		expect(removed).toEqual(['didMoveToWindow', 'layoutSubviews', 'prepareForReuse']);
	});

	test('rescans cells on channel changes and removes the listener when stopped', () => {
		plugin.start?.({ native } as never);

		expect(channelListeners.size).toBe(1);

		plugin.stop?.();

		expect(channelListeners.size).toBe(0);
	});

	test('scans message cells through the active application windows', async () => {
		plugin.start?.({ native } as never);

		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(nativeCalls).toContain('UIApplication:sharedApplication');
		expect(nativeCalls).toContain('application:windows');
		expect(nativeCalls).toContain('cell:window');
	});
});
