import { expect, test } from 'bun:test';

import { applyRules, stringToRegex, type TextReplaceRule } from './rules';

function rule(find: string, replace: string, onlyIfIncludes: string = ''): TextReplaceRule {
	return { find, replace, onlyIfIncludes, id: find };
}

test('applies literal replacements at every position', () => {
	expect(applyRules('cat cat', [rule('cat', 'dog')], [])).toBe('dog dog');
});

test('respects only-if-includes conditions', () => {
	expect(applyRules('hello world', [rule('world', 'earth', 'hello')], [])).toBe('hello earth');
	expect(applyRules('goodbye world', [rule('world', 'earth', 'hello')], [])).toBe('goodbye world');
});

test('converts escaped newlines in replacements', () => {
	expect(applyRules('hello', [rule('hello', 'hi\\nthere')], [])).toBe('hi\nthere');
});

test('accepts slash-delimited regexes and deduplicates flags', () => {
	expect(stringToRegex('/cat/ggi').flags).toBe('gi');
	expect(applyRules('Cat cat', [], [rule('/cat/gi', 'dog')])).toBe('dog dog');
});

test('keeps content unchanged when a regex is invalid', () => {
	expect(applyRules('hello', [], [rule('/[/', 'goodbye')])).toBe('hello');
});
