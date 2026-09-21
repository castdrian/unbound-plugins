import { describe, expect, test } from 'bun:test';

import {
	cellRenderDecision,
	containsMentionText,
	extractMentionTokens,
	imageCacheAction,
	mentionImageMetrics,
	roleImageSource,
	selectMentionLabel,
} from '@mention-avatars/index';

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
	});

	test('checks every mention label before replacing a saved string', () => {
		expect(
			containsMentionText('@autosupport @dylib.dev', [
				{ labels: ['autosupport'], type: 'user' },
				{ labels: ['dylib.dev'], type: 'user' },
			]),
		).toBe(true);
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
