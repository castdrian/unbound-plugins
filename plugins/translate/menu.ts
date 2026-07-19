import { metro, patcher, toasts } from '@unbound-app/api';

import { translateText } from '@translate/api';

const Patcher = patcher.createPatcher('unbound.translate');

type MessageLike = {
	id?: string;
	content?: string;
	channel_id?: string;
	channelId?: string;
	[channel: string]: unknown;
};

function findMessageInTree(value: unknown, depth = 0): MessageLike | null {
	if (!value || typeof value !== 'object' || depth > 6) return null;

	const candidate = value as MessageLike;
	if (
		typeof candidate.content === 'string' &&
		(typeof candidate.id === 'string' || typeof candidate.channel_id === 'string')
	) {
		return candidate;
	}

	for (const nested of Object.values(value as Record<string, unknown>)) {
		const found = findMessageInTree(nested, depth + 1);
		if (found) return found;
	}

	return null;
}

function showError(error: unknown): void {
	toasts.showToast({
		title: 'Translate Error',
		content: error instanceof Error ? error.message : String(error),
	});
}

async function translateMessage(message: MessageLike): Promise<void> {
	const content = typeof message.content === 'string' ? message.content : '';
	if (!content.trim()) {
		toasts.showToast({ title: 'Translate', content: 'Message has no text to translate.' });
		return;
	}

	const translated = await translateText(content);
	await metro.common.Clipboard.setString(translated);
	toasts.showToast({ title: 'Translated', content: translated });
}

export function startTranslateMenuPatch(): void {
	const Discord = metro.components.Discord;
	if (!Discord || typeof Discord.showSimpleActionSheet !== 'function') return;

	Patcher.before(Discord, 'showSimpleActionSheet', ({ args }) => {
		const first = args[0];
		const second = args[1];

		const options =
			first && typeof first === 'object' && Array.isArray((first as { options?: unknown }).options)
				? ((first as { options: unknown[] }).options as unknown[])
				: Array.isArray(second)
					? second
					: null;

		if (!options || options.length === 0) return;

		const alreadyAdded = options.some((option) => {
			if (!option || typeof option !== 'object') return false;
			const key = (option as { key?: unknown; id?: unknown }).key;
			const id = (option as { key?: unknown; id?: unknown }).id;
			return key === 'unbound-translate' || id === 'unbound-translate';
		});
		if (alreadyAdded) return;

		const copyIndex = options.findIndex((option) => {
			if (!option || typeof option !== 'object') return false;
			const label = (option as { label?: unknown }).label;
			const key = (option as { key?: unknown }).key;
			const id = (option as { id?: unknown }).id;
			if (key === 'copy-text' || id === 'copy-text') return true;
			return typeof label === 'string' && label.toLowerCase().includes('copy');
		});

		if (copyIndex < 0) return;

		const message = findMessageInTree(args);
		if (!message || typeof message.content !== 'string' || !message.content.trim()) return;

		const action = async () => {
			try {
				await translateMessage(message);
			} catch (error) {
				showError(error);
			}
		};

		options.splice(copyIndex + 1, 0, {
			key: 'unbound-translate',
			id: 'unbound-translate',
			label: 'Translate',
			action,
			onPress: action,
		});
	});
}

export function stopTranslateMenuPatch(): void {
	Patcher.unpatchAll();
}
