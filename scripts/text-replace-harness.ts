import { readFileSync } from 'node:fs';

import { applyRules, parseRuleset, type TextReplaceRuleset } from '../plugins/text-replace/src/rules';

export type TextReplaceHarnessResult = {
	input: string;
	output: string;
	changed: boolean;
};

export function runTextReplaceHarness(input: string, ruleset: TextReplaceRuleset): TextReplaceHarnessResult {
	const output = applyRules(input, ruleset.stringRules, ruleset.regexRules);
	return { input, output, changed: output !== input };
}

function getArgument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): string {
	return [
		'Usage: bun scripts/text-replace-harness.ts --ruleset rules.json --message ">pk:pikachu"',
		'       bun scripts/text-replace-harness.ts --ruleset rules.json --message-file message.txt',
		'       printf ">pk:pikachu" | bun scripts/text-replace-harness.ts --ruleset rules.json --stdin',
	].join('\n');
}

function readMessage(): string {
	const message = getArgument('--message');
	if (message !== undefined) return message;

	const messageFile = getArgument('--message-file');
	if (messageFile) return readFileSync(messageFile, 'utf8');

	if (process.argv.includes('--stdin')) return readFileSync(0, 'utf8');
	throw new Error('Provide --message, --message-file, or --stdin.');
}

function main(): void {
	if (process.argv.includes('--help')) {
		console.log(usage());
		return;
	}

	const rulesetPath = getArgument('--ruleset');
	if (!rulesetPath) throw new Error(`Provide --ruleset.\n${usage()}`);

	const ruleset = parseRuleset(readFileSync(rulesetPath, 'utf8'));
	console.log(JSON.stringify(runTextReplaceHarness(readMessage(), ruleset), null, 2));
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
