import { expect, mock, test } from 'bun:test';

let actionSheetHandler: ((context: { args: unknown[] }) => void) | null = null;

mock.module('@unbound-app/api', () => ({
	metro: {
		findByName: () => null,
		findByFilePath: () => null,
		findByProps: (...names: string[]) => (names.includes('openLazy') ? { openLazy() {} } : null),
	},
	patcher: {
		createPatcher: () => ({
			after() {},
			before(_target: unknown, method: string, handler: typeof actionSheetHandler) {
				if (method === 'openLazy') actionSheetHandler = handler;
			},
			unpatchAll() {},
		}),
	},
}));
mock.module('react-native', () => ({ View: 'View' }));

const { startRotation, stopRotation } = await import('./rotate');

test('stops polling for late screen modules when rotation stops', () => {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const active = new Set<number>();
	let nextInterval = 0;
	globalThis.setInterval = (() => {
		const id = ++nextInterval;
		active.add(id);
		return id;
	}) as typeof setInterval;
	globalThis.clearInterval = ((id: number) => {
		active.delete(id);
	}) as typeof clearInterval;

	try {
		startRotation();
		expect(active.size).toBe(3);
		stopRotation();
		expect(active.size).toBe(0);
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});

test('does not rotate an action sheet resolved after the plugin stops', async () => {
	startRotation();
	let resolve!: (module: { default: () => null }) => void;
	const pending = new Promise<{ default: () => null }>((done) => {
		resolve = done;
	});
	const args: unknown[] = [pending];
	actionSheetHandler?.({ args });
	stopRotation();
	const module = { default: () => null };
	resolve(module);
	expect(await args[0]).toBe(module);
});
