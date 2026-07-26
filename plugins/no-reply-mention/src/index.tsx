import { metro, patcher, settings, storage } from '@unbound-app/api';

const ADDON_ID = 'unbound.no-reply-mention';
const SETTINGS_ROUTE = 'unbound.no-reply-mention.settings';
const STORE = storage.getStore(ADDON_ID);

let unpatch: (() => void) | null = null;

interface PendingReply {
	message?: { author?: { id?: string } };
	shouldMention?: boolean;
}

function parseUserList(): string[] {
	return STORE.get('userList', '')
		.split(/[\s,]+/)
		.map((id: string) => id.trim())
		.filter(Boolean);
}

function shouldMention(authorId: string | undefined): boolean {
	if (!authorId) return false;

	const listed = parseUserList().includes(authorId);
	return STORE.get('shouldPingListed', false) ? listed : !listed;
}

function getDesignModule(): { TableRowGroup?: any; TableRow?: any; TableSwitchRow?: any } | null {
	const discord = (metro as any)?.components?.Discord;
	if (discord?.TableRowGroup && discord?.TableRow) return discord;

	const found = metro.findByProps('TableRow', 'TableRowGroup') as any;
	if (found?.TableRowGroup && found?.TableRow) return found;

	return null;
}

function NoReplyMentionSettings() {
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
	const pingListed = state.get('shouldPingListed', false);

	return (
		<ReactNative.ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
			<Discord.TableRowGroup title="Exceptions">
				<Discord.TableRow
					label="User IDs"
					subLabel={state.get('userList', '') || 'None set'}
				/>
				<SwitchRow
					label="Only Ping Listed Users"
					subLabel={
						pingListed
							? 'Replies mention only the users listed above'
							: 'Replies mention everyone except the users listed above'
					}
					value={pingListed}
					onValueChange={(value: boolean) => state.set('shouldPingListed', value)}
				/>
			</Discord.TableRowGroup>
		</ReactNative.ScrollView>
	);
}

function registerSettingsPanel(): void {
	settings.registerSettings({
		type: 'route',
		key: SETTINGS_ROUTE,
		useTitle: () => 'No Reply Mention',
		parent: null,
		addonId: ADDON_ID,
		screen: {
			route: SETTINGS_ROUTE,
			getComponent: () => NoReplyMentionSettings,
		},
	} as Parameters<typeof settings.registerSettings>[0]);
}

export default {
	start() {
		try {
			registerSettingsPanel();
		} catch { }

		const actions = metro.findByProps('createPendingReply') as any;
		if (typeof actions?.createPendingReply !== 'function') return;

		unpatch = patcher.before(actions, 'createPendingReply', (ctx) => {
			const reply = ctx.args[0] as PendingReply | undefined;
			if (!reply) return;

			reply.shouldMention = shouldMention(reply.message?.author?.id);
		});
	},

	stop() {
		unpatch?.();
		unpatch = null;
		try {
			settings.removeSettings(SETTINGS_ROUTE);
		} catch { }
	},
};
