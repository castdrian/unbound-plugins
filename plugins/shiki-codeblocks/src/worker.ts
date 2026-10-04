import { type CodeLayoutInput, decideCodeLayout } from '@shiki-codeblocks/code-layout';
import { highlightCodeToTokens } from '@shiki-codeblocks/highlight-js';

export type CodeTokenInput = { code: string; language: string; light: boolean };

export function tokenizeCode(input: CodeTokenInput) {
	return highlightCodeToTokens(input.code, input.language, input.light);
}

export function decideCodeLayoutBatch(inputs: CodeLayoutInput[]) {
	return inputs.map(decideCodeLayout);
}

export default {
	layout: decideCodeLayout,
	layoutBatch: decideCodeLayoutBatch,
	tokenize: tokenizeCode,
};
