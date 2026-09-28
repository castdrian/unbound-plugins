import { describe, expect, test } from 'bun:test';

import { enableAnimatedEmojiSources } from '@message-link-embeds/animated-emoji';

describe('animated embedded emoji sources', () => {
	test('uses animated GIF URLs for both animated and fallback render paths', () => {
		const content = [
			{
				id: 'animated',
				frozenSrc: 'https://cdn.discordapp.com/emojis/123.webp?size=96',
				src: 'https://cdn.discordapp.com/emojis/123.webp?size=96&animated=true',
				type: 'customEmoji',
			},
		];

		expect(enableAnimatedEmojiSources(content)).toBe(1);
		expect(content[0]?.src).toBe('https://cdn.discordapp.com/emojis/123.gif?size=96');
		expect(content[0]?.frozenSrc).toBe('https://cdn.discordapp.com/emojis/123.gif?size=96');
	});

	test('leaves static emoji and non-Discord image sources unchanged', () => {
		const content = [
			{
				frozenSrc: 'https://cdn.discordapp.com/emojis/123.webp?size=96',
				src: 'https://cdn.discordapp.com/emojis/123.webp?size=96',
				type: 'customEmoji',
			},
			{
				src: 'https://example.com/emojis/456.webp?animated=true',
				type: 'customEmoji',
			},
			{
				src: 'https://cdn.discordapp.com/emojis/789.webp?size=96&animated=true',
				type: 'image',
			},
		];

		expect(enableAnimatedEmojiSources(content)).toBe(0);
		expect(content[0]?.src).toBe('https://cdn.discordapp.com/emojis/123.webp?size=96');
		expect(content[1]?.src).toBe('https://example.com/emojis/456.webp?animated=true');
		expect(content[2]?.src).toBe(
			'https://cdn.discordapp.com/emojis/789.webp?size=96&animated=true',
		);
	});

	test('visits nested content only once when data contains cycles', () => {
		const emoji = {
			src: 'https://cdn.discordapp.com/emojis/123.webp?size=96&animated=true',
			type: 'customEmoji',
		};
		const content: unknown[] = [emoji];
		content.push(content);

		expect(enableAnimatedEmojiSources(content)).toBe(1);
		expect(emoji.src).toBe('https://cdn.discordapp.com/emojis/123.gif?size=96');
	});
});
