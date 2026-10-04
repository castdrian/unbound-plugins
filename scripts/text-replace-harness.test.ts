import { expect, test } from 'bun:test';

import { parseRuleset } from '../plugins/text-replace/src/rules';
import { runTextReplaceHarness } from './text-replace-harness';

test('runs TextReplace without React Native or an installed IPA', () => {
	const ruleset = parseRuleset({
		version: 1,
		stringRules: [{ find: '>pk:{pokemon}', replace: 'https://embed.pkmn.dev/{pokemon}', onlyIfIncludes: '' }],
		regexRules: [],
	});

	expect(runTextReplaceHarness('>pk:pikachu', ruleset)).toEqual({
		input: '>pk:pikachu',
		output: 'https://embed.pkmn.dev/pikachu',
		changed: true,
	});
});

test('keeps harness output machine-readable for unchanged messages', () => {
	const ruleset = parseRuleset({ version: 1, stringRules: [], regexRules: [] });

	expect(runTextReplaceHarness('hello', ruleset)).toEqual({ input: 'hello', output: 'hello', changed: false });
});
