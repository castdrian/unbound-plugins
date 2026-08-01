export const TEXT_REPLACE_RULES_CHANNEL_ID = '1102784112584040479';

export type TextReplaceRule = {
	find: string;
	replace: string;
	onlyIfIncludes: string;
	id: string;
};

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

export function applyRules(
	content: string,
	stringRules: TextReplaceRule[],
	regexRules: TextReplaceRule[],
): string {
	if (!content) return content;

	for (const rule of stringRules) {
		if (!applies(rule, content)) continue;

		content = ` ${content} `
			.replaceAll(rule.find, replaceNewlines(rule.replace))
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
