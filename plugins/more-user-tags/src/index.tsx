import type { RoleColorStops } from '@more-user-tags/role-colors';
import {
	decideTag,
	decideTagBatch,
	type PermissionName,
	TAGS,
	type TagDecision,
	type TagDecisionInput,
} from '@more-user-tags/tag-decisions';
import { createTagGradientRenderer } from '@more-user-tags/tag-gradient-renderer';

import { SettingsScrollView, SettingsSection, SettingsSwitchRow } from '@shared/settings-ui';
import { metro, patcher, storage } from '@unbound-app/api';
import type { NativeWorkerBridge, PluginContext } from '@unbound-app/api/native';

const ADDON_ID = 'unbound.more-user-tags';
const STORE = storage.getStore(ADDON_ID);

let unpatch: (() => void) | null = null;
let tagGradientRenderer: ReturnType<typeof createTagGradientRenderer> = null;
let worker: NativeWorkerBridge | null = null;
let permissionBits: Record<string, bigint> | null = null;
let computePermissions: ((options: any) => bigint) | null = null;
let guilds: any = null;
let channels: any = null;
let members: any = null;
let tagDecisionTimer: ReturnType<typeof setTimeout> | null = null;
let tagLifecycle = 0;
const tagDecisionCache = new Map<string, { signature: string; decision: TagDecision | null }>();
const pendingTagDecisions = new Map<string, TagDecisionInput>();
const tagDecisionVersions = new Map<string, string>();

function permissionsFor(user: any, guild: any, channel: any): PermissionName[] {
	if (!guild || !computePermissions || !permissionBits) return [];
	try {
		const total = computePermissions({
			user,
			context: guild,
			overwrites: channel?.permissionOverwrites,
		});
		const names = [...new Set(TAGS.flatMap((tag) => tag.permissions ?? []))];
		return names.filter((name) => {
			const bit = permissionBits?.[name];
			return typeof bit === 'bigint' && (total & bit) === bit;
		});
	} catch {
		return [];
	}
}

function tagInput(
	message: any,
	user: any,
	guild: any,
	channel: any,
	opTagText: unknown,
): TagDecisionInput {
	const member = guild ? members?.getMember?.(guild.id, user?.id) : null;
	const colors = member?.colorStrings;
	const memberColors: RoleColorStops | undefined =
		colors && typeof colors.primaryColor === 'string'
			? {
					primaryColor: colors.primaryColor,
					secondaryColor:
						typeof colors.secondaryColor === 'string' ? colors.secondaryColor : undefined,
					tertiaryColor:
						typeof colors.tertiaryColor === 'string' ? colors.tertiaryColor : undefined,
				}
			: undefined;
	return {
		bot: Boolean(user?.bot),
		coloredTags: STORE.get('coloredTags', true),
		enabled: Object.fromEntries(TAGS.map((tag) => [tag.name, STORE.get(`tag.${tag.name}`, true)])),
		enhancedRoleColors: STORE.get('useEnhancedRoleColors', true),
		guildOwnerId: typeof guild?.ownerId === 'string' ? guild.ownerId : undefined,
		id: typeof message?.id === 'string' ? message.id : '',
		memberColor: typeof member?.colorString === 'string' ? member.colorString : undefined,
		memberColors,
		opTagText: typeof opTagText === 'string' ? opTagText : null,
		permissions: permissionsFor(user, guild, channel),
		useOpTagStyle: STORE.get('useOpTagStyle', false),
		useRoleColor: STORE.get('useRoleColor', true),
		userId: typeof user?.id === 'string' ? user.id : undefined,
		webhookId: typeof message?.webhookId === 'string' ? message.webhookId : undefined,
	};
}

function isTagDecisionBatch(value: unknown): value is Array<TagDecision | null> {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				entry === null ||
				(entry &&
					typeof entry.id === 'string' &&
					typeof entry.tagText === 'string' &&
					(entry.style === 'op' || entry.style === 'normal') &&
					Array.isArray(entry.appearance?.colors)),
		)
	);
}

function flushTagDecisions(): void {
	tagDecisionTimer = null;
	if (pendingTagDecisions.size === 0) return;
	const batch = [...pendingTagDecisions.entries()].slice(0, 16);
	for (const [id] of batch) pendingTagDecisions.delete(id);
	const inputs = batch.map(([, input]) => input);
	const signatures = new Map(batch.map(([id, input]) => [id, JSON.stringify(input)]));
	const token = tagLifecycle;
	const request = worker?.available
		? worker.run('decideBatch', inputs, decideTagBatch, isTagDecisionBatch)
		: Promise.resolve(decideTagBatch(inputs));
	void request
		.then((decisions) => {
			if (token !== tagLifecycle || decisions.length !== batch.length) return;
			for (let index = 0; index < batch.length; index++) {
				const id = batch[index][0];
				const signature = signatures.get(id);
				if (!signature || tagDecisionVersions.get(id) !== signature) continue;
				tagDecisionVersions.delete(id);
				tagDecisionCache.delete(id);
				tagDecisionCache.set(id, { signature, decision: decisions[index] ?? null });
				if (tagDecisionCache.size > 400)
					tagDecisionCache.delete(tagDecisionCache.keys().next().value as string);
			}
		})
		.catch(() => undefined)
		.finally(() => {
			if (token === tagLifecycle && pendingTagDecisions.size > 0)
				tagDecisionTimer = setTimeout(flushTagDecisions, 100);
		});
}

function resolveTagDecision(input: TagDecisionInput): TagDecision | null {
	const signature = JSON.stringify(input);
	const cached = tagDecisionCache.get(input.id);
	if (cached?.signature === signature) return cached.decision;
	if (worker?.available && input.id && tagDecisionVersions.get(input.id) !== signature) {
		tagDecisionVersions.set(input.id, signature);
		pendingTagDecisions.set(input.id, input);
		if (tagDecisionTimer) clearTimeout(tagDecisionTimer);
		tagDecisionTimer = setTimeout(flushTagDecisions, 100);
	}
	return decideTag(input);
}

function getDesignModule(): { TableRowGroup?: any; TableRow?: any; TableSwitchRow?: any } | null {
	const discord = (metro as any)?.components?.Discord;
	if (discord?.TableRowGroup && discord?.TableRow) return discord;

	const found = metro.findByProps('TableRow', 'TableRowGroup') as any;
	if (found?.TableRowGroup && found?.TableRow) return found;

	return null;
}

function MoreUserTagsSettings() {
	const state = STORE.useSettingsStore();

	return (
		<SettingsScrollView>
			<SettingsSection title='Tags'>
				{TAGS.map((tag) => (
					<SettingsSwitchRow
						key={tag.name}
						label={tag.displayName}
						description={tag.description}
						value={state.get(`tag.${tag.name}`, true)}
						onValueChange={(value: boolean) => state.set(`tag.${tag.name}`, value)}
					/>
				))}
			</SettingsSection>

			<SettingsSection title='Appearance'>
				<SettingsSwitchRow
					label='Coloured Tags'
					description='Give each tag its own colour instead of the default styling'
					value={state.get('coloredTags', true)}
					onValueChange={(value: boolean) => state.set('coloredTags', value)}
				/>
				<SettingsSwitchRow
					label='Use Role Colour'
					description="Colour tags with the member's role colour where they have one"
					value={state.get('useRoleColor', true)}
					onValueChange={(value: boolean) => state.set('useRoleColor', value)}
				/>
				<SettingsSwitchRow
					label='Use Enhanced Role Colours'
					description='Use gradient and holographic role colours across all generated tags when available'
					value={state.get('useEnhancedRoleColors', true)}
					onValueChange={(value: boolean) => state.set('useEnhancedRoleColors', value)}
				/>
				<SettingsSwitchRow
					label='Use Original Poster Tag Style'
					description='Show staff tags with Discord’s original poster badge styling'
					value={state.get('useOpTagStyle', false)}
					onValueChange={(value: boolean) => state.set('useOpTagStyle', value)}
				/>
			</SettingsSection>
		</SettingsScrollView>
	);
}

export default {
	start(context: PluginContext) {
		tagLifecycle++;
		unpatch?.();
		tagGradientRenderer?.stop();
		unpatch = null;
		tagGradientRenderer = null;
		worker = context.native.worker;

		permissionBits = (metro.findByProps('Permissions', 'ThemeTypes') as any)?.Permissions ?? null;
		computePermissions =
			(metro.findByProps('computePermissions', 'canEveryoneRole') as any)?.computePermissions ??
			null;
		guilds = metro.findStore('Guild');
		channels = metro.findStore('Channel');
		members = metro.findStore('GuildMember');

		if (!permissionBits || !computePermissions || !guilds || !channels) return;

		const target = metro.findByName('getTagProperties', { interop: false }) as any;
		if (typeof target?.default !== 'function') return;
		tagGradientRenderer = createTagGradientRenderer(context);

		unpatch = patcher.after(target, 'default', (ctx) => {
			try {
				const result = ctx.result as any;
				if (!result) return;

				const message = (ctx.args[0] as any)?.message;
				const user = message?.author;
				if (!user) return;

				const channel = channels.getChannel(message.channel_id);
				const guild = channel?.guild_id ? guilds.getGuild(channel.guild_id) : null;

				const decision = resolveTagDecision(
					tagInput(message, user, guild, channel, result.opTagText),
				);
				if (!decision) return;

				const { appearance } = decision;
				const background = decision.background;
				const { processColor } = metro.common.ReactNative;
				const useOpTagStyle = decision.style === 'op';
				const tagText = decision.tagText;
				if (useOpTagStyle) {
					const tagged = {
						...result,
						tagText: null,
						tagAccessibilityLabel: tagText,
						tagVerified: false,
						tagTextColor: null,
						tagBackgroundColor: null,
						tagType: null,
						tagIconUrl: null,
						opTagText: tagText,
					};
					tagGradientRenderer?.setAppearance([tagText], appearance);
					if (!background) return tagged;
					return {
						...tagged,
						opTagBackgroundColor: processColor(background),
						opTagTextColor: processColor(decision.textColor),
					};
				}
				const tagged = {
					...result,
					opTagText: null,
					opTagBackgroundColor: null,
					opTagTextColor: null,
					tagText,
					tagAccessibilityLabel: tagText,
					tagVerified: false,
				};
				tagGradientRenderer?.setAppearance([tagText], appearance);
				if (!background) return tagged;

				return {
					...tagged,
					tagBackgroundColor: processColor(background),
					tagTextColor: processColor(decision.textColor),
				};
			} catch {}
		});
	},

	stop() {
		tagLifecycle++;
		unpatch?.();
		tagGradientRenderer?.stop();
		unpatch = null;
		tagGradientRenderer = null;
		worker = null;
		if (tagDecisionTimer) clearTimeout(tagDecisionTimer);
		tagDecisionTimer = null;
		tagDecisionCache.clear();
		pendingTagDecisions.clear();
		tagDecisionVersions.clear();
		permissionBits = null;
		computePermissions = null;
		guilds = null;
		channels = null;
		members = null;
	},
	getSettingsPanel: () => <MoreUserTagsSettings />,
};
