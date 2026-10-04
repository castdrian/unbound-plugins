export type CodeBlockLayout = { contentHeight: number; contentWidth: number; height: number };

export type CodeLayoutInput = {
	code: string;
	overflow: 'wrap' | 'scroll';
	width: number;
};

export function codeBlockLayout(
	code: string,
	width: number,
	overflow: 'wrap' | 'scroll',
): CodeBlockLayout {
	const lines = code.split('\n');
	const contentWidth = Math.max(
		width - 24,
		(Math.max(...lines.map((line) => line.replaceAll('\t', '    ').length)) + 4) * 9,
	);
	const charactersPerLine = Math.max(12, Math.floor((width - 44) / 7.25));
	const lineCount =
		overflow === 'scroll'
			? lines.length
			: lines.reduce(
					(count, line) => count + Math.max(1, Math.ceil((line.length + 4) / charactersPerLine)),
					0,
				);
	const contentHeight = Math.max(26, 2 + lineCount * 18);
	return { contentHeight, contentWidth, height: Math.min(520, 50 + contentHeight) };
}

export function decideCodeLayout(input: CodeLayoutInput): CodeBlockLayout {
	return codeBlockLayout(input.code, input.width, input.overflow);
}
