import { metro, patcher } from '@unbound-app/api';

import { translate } from './translator';

const unpatches: Array<() => void> = [];

function findMessageArg(args: unknown[]): { content?: string } | null {
	for (const arg of args) {
		if (arg && typeof arg === 'object' && typeof (arg as { content?: unknown }).content === 'string') {
			return arg as { content?: string };
		}
	}
	return null;
}

function getMessageActions(): { sendMessage?: unknown; editMessage?: unknown } | null {
	return metro.findByProps('sendMessage', 'editMessage') as { sendMessage?: unknown; editMessage?: unknown } | null;
}

function transformMessage(ctx: { args: unknown[] }): void {
	const message = findMessageArg(ctx.args);
	if (message?.content) message.content = translate(message.content);
}

export default {
	start() {
		const messageActions = getMessageActions();
		if (!messageActions) return;
		if (typeof messageActions.sendMessage === 'function') {
			unpatches.push(patcher.before(messageActions, 'sendMessage', transformMessage));
		}
		if (typeof messageActions.editMessage === 'function') {
			unpatches.push(patcher.before(messageActions, 'editMessage', transformMessage));
		}
	},
	stop() {
		while (unpatches.length) unpatches.pop()!();
	},
};
