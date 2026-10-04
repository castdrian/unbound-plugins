import { expect, test } from 'bun:test';

import {
	getOptionValue,
	normalizeTags,
	parseTagArguments,
	renderTagMessage,
	type Tag,
	validateTag,
} from '@custom-commands/tags';

function tag(name: string, message: string): Tag {
	return { name, message, media: [] };
}

test('extracts required and optional arguments once per name', () => {
	expect(parseTagArguments('Hi {{User}}! {{mood = great}} {{user}}')).toEqual([
		{ name: 'user', defaultValue: null },
		{ name: 'mood', defaultValue: 'great' },
	]);
});

test('renders arguments, defaults, repeated placeholders, and escaped newlines', () => {
	expect(
		renderTagMessage('Hi {{user}}! {{mood = great}} {{USER}}\\nAgain', [
			{ name: 'user', value: '@Clyde' },
		]),
	).toBe('Hi @Clyde! great @Clyde\nAgain');
});

test('finds nested command options', () => {
	expect(
		getOptionValue([{ name: 'wrapper', options: [{ name: 'name', value: 'Adrian' }] }], 'name'),
	).toBe('Adrian');
});

test('rejects invalid names, reserved arguments, empty tags, and duplicates', () => {
	expect(validateTag(tag('Bad Name', 'hello'), [])).toContain('lowercase');
	expect(validateTag(tag('hello', '{{ephemeral}}'), [])).toContain('reserved');
	expect(validateTag(tag('hello', ''), [])).toContain('response');
	expect(validateTag(tag('hello', 'hello'), [tag('hello', 'old')])).toContain('already exists');
	expect(validateTag(tag('hello', 'hello'), [tag('hello', 'old')], 'hello')).toBeNull();
});

test('accepts media-only tags and removes malformed saved entries', () => {
	const media = {
		storedName: 'custom-commands-123-abc.png',
		fileName: 'photo.png',
		fileSize: 12,
		mimeType: 'image/png',
	};
	expect(validateTag({ name: 'photo', message: '', media: [media] }, [])).toBeNull();
	expect(
		normalizeTags([
			{ name: 'photo', message: '', media: [media] },
			{ name: 'photo', message: 'duplicate', media: [] },
			{ name: 'broken', message: '', media: [] },
		]),
	).toEqual([{ name: 'photo', message: '', media: [media] }]);
});
