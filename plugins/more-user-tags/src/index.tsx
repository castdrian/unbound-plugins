import { metro, patcher, settings, storage } from '@unbound-app/api';

const ADDON_ID = 'unbound.more-user-tags';
const SETTINGS_ROUTE = 'unbound.more-user-tags.settings';
const STORE = storage.getStore(ADDON_ID);

type PermissionName =
	| 'ADMINISTRATOR'
	| 'MANAGE_GUILD'
	| 'MANAGE_CHANNELS'
	| 'MANAGE_ROLES'
	| 'MANAGE_WEBHOOKS'
	| 'MANAGE_MESSAGES'
	| 'KICK_MEMBERS'
	| 'BAN_MEMBERS'
	| 'MOVE_MEMBERS'
	| 'MUTE_MEMBERS'
	| 'DEAFEN_MEMBERS';

interface TagDefinition {
	name: string;
	displayName: string;
	description: string;
	permissions?: PermissionName[];
	condition?: (message: any, user: any, guild: any) => boolean;
}

const TAGS: TagDefinition[] = [
	{
		name: 'WEBHOOK',
		displayName: 'Webhook',
		description: 'Messages sent by webhooks',
		condition: (message, user) => Boolean(message?.webhookId) && Boolean(user?.bot),
	},
	{
		name: 'OWNER',
		displayName: 'Owner',
		description: 'Owns the server',
		condition: (_message, user, guild) => Boolean(guild) && guild.ownerId === user?.id,
	},
	{
		name: 'ADMINISTRATOR',
		displayName: 'Admin',
		description: 'Has the administrator permission',
		permissions: ['ADMINISTRATOR'],
	},
	{
		name: 'MODERATOR_STAFF',
		displayName: 'Staff',
		description: 'Can manage the server, channels or roles',
		permissions: ['MANAGE_GUILD', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_WEBHOOKS'],
	},
	{
		name: 'MODERATOR',
		displayName: 'Mod',
		description: 'Can manage messages or kick/ban people',
		permissions: ['MANAGE_MESSAGES', 'KICK_MEMBERS', 'BAN_MEMBERS'],
	},
	{
		name: 'VOICE_MODERATOR',
		displayName: 'VC Mod',
		description: 'Can manage voice chats',
		permissions: ['MOVE_MEMBERS', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS'],
	},
];

let unpatch: (() => void) | null = null;
let permissionBits: Record<string, bigint> | null = null;
let computePermissions: ((options: any) => bigint) | null = null;
let guilds: any = null;
let channels: any = null;

function isTagEnabled(name: string): boolean {
	return STORE.get(`tag.${name}`, true);
}

function hasPermission(user: any, guild: any, channel: any, names: PermissionName[]): boolean {
	if (!guild || !computePermissions || !permissionBits) return false;

	let total: bigint;
	try {
		total = computePermissions({
			user,
			context: guild,
			overwrites: channel?.permissionOverwrites,
		});
	} catch {
		return false;
	}

	return names.some((name) => {
		const bit = permissionBits![name];
		return typeof bit === 'bigint' && (total & bit) === bit;
	});
}

function resolveTag(message: any, user: any, guild: any, channel: any): TagDefinition | null {
	for (const tag of TAGS) {
		if (!isTagEnabled(tag.name)) continue;

		if (tag.condition?.(message, user, guild)) return tag;
		if (!user?.bot && tag.permissions && hasPermission(user, guild, channel, tag.permissions)) {
			return tag;
		}
	}

	return null;
}

function getDesignModule(): { TableRowGroup?: any; TableRow?: any; TableSwitchRow?: any } | null {
	const discord = (metro as any)?.components?.Discord;
	if (discord?.TableRowGroup && discord?.TableRow) return discord;

	const found = metro.findByProps('TableRow', 'TableRowGroup') as any;
	if (found?.TableRowGroup && found?.TableRow) return found;

	return null;
}

function MoreUserTagsSettings() {
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

	return (
		<ReactNative.ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
			<Discord.TableRowGroup title="Tags">
				{TAGS.map((tag) => (
					<SwitchRow
						key={tag.name}
						label={tag.displayName}
						subLabel={tag.description}
						value={state.get(`tag.${tag.name}`, true)}
						onValueChange={(value: boolean) => state.set(`tag.${tag.name}`, value)}
					/>
				))}
			</Discord.TableRowGroup>
		</ReactNative.ScrollView>
	);
}

function registerSettingsPanel(): void {
	settings.registerSettings({
		type: 'route',
		key: SETTINGS_ROUTE,
		useTitle: () => 'More User Tags',
		parent: null,
		addonId: ADDON_ID,
		screen: {
			route: SETTINGS_ROUTE,
			getComponent: () => MoreUserTagsSettings,
		},
	} as Parameters<typeof settings.registerSettings>[0]);
}

export default {
	start() {
		try {
			registerSettingsPanel();
		} catch { }

		permissionBits = (metro.findByProps('Permissions', 'ThemeTypes') as any)?.Permissions ?? null;
		computePermissions =
			(metro.findByProps('computePermissions', 'canEveryoneRole') as any)?.computePermissions ??
			null;
		guilds = metro.findStore('Guild');
		channels = metro.findStore('Channel');

		if (!permissionBits || !computePermissions || !guilds || !channels) return;

		const target = metro.findByName('getTagProperties', { interop: false }) as any;
		if (typeof target?.default !== 'function') return;

		unpatch = patcher.after(target, 'default', (ctx) => {
			try {
				const result = ctx.result as any;
				if (!result || result.tagText) return;

				const message = (ctx.args[0] as any)?.message;
				const user = message?.author;
				if (!user) return;

				const channel = channels.getChannel(message.channel_id);
				const guild = channel?.guild_id ? guilds.getGuild(channel.guild_id) : null;

				const tag = resolveTag(message, user, guild, channel);
				if (!tag) return;

				return { ...result, tagText: tag.displayName, tagVerified: false };
			} catch { }
		});
	},

	stop() {
		unpatch?.();
		unpatch = null;
		permissionBits = null;
		computePermissions = null;
		guilds = null;
		channels = null;
		try {
			settings.removeSettings(SETTINGS_ROUTE);
		} catch { }
	},
};
