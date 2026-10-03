import { afterEach, describe, expect, mock, test } from 'bun:test';

let nativeHookClass: string | null = null;
let nativeHookSelector: string | null = null;
let nativeHookRemoveCount = 0;
let findByFilePathCount = 0;

mock.module('@unbound-app/api', () => ({
	metro: {
		findByProps: () => null,
		findByFilePath: () => {
			findByFilePathCount++;
			return null;
		},
	},
	storage: {
		getStore: () => ({
			addListener: () => () => {},
			get: () => false,
			useSettingsStore: () => ({ get: () => false, set: () => {} }),
		}),
	},
}));
mock.module('@shared/settings-ui', () => ({
	getSettingsColors: () => ({}),
	SettingsCard: () => null,
	SettingsRow: () => null,
	SettingsScrollView: () => null,
	SettingsSection: () => null,
}));

const {
	buildNativeCodeMarkup,
	codeBlockLayout,
	codeScrollHeight,
	default: plugin,
	getTokens,
	locateCodeBlocks,
	matchCodeBlock,
	parseFencedCodeBlocks,
	resolveLanguage,
	shouldCorrectRow,
} = await import('@shiki-codeblocks/index');

afterEach(() => {
	plugin.stop();
	nativeHookClass = null;
	nativeHookSelector = null;
	nativeHookRemoveCount = 0;
	findByFilePathCount = 0;
});

describe('language aliases', () => {
	test('resolves supported aliases case-insensitively', () => {
		expect(resolveLanguage('TS')).toBe('typescript');
		expect(resolveLanguage('js')).toBe('javascript');
		expect(resolveLanguage(' yml ')).toBe('yaml');
	});

	test('leaves unsupported and unlabelled blocks native', () => {
		expect(resolveLanguage('brainfuck')).toBeNull();
		expect(resolveLanguage(undefined)).toBeNull();
	});
});

describe('native fenced code matching', () => {
	test('parses supported blocks and preserves indentation', () => {
		const blocks = parseFencedCodeBlocks(
			'Before\n```ts title=example.ts\nconst answer = 42;\n    return answer;\n```\nAfter',
		);

		expect(blocks).toEqual([
			{
				code: 'const answer = 42;\n    return answer;',
				language: 'typescript',
			},
		]);
	});

	test('matches native text after newline normalization and ignores unsupported blocks', () => {
		const blocks = parseFencedCodeBlocks(
			'```brainfuck\n++++\n```\n~~~js\r\nconsole.log(1);\r\n~~~',
		);

		expect(blocks).toEqual([{ code: 'console.log(1);', language: 'javascript' }]);
		expect(matchCodeBlock(blocks, '\nconsole.log(1);\n\n')).toEqual(blocks[0]);
		expect(matchCodeBlock(blocks, 'console.log(2);')).toBeUndefined();
	});

	test('rejects mismatched or too-short fences', () => {
		expect(
			parseFencedCodeBlocks('```ts\nconst value = 1;\n~~\n~~~ts\nconst value = 2;\n~~~'),
		).toEqual([]);
	});

	test('locates a fenced block between ordinary text without replacing the text', () => {
		const blocks = parseFencedCodeBlocks(
			'Before the code block.\n\n```ts\nconst answer = 42;\n```\n\nAfter the code block.',
		);
		const rendered = 'Before the code block.\n\n\nconst answer = 42;\n\n\nAfter the code block.';
		const placements = locateCodeBlocks(blocks, rendered);

		expect(placements).toEqual([
			{
				block: blocks[0],
				start: 'Before the code block.'.length,
				end: rendered.indexOf('After the code block.'),
			},
		]);
		expect(rendered.slice(0, placements[0]?.start)).toBe('Before the code block.');
		expect(rendered.slice(placements[0]?.end)).toBe('After the code block.');
	});

	test('locates multiple blocks in order and leaves intervening text intact', () => {
		const blocks = parseFencedCodeBlocks(
			'Before\n```ts\nconst value = 1;\n```\nBetween\n```py\nprint(2)\n```\nAfter',
		);
		const rendered = 'Before\n\nconst value = 1;\n\nBetween\n\nprint(2)\n\nAfter';
		const placements = locateCodeBlocks(blocks, rendered);

		expect(placements).toHaveLength(2);
		expect(rendered.slice(placements[0].end, placements[1].start)).toBe('Between');
		expect(rendered.slice(placements[1].end)).toBe('After');
	});

	test('preserves message-link attachment text around a code block', () => {
		const blocks = parseFencedCodeBlocks(
			'Before https://discord.com/channels/709061970078335027/709062739581992971/1555962053007769671\n```ts\nconst value = 1;\n```\nAfter',
		);
		const prefix = 'Before \uFFFC\u2068development\u2069\n';
		const suffix = '\nAfter';
		const rendered = `${prefix}const value = 1;${suffix}`;
		const placements = locateCodeBlocks(blocks, rendered);

		expect(placements).toHaveLength(1);
		expect(rendered.slice(0, placements[0].start)).toBe('Before \uFFFC\u2068development\u2069');
		expect(rendered.slice(placements[0].end)).toBe('After');
	});

	test('locates repeated code in separate fences without merging their ranges', () => {
		const blocks = parseFencedCodeBlocks(
			'```ts\nconst same = true;\n```\nBetween\n```ts\nconst same = true;\n```',
		);
		const rendered = '\nconst same = true;\n\nBetween\n\nconst same = true;\n';
		const placements = locateCodeBlocks(blocks, rendered);

		expect(placements).toHaveLength(2);
		expect(placements[0].end).toBeLessThanOrEqual(placements[1].start);
		expect(rendered.slice(placements[0].end, placements[1].start)).toBe('Between');
	});

	test('does not target ambiguous code that also occurs outside a block', () => {
		const blocks = parseFencedCodeBlocks('```ts\nconst value = 1;\n```');
		expect(locateCodeBlocks(blocks, 'const value = 1;\nconst value = 1;')).toEqual([]);
		expect(locateCodeBlocks([...blocks, ...blocks], '\nconst value = 1;\n')).toEqual([]);
	});
});

describe('native syntax rendering', () => {
	test('corrects a cell when its label extends beyond the reported content height', () => {
		expect(shouldCorrectRow(217.5, 217.5, 257.5)).toBe(true);
		expect(shouldCorrectRow(257.5, 257.5, 257.5)).toBe(false);
	});

	test('loads and tokenizes a bundled grammar on demand', async () => {
		const tokens = await getTokens('const answer = 42;', 'typescript', 'dark-plus');

		expect(tokens).not.toBeNull();
		expect(tokens?.[0].map((token) => token.content).join('')).toBe('const answer = 42;');
		expect(tokens?.[0].some((token) => token.color !== '#D4D4D4')).toBe(true);
	});

	test('keeps long lines on one row in horizontal-scroll mode', () => {
		const code = `const result = ${'item + '.repeat(20)}42;\nreturn result;`;
		const wrapped = codeBlockLayout(code, 240, 'wrap');
		const scrolled = codeBlockLayout(code, 240, 'scroll');

		expect(scrolled.height).toBeLessThan(wrapped.height);
		expect(scrolled.contentWidth).toBeGreaterThan(240);
		expect(scrolled.contentWidth).toBeGreaterThan((code.split('\n')[0].length + 3) * 8);
	});

	test('keeps oversized code content scrollable inside a capped card', () => {
		const code = Array.from({ length: 36 }, (_, index) => `print(${index + 1})`).join('\n');
		const layout = codeBlockLayout(code, 240, 'wrap');

		expect(layout.height).toBe(520);
		expect(layout.contentHeight).toBeGreaterThan(layout.height - 50);
		expect(codeScrollHeight(516, layout.height - 50)).toBe(518);
		expect(codeScrollHeight(28, 38)).toBe(38);
	});

	test('builds line-numbered text and coalesced token color spans for the dark theme', () => {
		const markup = buildNativeCodeMarkup(
			[
				[
					{ content: 'const ', offset: 0, color: '#c586c0', fontStyle: 0 },
					{ content: 'answer', offset: 6, color: '#9cdcfe', fontStyle: 0 },
				],
				[
					{ content: 'return ', offset: 0, color: '#c586c0', fontStyle: 0 },
					{ content: 'answer', offset: 7, color: '#9cdcfe', fontStyle: 0 },
				],
			],
			false,
		);

		expect(markup.text).toBe(' 1 const answer\n 2 return answer');
		expect(markup.spans).toEqual([
			{ color: '#858585', location: 0, length: 3 },
			{ color: '#c586c0', location: 3, length: 6 },
			{ color: '#9cdcfe', location: 9, length: 6 },
			{ color: '#858585', location: 16, length: 3 },
			{ color: '#c586c0', location: 19, length: 7 },
			{ color: '#9cdcfe', location: 26, length: 6 },
		]);
	});

	test('uses a light line-number color when the light theme is active', () => {
		const markup = buildNativeCodeMarkup(
			[[{ content: 'const value = 1;', offset: 0, color: '#0000ff', fontStyle: 0 }]],
			true,
		);

		expect(markup.spans[0]).toEqual({ color: '#8a8a8a', location: 0, length: 3 });
		expect(markup.spans[1]).toEqual({ color: '#0000ff', location: 3, length: 16 });
	});
});

describe('plugin lifecycle', () => {
	test('uses the native label hook without replacing the Markdown renderer', () => {
		const native = {
			objc: {
				hook(className: string, selector: string) {
					nativeHookClass = className;
					nativeHookSelector = selector;
					return { remove: () => nativeHookRemoveCount++ };
				},
			},
		};

		plugin.start({ native } as never);
		plugin.start({ native } as never);

		expect(nativeHookClass).toBe('DCDReusableYYLabel');
		expect(nativeHookSelector).toBe('setAttributedText:');
		expect(findByFilePathCount).toBe(0);
		plugin.stop();
		expect(nativeHookRemoveCount).toBe(1);
	});
});
