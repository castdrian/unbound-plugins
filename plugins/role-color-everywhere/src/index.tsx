import {
	applyChatRoleColors,
	type ChatColorOptions,
	type ChatRow,
	type MemberStore,
} from '@role-color-everywhere/chat-rows';
import { installMemberListColors } from '@role-color-everywhere/member-list';
import { installPollVoterColors } from '@role-color-everywhere/poll-voters';
import { installReactionUserColors } from '@role-color-everywhere/reaction-users';
import { installNativeMentionColors } from '@role-color-everywhere/native-mentions';
import { installComposerMentionColors } from '@role-color-everywhere/composer-mentions';
import { installTypingNameColors } from '@role-color-everywhere/typing-names';
import { installVoiceUserColors } from '@role-color-everywhere/voice-users';

import {
	getSettingsColors,
	SettingsCard,
	SettingsScrollView,
	SettingsSection,
	SettingsSwitchRow,
} from '@shared/settings-ui';
import { metro, patcher, storage } from '@unbound-app/api';
import type { NativeObjCBridge, PluginContext } from '@unbound-app/api/native';

const ADDON_ID = 'unbound.role-color-everywhere';
const STORE = storage.getStore(ADDON_ID);

type RowManager = { prototype: { generate: (row: unknown) => unknown } };

let members: MemberStore | null = null;
let nativeObjC: NativeObjCBridge | null = null;
let unpatchRows: (() => void) | null = null;
let unpatchMemberList: (() => void) | null = null;
let unpatchNativeMentions: (() => void) | null = null;
let unpatchComposerMentions: (() => void) | null = null;
let unpatchTypingNames: (() => void) | null = null;
let unpatchReactionUsers: (() => void) | null = null;
let unpatchPollVoters: (() => void) | null = null;
let unpatchVoiceUsers: (() => void) | null = null;
let removeModuleListener: (() => boolean) | null = null;

function chatOptions(): ChatColorOptions {
	return {
		chatMentions: STORE.get('chatMentions', true),
		colorChatMessages: STORE.get('colorChatMessages', false),
		messageSaturation: STORE.get('messageSaturation', 30),
	};
}

function patchRows(): boolean {
	if (unpatchRows) return true;
	const RowManager = metro.findByName('RowManager') as RowManager | null;
	if (typeof RowManager?.prototype?.generate !== 'function' || !members) return false;

	unpatchRows = patcher.after(RowManager.prototype, 'generate', ({ result }) => {
		try {
			if (members) applyChatRoleColors(result as ChatRow, members, chatOptions());
		} catch (error) {
			console.error('Role Color Everywhere chat styling failed:', error);
		}
	});
	return true;
}

function setNativeMentions(enabled: boolean): void {
	unpatchNativeMentions?.();
	unpatchNativeMentions = null;
	unpatchComposerMentions?.();
	unpatchComposerMentions = null;
	if (!enabled || !nativeObjC || !members) return;
	unpatchNativeMentions = installNativeMentionColors(nativeObjC, members, () =>
		STORE.get('chatMentions', true),
	);
	unpatchComposerMentions = installComposerMentionColors(
		nativeObjC,
		members as Parameters<typeof installComposerMentionColors>[1],
		() => STORE.get('chatMentions', true),
	);
}

function RoleColorSettings() {
	const settings = STORE.useSettingsStore();
	const Slider = (metro.findByProps('Slider') as { Slider?: any } | null)?.Slider;
	const colors = getSettingsColors();
	const saturation = settings.get('messageSaturation', 30);

	return (
		<SettingsScrollView>
			<SettingsSection title='Chat'>
				<SettingsSwitchRow
					label='Color Mentions'
					description='Show the mentioned member’s role colors in chat and the composer'
					value={settings.get('chatMentions', true)}
					onValueChange={(value: boolean) => {
						settings.set('chatMentions', value);
						setNativeMentions(value);
					}}
				/>
				<SettingsSwitchRow
					label='Color Message Content'
					description='Tint message text with the author’s role color'
					value={settings.get('colorChatMessages', false)}
					onValueChange={(value: boolean) => settings.set('colorChatMessages', value)}
				/>
				{Slider ? (
					<SettingsCard>
						<metro.common.ReactNative.View style={{ gap: 10 }}>
							<metro.common.ReactNative.Text
								style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}
							>
								Message color intensity · {saturation}%
							</metro.common.ReactNative.Text>
							<Slider
								minimumValue={0}
								maximumValue={100}
								value={saturation}
								onValueChange={(value: number) =>
									settings.set('messageSaturation', Math.round(value / 10) * 10)
								}
							/>
						</metro.common.ReactNative.View>
					</SettingsCard>
				) : null}
			</SettingsSection>
			<SettingsSection title='People and Roles'>
				<SettingsSwitchRow
					label='Typing Names'
					description='Color names in the channel typing indicator'
					value={settings.get('typingUsers', true)}
					onValueChange={(value: boolean) => settings.set('typingUsers', value)}
				/>
				<SettingsSwitchRow
					label='Member List Role Headers'
					description='Color role section titles in the member list'
					value={settings.get('memberList', true)}
					onValueChange={(value: boolean) => settings.set('memberList', value)}
				/>
				<SettingsSwitchRow
					label='Reaction Users'
					description='Color names in the reaction details list'
					value={settings.get('reactorsList', true)}
					onValueChange={(value: boolean) => settings.set('reactorsList', value)}
				/>
				<SettingsSwitchRow
					label='Poll Voters'
					description='Color names in poll result details'
					value={settings.get('pollResults', true)}
					onValueChange={(value: boolean) => settings.set('pollResults', value)}
				/>
				<SettingsSwitchRow
					label='Voice Users'
					description='Color members’ names in voice user lists'
					value={settings.get('voiceUsers', true)}
					onValueChange={(value: boolean) => settings.set('voiceUsers', value)}
				/>
			</SettingsSection>
		</SettingsScrollView>
	);
}

export default {
	start(context?: PluginContext) {
		members = metro.findStore('GuildMember') as MemberStore | null;
		if (members)
			unpatchTypingNames = installTypingNameColors(members, () => STORE.get('typingUsers', true));
		if (members)
			unpatchReactionUsers = installReactionUserColors(members, () =>
				STORE.get('reactorsList', true),
			);
		if (members)
			unpatchPollVoters = installPollVoterColors(members, () => STORE.get('pollResults', true));
		if (members)
			unpatchVoiceUsers = installVoiceUserColors(members, () => STORE.get('voiceUsers', true));
		nativeObjC = context?.native.objc ?? null;
		setNativeMentions(STORE.get('chatMentions', true));
		const roles = metro.findStore('GuildRole') as
			| Parameters<typeof installMemberListColors>[0]
			| null;
		if (roles)
			unpatchMemberList = installMemberListColors(roles, () => STORE.get('memberList', true));
		if (patchRows()) return;
		removeModuleListener = metro.addListener(() => {
			if (!patchRows()) return;
			removeModuleListener?.();
			removeModuleListener = null;
		});
	},
	stop() {
		unpatchComposerMentions?.();
		unpatchComposerMentions = null;
		unpatchTypingNames?.();
		unpatchTypingNames = null;
		unpatchReactionUsers?.();
		unpatchReactionUsers = null;
		unpatchPollVoters?.();
		unpatchPollVoters = null;
		unpatchVoiceUsers?.();
		unpatchVoiceUsers = null;
		unpatchNativeMentions?.();
		unpatchNativeMentions = null;
		unpatchMemberList?.();
		unpatchMemberList = null;
		unpatchRows?.();
		unpatchRows = null;
		removeModuleListener?.();
		removeModuleListener = null;
		nativeObjC = null;
		members = null;
	},
	getSettingsPanel: () => <RoleColorSettings />,
};
