type EmojiContent = Record<string, unknown>;

function animatedGifSource(source: string): string | undefined {
	try {
		const url = new URL(source);
		if (
			url.hostname !== 'cdn.discordapp.com' ||
			!/^\/emojis\/\d+\.webp$/.test(url.pathname) ||
			url.searchParams.get('animated') !== 'true'
		) {
			return;
		}

		url.pathname = url.pathname.replace(/\.webp$/, '.gif');
		url.searchParams.delete('animated');
		return url.toString();
	} catch {
		return;
	}
}

export function enableAnimatedEmojiSources(content: unknown): number {
	let updated = 0;
	const visited = new WeakSet<object>();

	function visit(value: unknown): void {
		if (!value || typeof value !== 'object' || visited.has(value)) return;
		visited.add(value);

		if (Array.isArray(value)) {
			for (const child of value) visit(child);
			return;
		}

		const entry = value as EmojiContent;
		if (entry.type === 'customEmoji' && typeof entry.src === 'string') {
			const source = animatedGifSource(entry.src);
			if (source) {
				entry.src = source;
				if (typeof entry.frozenSrc === 'string') entry.frozenSrc = source;
				updated++;
			}
		}

		for (const child of Object.values(entry)) visit(child);
	}

	visit(content);
	return updated;
}
