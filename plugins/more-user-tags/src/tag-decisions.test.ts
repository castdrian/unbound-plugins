import { expect, test } from 'bun:test';
import { decideTag, decideTagBatch } from '@more-user-tags/tag-decisions';
import worker from '@more-user-tags/worker';

test('worker and fallback preserve OP precedence and role colors', () => {
	const input = {
		bot: false,
		coloredTags: true,
		enabled: {},
		enhancedRoleColors: true,
		guildOwnerId: 'owner',
		id: 'message',
		memberColor: '#248046',
		memberColors: { primaryColor: '#248046' },
		opTagText: 'OP',
		permissions: ['ADMINISTRATOR' as const],
		useOpTagStyle: true,
		useRoleColor: true,
		userId: 'owner',
	};
	expect(worker.decide(input)).toEqual(decideTag(input));
	expect(worker.decideBatch([input])).toEqual(decideTagBatch([input]));
	expect(worker.decide(input)).toMatchObject({
		background: '#248046',
		style: 'op',
		tagText: 'OP · Owner',
	});
});

test('worker skips disabled tags and selects the next permitted badge', () => {
	const input = {
		bot: false,
		coloredTags: true,
		enabled: { ADMINISTRATOR: false },
		enhancedRoleColors: false,
		id: 'message',
		permissions: ['ADMINISTRATOR' as const, 'MANAGE_GUILD' as const],
		useOpTagStyle: false,
		useRoleColor: false,
	};
	expect(worker.decide(input)).toMatchObject({ tagText: 'Staff', style: 'normal' });
	expect(worker.decide(input)).toEqual(decideTag(input));
});
