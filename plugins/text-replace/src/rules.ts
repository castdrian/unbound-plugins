export const TEXT_REPLACE_RULES_CHANNEL_ID = '1102784112584040479';

export type TextReplaceRule = {
	find: string;
	replace: string;
	onlyIfIncludes: string;
	id: string;
};

export type TextReplaceRuleset = {
	stringRules: TextReplaceRule[];
	regexRules: TextReplaceRule[];
};

const RULESET_VERSION = 1;
const VARIABLE_TOKEN_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

let ruleIndex = 0;

export function createRule(): TextReplaceRule {
	ruleIndex++;
	return {
		find: '',
		replace: '',
		onlyIfIncludes: '',
		id: `${Date.now()}-${ruleIndex}-${Math.random().toString(36).slice(2)}`,
	};
}

export function normalizeRules(value: unknown): TextReplaceRule[] {
	if (!Array.isArray(value) || value.length === 0) return [createRule()];

	return value.map((rule) => ({
		find: typeof rule?.find === 'string' ? rule.find : '',
		replace: typeof rule?.replace === 'string' ? rule.replace : '',
		onlyIfIncludes: typeof rule?.onlyIfIncludes === 'string' ? rule.onlyIfIncludes : '',
		id: typeof rule?.id === 'string' && rule.id ? rule.id : createRule().id,
	}));
}

function hasRuleContent(rule: TextReplaceRule): boolean {
	return Boolean(rule.find || rule.replace || rule.onlyIfIncludes);
}

type ExportedRule = Pick<TextReplaceRule, 'find' | 'replace' | 'onlyIfIncludes'>;

function exportRules(rules: TextReplaceRule[]): ExportedRule[] {
	return rules.filter(hasRuleContent).map((rule) => ({
		find: rule.find,
		replace: rule.replace,
		onlyIfIncludes: rule.onlyIfIncludes,
	}));
}

export function serializeRuleset(stringRules: TextReplaceRule[], regexRules: TextReplaceRule[]): string {
	return JSON.stringify(
		{
			version: RULESET_VERSION,
			stringRules: exportRules(stringRules),
			regexRules: exportRules(regexRules),
		},
		null,
		2,
	);
}

export function parseRuleset(value: unknown): TextReplaceRuleset {
	let parsed: unknown;

	try {
		parsed = typeof value === 'string' ? JSON.parse(value) : value;
	} catch {
		throw new Error('This is not valid JSON.');
	}

	if (!parsed || typeof parsed !== 'object') throw new Error('This is not a Text Replace ruleset.');

	const ruleset = parsed as { version?: unknown; stringRules?: unknown; regexRules?: unknown };
	if (ruleset.version !== RULESET_VERSION || !Array.isArray(ruleset.stringRules) || !Array.isArray(ruleset.regexRules)) {
		throw new Error('This Text Replace ruleset is unsupported.');
	}

	return {
		stringRules: normalizeRules(ruleset.stringRules).filter(hasRuleContent),
		regexRules: normalizeRules(ruleset.regexRules).filter(hasRuleContent),
	};
}

export function stringToRegex(value: string): RegExp {
	const match = value.match(/^(\/)?(.+?)(?:\/([gimsuyv]*))?$/);
	const flags = match?.[3] ? [...new Set(match[3])].join('') : 'g';
	return new RegExp(match ? match[2] : value, flags);
}

function applies(rule: TextReplaceRule, content: string): boolean {
	return Boolean(rule.find) && (!rule.onlyIfIncludes || content.includes(rule.onlyIfIncludes));
}

function replaceNewlines(value: string): string {
	return value.replaceAll('\\n', '\n');
}

type StringRuleMatcher = {
	pattern: RegExp;
	variables: string[];
};

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createStringRuleMatcher(find: string): StringRuleMatcher | undefined {
	const tokens = [...find.matchAll(VARIABLE_TOKEN_PATTERN)];
	if (tokens.length === 0) return;

	const variables: string[] = [];
	let source = '';
	let cursor = 0;

	for (const token of tokens) {
		const index = token.index ?? 0;
		const name = token[1];
		source += escapeRegex(find.slice(cursor, index));

		const existingIndex = variables.indexOf(name);
		if (existingIndex >= 0) {
			source += `\\${existingIndex + 1}`;
		} else {
			variables.push(name);
			const hasLiteralAfterToken = index + token[0].length < find.length;
			source += hasLiteralAfterToken ? '(\\S+?)' : '(\\S+)';
		}

		cursor = index + token[0].length;
	}

	source += escapeRegex(find.slice(cursor));
	return { pattern: new RegExp(source, 'g'), variables };
}

function renderVariableReplacement(template: string, variables: string[], captures: string[]): string {
	const values = new Map(variables.map((name, index) => [name, captures[index] ?? '']));
	return replaceNewlines(template).replace(VARIABLE_TOKEN_PATTERN, (token, name: string) => values.get(name) ?? token);
}

export function applyRules(
	content: string,
	stringRules: TextReplaceRule[],
	regexRules: TextReplaceRule[],
): string {
	if (!content) return content;

	for (const rule of stringRules) {
		if (!applies(rule, content)) continue;

		const matcher = createStringRuleMatcher(rule.find);
		if (!matcher) {
			content = ` ${content} `
				.replaceAll(rule.find, replaceNewlines(rule.replace))
				.replace(/^\s|\s$/g, '');
			continue;
		}

		content = ` ${content} `
			.replace(matcher.pattern, (match: string, ...args: unknown[]) => {
				const captures = args.slice(0, matcher.variables.length).map((capture) => String(capture));
				return renderVariableReplacement(rule.replace, matcher.variables, captures);
			})
			.replace(/^\s|\s$/g, '');
	}

	for (const rule of regexRules) {
		if (!applies(rule, content)) continue;

		try {
			content = content.replace(stringToRegex(rule.find), replaceNewlines(rule.replace));
		} catch { }
	}

	return content.trim();
}
