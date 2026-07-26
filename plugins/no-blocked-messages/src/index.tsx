import { metro, patcher, settings, storage } from '@unbound-app/api';

const ADDON_ID = 'unbound.no-blocked-messages';
const SETTINGS_ROUTE = 'unbound.no-blocked-messages.settings';
const STORE = storage.getStore(ADDON_ID);

type ChatManager = {
	setup(messages: Iterable<unknown>): void;
	createRow(row: unknown): void;
	createChangeset(): unknown;
};

type RowManager = {
	generate(row: unknown): unknown;
};

type ChatUpdatesQueue = {
	add(changeset: unknown): void;
	tryFlush(): void;
};

type ChatRuntime = {
	chatManager: ChatManager | null;
	rowManager: RowManager | null;
	messages: Iterable<unknown> | null;
	updatesQueue: ChatUpdatesQueue | null;
};

let unpatchCreateRow: (() => void) | null = null;
let unpatchChatManagerSetup: (() => void) | null = null;
let unpatchRowManagerGenerate: (() => void) | null = null;
let unpatchUpdatesQueueAdd: (() => void) | null = null;

function getRuntime(): ChatRuntime {
	const root = globalThis as Record<string, ChatRuntime | undefined>;

	return root.__unboundNoBlockedMessagesRuntime ??= {
		chatManager: null,
		rowManager: null,
		messages: null,
		updatesQueue: null,
	};
}

function isEnabled(): boolean {
	return STORE.get('enabled', true);
}

function refreshRows(): void {
	const runtime = getRuntime();

	if (!runtime.chatManager || !runtime.rowManager || !runtime.messages || !runtime.updatesQueue) return;

	runtime.chatManager.setup(runtime.messages);
	for (const row of runtime.messages) {
		runtime.chatManager.createRow(runtime.rowManager.generate(row));
	}

	runtime.updatesQueue.add(runtime.chatManager.createChangeset());
	runtime.updatesQueue.tryFlush();
}

function installPatches(): void {
	const ChatManager = metro.find((module) => module?.default?.name === 'ChatManager')?.default;
	const RowManager = metro.find((module) => module?.default?.name === 'RowManager')?.default;
	const ChatUpdatesQueue = metro.find((module) => module?.default?.name === 'ChatUpdatesQueue')?.default;
	const runtime = getRuntime();

	if (ChatManager?.prototype?.createRow) {
		unpatchChatManagerSetup = patcher.before(ChatManager.prototype, 'setup', (context) => {
			runtime.chatManager = context.this as ChatManager;
			runtime.messages = context.args[0] as Iterable<unknown>;
		});

		unpatchCreateRow = patcher.instead(ChatManager.prototype, 'createRow', (context) => {
			if (isEnabled() && context.args[0]?.type === 2) return;

			return context.original.apply(context.this, context.args);
		});
	}

	if (RowManager?.prototype?.generate) {
		unpatchRowManagerGenerate = patcher.before(RowManager.prototype, 'generate', (context) => {
			runtime.rowManager = context.this as RowManager;
		});
	}

	if (ChatUpdatesQueue?.prototype?.add) {
		unpatchUpdatesQueueAdd = patcher.before(ChatUpdatesQueue.prototype, 'add', (context) => {
			runtime.updatesQueue = context.this as ChatUpdatesQueue;
		});
	}
}

function removePatches(): void {
	unpatchCreateRow?.();
	unpatchCreateRow = null;
	refreshRows();
	unpatchChatManagerSetup?.();
	unpatchChatManagerSetup = null;
	unpatchRowManagerGenerate?.();
	unpatchRowManagerGenerate = null;
	unpatchUpdatesQueueAdd?.();
	unpatchUpdatesQueueAdd = null;
}

function ReactNativeSettingsScreen() {
	const ReactNative = metro.common.ReactNative;
	const Discord = (metro.components as any)?.Discord;
	const state = STORE.useSettingsStore();

	if (!Discord?.TableRowGroup || !Discord?.TableRow) {
		return (
			<ReactNative.ScrollView contentContainerStyle={{ padding: 16 }}>
				<ReactNative.Text>Settings are unavailable on this client build.</ReactNative.Text>
			</ReactNative.ScrollView>
		);
	}

	const SwitchRow = Discord.TableSwitchRow ?? Discord.TableRow;

	return (
		<ReactNative.ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
			<Discord.TableRowGroup title="Blocked Messages">
				<SwitchRow
					label="Hide Blocked Messages"
					subLabel="Hide the collapsed blocked-message group in chat"
					value={state.get('enabled', true)}
					onValueChange={(value: boolean) => {
						state.set('enabled', value);
						refreshRows();
					}}
				/>
			</Discord.TableRowGroup>
		</ReactNative.ScrollView>
	);
}

function registerSettingsPanel(): void {
	settings.registerSettings({
		type: 'route',
		key: SETTINGS_ROUTE,
		useTitle: () => 'No Blocked Messages',
		parent: null,
		addonId: ADDON_ID,
		screen: {
			route: SETTINGS_ROUTE,
			getComponent: () => ReactNativeSettingsScreen,
		},
	} as Parameters<typeof settings.registerSettings>[0]);
}

export default {
	start() {
		try {
			registerSettingsPanel();
		} catch { }

		installPatches();
		refreshRows();
	},

	stop() {
		removePatches();
		try {
			settings.removeSettings(SETTINGS_ROUTE);
		} catch { }
	},
};
