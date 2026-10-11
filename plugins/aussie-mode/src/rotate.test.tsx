import { expect, mock, test } from 'bun:test';

mock.module('@unbound-app/api', () => ({
	metro: {
		findByName: () => null,
		findByFilePath: () => null,
		findByProps: () => null,
	},
	patcher: { createPatcher: () => ({ after() {}, before() {}, unpatchAll() {} }) },
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
