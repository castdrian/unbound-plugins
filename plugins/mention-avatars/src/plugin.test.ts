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

const plugin = await import('./index');

afterEach(() => {
	plugin.default.stop?.();
	hooks.length = 0;
	removed.length = 0;
});

describe('mention avatars native lifecycle', () => {
	test('installs generic hooks through the scoped native facade', () => {
		plugin.default.start?.({ native } as never);

		expect(hooks).toEqual(['didMoveToWindow', 'layoutSubviews', 'prepareForReuse']);
	});

	test('removes every native hook when the plugin stops', () => {
		plugin.default.start?.({ native } as never);
		plugin.default.stop?.();

		expect(removed).toEqual(['didMoveToWindow', 'layoutSubviews', 'prepareForReuse']);
	});
});
