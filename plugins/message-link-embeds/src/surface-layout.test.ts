import { describe, expect, test } from 'bun:test';

import {
	bottomOffsetCorrection,
	readBottomAnchor,
	SurfaceHeightCache,
	surfaceHeightCacheKey,
	type SurfaceLayoutMetrics,
} from '#surface-layout';

function metrics(overrides: Partial<SurfaceLayoutMetrics> = {}): SurfaceLayoutMetrics {
	return {
		bottomInset: 0,
		contentHeight: 1600,
		inverted: false,
		offsetX: 0,
		offsetY: 1000,
		topInset: 0,
		viewportHeight: 600,
		...overrides,
	};
}

describe('chat bottom anchoring', () => {
	test('recognizes the visible bottom of an inverted message list', () => {
		const anchor = readBottomAnchor(metrics({ inverted: true, offsetY: 0 }));

		expect(anchor.atBottom).toBe(true);
	});

	test('corrects automatic large offset changes after a row grows', () => {
		const anchor = readBottomAnchor(metrics());
		const updated = metrics({ contentHeight: 1640, offsetY: 950 });

		expect(bottomOffsetCorrection(anchor, updated, false)).toEqual({ x: 0, y: 1040 });
	});

	test('leaves the scroll position alone while the user is scrolling', () => {
		const anchor = readBottomAnchor(metrics());

		expect(
			bottomOffsetCorrection(anchor, metrics({ contentHeight: 1640 }), true),
		).toBeUndefined();
	});

	test('does not pull the user down when they were not at the bottom', () => {
		const anchor = readBottomAnchor(metrics({ offsetY: 700 }));

		expect(
			bottomOffsetCorrection(anchor, metrics({ contentHeight: 1640 }), false),
		).toBeUndefined();
	});
});

describe('embedded surface height cache', () => {
	test('reuses a measured height for a recycled card at the same target and width', () => {
		const cache = new SurfaceHeightCache();
		const key = surfaceHeightCacheKey('channel', 'message', 320);

		cache.set(key, 184);

		expect(cache.get(key, 72)).toBe(184);
	});

	test('keeps measurements separate when the available width changes', () => {
		const cache = new SurfaceHeightCache();
		const narrow = surfaceHeightCacheKey('channel', 'message', 320);
		const wide = surfaceHeightCacheKey('channel', 'message', 400);

		cache.set(narrow, 184);

		expect(cache.get(wide, 72)).toBe(72);
	});

	test('bounds cached measurements and evicts least recently used surfaces', () => {
		const cache = new SurfaceHeightCache(2);

		cache.set('first', 80);
		cache.set('second', 100);
		cache.get('first', 72);
		cache.set('third', 120);

		expect(cache.get('first', 72)).toBe(80);
		expect(cache.get('second', 72)).toBe(72);
		expect(cache.get('third', 72)).toBe(120);
	});
});
