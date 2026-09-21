import { afterEach, describe, expect, mock, test } from 'bun:test';

const removed: string[] = [];
const hooks: string[] = [];

const native = {
	objc: {
		alloc: (value: unknown) => value,
		className: () => 'DCDMessageTableViewCell',
		data: () => ({ imageData: true }),
		getClass: (name: string) => ({ name }),
		getIvar: () => null,
		invoke: (target: { name?: string }, selector: string) => {
			if (target.name === 'UIWindow' && selector === 'keyWindow') return null;
			return null;
		},
		hook: (_className: string, selector: string) => {
			hooks.push(selector);
			return {
				active: true,
				remove: () => removed.push(selector),
			};
		},
		respondsTo: () => false,
		struct: (name: string, fields: unknown) => ({ name, fields }),
	},
};

const target = { generateMessageRowData: () => undefined };

mock.module('@unbound-app/api', () => ({
	metro: {
		find: () => ({ getRole: () => undefined, getSortedRoles: () => [] }),
		findByProps: (...props: string[]) => {
			if (props.includes('generateMessageRowData')) return target;
			if (props.includes('getChannelId')) return { getChannelId: () => 'channel' };
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
		getStore: () => ({ get: (_key: string, fallback: unknown) => fallback }),
	},
}));

const {
	cellRenderDecision,
	containsMentionText,
	default: plugin,
	extractMentionTokens,
	imageCacheAction,
	mentionImageMetrics,
	roleImageSource,
	selectMentionLabel,
} = await import('@mention-avatars/index');

afterEach(() => {
	plugin.stop?.();
	hooks.length = 0;
	removed.length = 0;
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

	test('does not start duplicate image requests while pending or in retry delay', () => {
		const pending = Promise.resolve(null);
		expect(imageCacheAction({ image: null, pending }, 100)).toBe('pending');
		expect(imageCacheAction({ image: null, retryAt: 200 }, 100)).toBe('retry');
		expect(imageCacheAction({ image: null, retryAt: 100 }, 100)).toBe('load');
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
	test('installs generic hooks through the scoped native facade', () => {
		plugin.start?.({ native } as never);

		expect(hooks).toEqual(['didMoveToWindow', 'layoutSubviews', 'prepareForReuse']);
	});

	test('removes every native hook when the plugin stops', () => {
		plugin.start?.({ native } as never);
		plugin.stop?.();

		expect(removed).toEqual(['didMoveToWindow', 'layoutSubviews', 'prepareForReuse']);
	});
});
