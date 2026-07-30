import { metro, patcher, settings, storage } from '@unbound-app/api';

const ADDON_ID = 'unbound.show-me-your-name';
const SETTINGS_ROUTE = 'unbound.show-me-your-name.settings';
const STORE = storage.getStore(ADDON_ID);

let unpatch: (() => void) | null = null;
let users: { getUser?: (id: string) => Author | undefined } | null = null;
let relationships: {
	getNickname?: (userId: string) => string | null;
} | null = null;

type Mode = 'user-nick' | 'nick-user' | 'user';

interface Author {
	id?: string;
	username?: string;
	globalName?: string;
}

const ROW_GENERATOR_PATH = 'modules/messages/native/renderer/MessageWithContent.tsx';

const MODES: { key: Mode; label: string; subLabel: string }[] = [
	{ key: 'nick-user', label: 'Display name then username', subLabel: 'Display Name (@username)' },
	{ key: 'user-nick', label: 'Username then display name', subLabel: '@username (Display Name)' },
	{ key: 'user', label: 'Username only', subLabel: '@username' },
];

function buildLabel(author: Author | undefined, displayed: string | undefined): string | null {
	if (!author || typeof displayed !== 'string') return null;

	const mode = STORE.get<Mode>('mode', 'nick-user');
	const useDisplayNames = STORE.get('displayNames', false);

	let username = author.username ?? '';
	if (useDisplayNames && author.globalName) username = author.globalName;
	if (!username) return null;

	const prefix = displayed.startsWith('@') ? '@' : '';
	const friendNickname = STORE.get('friendNicknames', true) && author.id ? relationships?.getNickname?.(author.id) : null;
	const nick = friendNickname ?? (prefix ? displayed.slice(1) : displayed);
	const tag = `@${username}`;

	if (username === nick) return displayed;
	if (mode === 'user') return tag;
	if (mode === 'user-nick') return `${tag} (${nick})`;
	return `${prefix}${nick} (${tag})`;
}

function rewriteUsername(rowMessage: any, author?: Author): void {
	if (!rowMessage) return;

	const resolved = author ?? (rowMessage.authorId ? users?.getUser?.(rowMessage.authorId) : undefined);
	const label = buildLabel(resolved, rowMessage.username);
	if (label != null) rowMessage.username = label;
}

function getDesignModule(): { TableRowGroup?: any; TableRow?: any; TableSwitchRow?: any } | null {
	const discord = (metro as any)?.components?.Discord;
	if (discord?.TableRowGroup && discord?.TableRow) return discord;

	const found = metro.findByProps('TableRow', 'TableRowGroup') as any;
	if (found?.TableRowGroup && found?.TableRow) return found;

	return null;
}

function ReactNativeSettingsScreen() {
	const ReactNative = metro.common.ReactNative;
	const Discord = getDesignModule();
	const state = STORE.useSettingsStore();

	if (!Discord?.TableRowGroup || !Discord?.TableRow) {
		return (
			<ReactNative.ScrollView contentContainerStyle={{ padding: 16 }}>
				<ReactNative.Text>Settings are unavailable on this client build.</ReactNative.Text>
			</ReactNative.ScrollView>
		);
	}

	const SwitchRow = Discord.TableSwitchRow ?? Discord.TableRow;
	const mode = state.get<Mode>('mode', 'nick-user');

	return (
		<ReactNative.ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
			<Discord.TableRowGroup title="Display Mode">
				{MODES.map(({ key, label, subLabel }) => (
					<Discord.TableRow
						key={key}
						label={label}
						subLabel={subLabel}
						trailing={mode === key ? <ReactNative.Text>✓</ReactNative.Text> : null}
						onPress={() => state.set('mode', key)}
					/>
				))}
			</Discord.TableRowGroup>

			<Discord.TableRowGroup title="Preferences">
				<SwitchRow
					label="Show Friend Nicknames"
					subLabel="Prefer a friend's nickname wherever it applies"
					value={state.get('friendNicknames', true)}
					onValueChange={(value: boolean) => state.set('friendNicknames', value)}
				/>
				<SwitchRow
					label="Use Global Names"
					subLabel="Show the account's global name instead of its username"
					value={state.get('displayNames', false)}
					onValueChange={(value: boolean) => state.set('displayNames', value)}
				/>
				<SwitchRow
					label="Apply To Replies"
					subLabel="Also apply to reply previews"
					value={state.get('inReplies', false)}
					onValueChange={(value: boolean) => state.set('inReplies', value)}
				/>
			</Discord.TableRowGroup>
		</ReactNative.ScrollView>
	);
}

function registerSettingsPanel(): void {
	settings.registerSettings({
		type: 'route',
		key: SETTINGS_ROUTE,
		useTitle: () => 'Show Me Your Name',
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

		const target = metro.findByFilePath(ROW_GENERATOR_PATH);
		if (typeof target?.generateMessageRowData !== 'function') return;

		users = metro.findByProps('getCurrentUser', 'getUser');
		relationships = metro.findStore('RelationshipStore', { short: false });

		unpatch = patcher.after(target, 'generateMessageRowData', (ctx) => {
			try {
				const row = ctx.result?.message;
				if (!row) return;

				rewriteUsername(row, (ctx.args[0] as any)?.message?.author);

				if (STORE.get('inReplies', false)) {
					rewriteUsername(row.referencedMessage?.message);
				}
			} catch { }
		});
	},

	stop() {
		unpatch?.();
		unpatch = null;
		users = null;
		relationships = null;
		try {
			settings.removeSettings(SETTINGS_ROUTE);
		} catch { }
	},
};
