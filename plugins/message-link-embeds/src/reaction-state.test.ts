import { describe, expect, test } from 'bun:test';

import { reactionSnapshot, updateMessageRecord } from '#reaction-state';

describe('message reaction snapshots', () => {
	test('creates a stable snapshot for message reaction changes', () => {
		const reactions = [
			{
				count: 1,
				count_details: { burst: 0, normal: 1 },
				emoji: { id: null, name: '👍' },
				me: true,
				me_burst: false,
			},
		];

		expect(reactionSnapshot(reactions)).toBe(
			reactionSnapshot([
				{
					count: 1,
					count_details: { burst: 0, normal: 1 },
					emoji: { id: null, name: '👍' },
					me: true,
					me_burst: false,
				},
			]),
		);
		expect(reactionSnapshot(reactions)).not.toBe(reactionSnapshot([]));
	});

	test('detects in-place count and current-user changes', () => {
		const reactions = [{ count: 1, emoji: { id: 'emoji-id', name: 'wave' }, me: false }];
		const initial = reactionSnapshot(reactions);

		reactions[0]!.count = 2;
		reactions[0]!.me = true;

		expect(reactionSnapshot(reactions)).not.toBe(initial);
	});

	test('updates a mounted message record without replacing its identity', () => {
		const record = { content: 'preview', id: 'message', reactions: [] as unknown[] };
		const next = { ...record, reactions: [{ count: 1 }] };

		expect(updateMessageRecord(record, next)).toBe(record);
		expect(record.reactions).toEqual([{ count: 1 }]);
	});
});
