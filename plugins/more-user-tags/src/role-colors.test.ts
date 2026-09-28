import { describe, expect, test } from 'bun:test';

import { getContrastingTextColor, getRoleColorStops } from './role-colors';

describe('role color stops', () => {
	test('preserves enhanced gradient and three-stop colors', () => {
		expect(
			getRoleColorStops(
				{
					primaryColor: '#123456',
					secondaryColor: '#abcdef',
					tertiaryColor: '#fedcba',
				},
				'#000000',
			),
		).toEqual(['#123456', '#abcdef', '#fedcba']);
	});

	test('falls back to the effective solid member color', () => {
		expect(getRoleColorStops(undefined, '#123456')).toEqual(['#123456']);
		expect(getRoleColorStops(undefined, null)).toEqual([]);
	});

	test('deduplicates repeated stops and can disable enhanced colors', () => {
		const colors = {
			primaryColor: '#123456',
			secondaryColor: '#123456',
			tertiaryColor: '#abcdef',
		};

		expect(getRoleColorStops(colors, '#000000')).toEqual(['#123456', '#abcdef']);
		expect(getRoleColorStops(colors, '#000000', false)).toEqual(['#123456']);
	});
});

describe('role color text contrast', () => {
	test('chooses the best readable text color across all gradient stops', () => {
		expect(getContrastingTextColor(['#111111', '#222222'])).toBe('#ffffff');
		expect(getContrastingTextColor(['#eeeeee', '#ffffff'])).toBe('#000000');
		expect(getContrastingTextColor(['#111111', '#eeeeee'])).toBe('#ffffff');
	});
});
