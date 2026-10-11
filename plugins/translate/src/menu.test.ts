import { expect, mock, test } from 'bun:test';

mock.module('@unbound-app/api', () => ({
	assets: {},
	metro: {},
	patcher: { createPatcher: () => ({}) },
	toasts: {},
}));
mock.module('@translate/api', () => ({ translateText: async (text: string) => text }));

const { isActionSheetRowGroup } = await import('./menu');

test('recognizes anonymous Discord 347 message action row groups', () => {
	const row = (label: string) => ({ type: {}, props: { label, onPress: () => undefined } });
	const group = {
		type: {},
		props: { hasIcons: true, children: [row('Edit Message'), row('Reply')] },
	};
	const unrelated = { type: {}, props: { hasIcons: true, children: [{ type: {}, props: {} }] } };

	expect(isActionSheetRowGroup(group)).toBe(true);
	expect(isActionSheetRowGroup(unrelated)).toBe(false);
});
