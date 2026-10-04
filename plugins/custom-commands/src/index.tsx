import { mediaUri, setMediaContext } from '@custom-commands/media';
import { appendSavedCommands } from '@custom-commands/registration';
import { CustomCommandsSettings } from '@custom-commands/settings';
import {
	type CommandDecision,
	type CommandOption,
	decideCommand,
	getTagDescription,
	normalizeTags,
	parseTagArguments,
	type Tag,
	type TagMedia,
} from '@custom-commands/tags';
import { metro, patcher, storage, toasts } from '@unbound-app/api';
import type { NativeWorkerBridge, PluginContext } from '@unbound-app/api/native';

const STORE = storage.getStore('unbound.custom-commands');
const APPLICATION_ID = '-1';

type CommandContext = {
	channel?: { id?: string };
};

type BuiltInCommand = {
	applicationId: string;
	displayDescription: string;
	displayName: string;
	execute: (options: CommandOption[], context: CommandContext) => Promise<void>;
	id: string;
	inputType: number;
	options: Array<Record<string, unknown>>;
	type: number;
	untranslatedDescription: string;
	untranslatedName: string;
};

type CommandModule = {
	getBuiltInCommands: (...args: unknown[]) => BuiltInCommand[];
};

type CloudUpload = {
	status: string;
	upload: () => Promise<void>;
};

type CloudUploadConstructor = new (
	item: Record<string, unknown>,
	channelId: string,
	index: number,
	allowOptimization: boolean,
) => CloudUpload;

type MessageActions = {
	_sendMessage: (
		channelId: string,
		message: Record<string, unknown>,
		options: Record<string, unknown>,
	) => Promise<{ ok?: boolean; status?: number }>;
	getSendMessageOptionsForReply?: (reply: unknown) => Record<string, unknown>;
	sendBotMessage?: (channelId: string, message: Record<string, unknown>) => unknown;
};

let unpatch: (() => void) | null = null;
let worker: NativeWorkerBridge | null = null;

function getTags(): Tag[] {
	return normalizeTags(STORE.get('tags', []));
}

function getCommandId(name: string): string {
	let hash = 0;
	for (const character of name) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
	return String(-9_000_000_000 - hash);
}

function createCommand(tag: Tag): BuiltInCommand {
	const description = getTagDescription(tag);
	const options: Array<Record<string, unknown>> = parseTagArguments(tag.message).map(
		(argument) => ({
			name: argument.name,
			displayName: argument.name,
			type: 3,
			description: argument.name,
			displayDescription: argument.name,
			required: argument.defaultValue === null,
		}),
	);
	options.push({
		name: 'ephemeral',
		displayName: 'ephemeral',
		type: 5,
		description: 'Only show the response to you',
		displayDescription: 'Only show the response to you',
		required: false,
	});

	return {
		id: getCommandId(tag.name),
		untranslatedName: tag.name,
		displayName: tag.name,
		type: 1,
		inputType: 1,
		applicationId: APPLICATION_ID,
		untranslatedDescription: description,
		displayDescription: description,
		options,
		execute: (args, context) => executeTag(tag.name, args, context),
	};
}

async function uploadMedia(media: TagMedia[], channelId: string): Promise<CloudUpload[]> {
	if (!media.length) return [];
	const module = metro.findByProps('CloudUpload') as {
		CloudUpload?: CloudUploadConstructor;
	} | null;
	const CloudUpload = module?.CloudUpload;
	if (!CloudUpload) throw new Error('Discord file uploads are unavailable.');

	const uploads = media.map((attachment, index) => {
		const uri = mediaUri(attachment);
		const item = {
			id: `custom-commands-${Date.now()}-${index}`,
			origin: 1,
			uri,
			originalUri: uri,
			mimeType: attachment.mimeType,
			width: attachment.width,
			height: attachment.height,
			filename: attachment.fileName,
			playableDuration: attachment.duration ?? null,
			platform: 0,
			createdUsingInAppCamera: false,
			progress: 0,
		};
		return new CloudUpload(item, channelId, index, true);
	});

	await Promise.all(uploads.map((upload) => upload.upload()));
	if (uploads.some((upload) => upload.status !== 'COMPLETED'))
		throw new Error('An attachment failed to upload.');
	return uploads;
}

async function executeTag(
	name: string,
	options: CommandOption[],
	context: CommandContext,
): Promise<void> {
	const input = { channelId: context?.channel?.id, name, options, tags: getTags() };
	const decision = worker
		? await worker.run('decide', input, decideCommand, isCommandDecision)
		: decideCommand(input);
	if (!decision) return;
	const { channelId, content, ephemeral, media } = decision;

	const messageActions = metro.findByProps('_sendMessage') as MessageActions | null;
	if (!messageActions) throw new Error('Discord message actions are unavailable.');
	if (ephemeral && media.length) {
		toasts.showToast({
			title: 'Custom Commands',
			content: 'Commands with attachments cannot be sent ephemerally.',
		});
		return;
	}

	try {
		if (ephemeral) {
			messageActions.sendBotMessage?.(channelId, { content });
			return;
		}

		const pendingReply = (
			metro.findByProps('getPendingReply') as {
				getPendingReply?: (channelId: string) => unknown;
			} | null
		)?.getPendingReply?.(channelId);
		const replyOptions = messageActions.getSendMessageOptionsForReply?.(pendingReply) ?? {};
		const attachmentsToUpload = await uploadMedia(media, channelId);
		const result = await messageActions._sendMessage(
			channelId,
			{ content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] },
			{ ...replyOptions, attachmentsToUpload },
		);
		if (result?.ok === false) throw new Error(`Discord rejected the message (${result.status}).`);
		if (pendingReply) {
			(
				metro.findByProps('dispatch', 'subscribe') as {
					dispatch?: (event: Record<string, unknown>) => void;
				} | null
			)?.dispatch?.({ type: 'DELETE_PENDING_REPLY', channelId });
		}
	} catch (error) {
		toasts.showToast({
			title: 'Custom Commands',
			content: error instanceof Error ? error.message : 'The command could not be sent.',
		});
		throw error;
	}
}

function isCommandDecision(value: unknown): value is CommandDecision | null {
	if (value === null) return true;
	if (!value || typeof value !== 'object') return false;
	const decision = value as Record<string, unknown>;
	return (
		typeof decision.channelId === 'string' &&
		typeof decision.content === 'string' &&
		typeof decision.ephemeral === 'boolean' &&
		Array.isArray(decision.media) &&
		decision.media.every(
			(item) =>
				item &&
				typeof item === 'object' &&
				typeof item.storedName === 'string' &&
				typeof item.mimeType === 'string',
		)
	);
}

function start(context: PluginContext): void {
	if (unpatch) return;
	setMediaContext(context);
	worker = context.native.worker;
	const commands = metro.findByProps('getBuiltInCommands') as CommandModule | null;
	if (!commands) throw new Error('Discord built-in commands are unavailable.');

	unpatch = patcher.after(commands, 'getBuiltInCommands', (patch) => {
		appendSavedCommands(patch.args, patch.result, getTags, createCommand);
	});
}

function stop(): void {
	unpatch?.();
	unpatch = null;
	worker = null;
	setMediaContext(null);
}

export default {
	start,
	stop,
	getSettingsPanel: () => <CustomCommandsSettings />,
};
