import { metro, patcher } from '@unbound-app/api';

type MessageActions = {
	sendMessage?: (...args: unknown[]) => unknown;
};

type ChatInput = {
	closeCustomKeyboard?: () => void;
	insertText?: (text: string) => void;
};

type ChatInputRegistry = {
	getBestActiveInputForChannelId?: (channelId: string) => ChatInput | null;
};

let unpatch: (() => void) | null = null;

function isGifPickerSelection(args: unknown[]): args is [string, { content: string }, ...unknown[]] {
	const [channelId, message, , metadata] = args;
	return typeof channelId === 'string'
		&& !!message
		&& typeof message === 'object'
		&& typeof (message as { content?: unknown }).content === 'string'
		&& !!metadata
		&& typeof metadata === 'object'
		&& (metadata as { location?: unknown }).location === 'gif_reply';
}

function start(): void {
	const messages = metro.findByProps('sendMessage', 'editMessage') as MessageActions | null;
	if (typeof messages?.sendMessage !== 'function') return;

	unpatch = patcher.instead(messages, 'sendMessage', (ctx) => {
		if (!isGifPickerSelection(ctx.args)) return ctx.original.apply(ctx.this, ctx.args);

		const [channelId, message] = ctx.args;
		const registry = metro.findByProps('getBestActiveInputForChannelId') as ChatInputRegistry | null;
		const input = registry?.getBestActiveInputForChannelId?.(channelId);
		if (typeof input?.insertText !== 'function') return ctx.original.apply(ctx.this, ctx.args);

		input.insertText(`${message.content} `);
		input.closeCustomKeyboard?.();
	});
}

function stop(): void {
	unpatch?.();
	unpatch = null;
}

export default { start, stop };
