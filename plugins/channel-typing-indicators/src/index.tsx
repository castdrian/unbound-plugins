import {
	SettingsRow,
	SettingsScrollView,
	SettingsSection,
	SettingsSwitchRow,
} from '@shared/settings-ui';
import { metro, patcher, storage } from '@unbound-app/api';

const ADDON_ID = 'unbound.channel-typing-indicators';
const TEXT_CHANNEL_PATH = 'modules/channel_list_v2/native/items/TextChannel.tsx';
const THREAD_CHANNEL_PATH = 'modules/channel_list_v2/native/items/ThreadChannel.tsx';
const STORE = storage.getStore(ADDON_ID);
const MAX_AVATARS = 3;
const DOTS = 1;
const AVATARS = 2;

type Channel = { id: string; guild_id?: string; name?: string };
type User = { id: string; username?: string; globalName?: string };
type ChannelRowProps = { channel?: Channel; muted?: boolean };
type TypingStore = {
	getTypingUsers: (channelId: string) => Record<string, number> | null | undefined;
	addChangeListener: (listener: () => void) => void;
	removeChangeListener: (listener: () => void) => void;
};
type UserStore = {
	getCurrentUser: () => User | null | undefined;
	getUser: (id: string) => User | null | undefined;
};
type RelationshipStore = {
	isBlocked: (id: string) => boolean;
	isIgnored?: (id: string) => boolean;
	addChangeListener?: (listener: () => void) => void;
	removeChangeListener?: (listener: () => void) => void;
};
type SelectedChannelStore = {
	getChannelId: () => string | null | undefined;
	addChangeListener?: (listener: () => void) => void;
	removeChangeListener?: (listener: () => void) => void;
};
type GuildSettingsStore = {
	isChannelMuted: (guildId: string | undefined, channelId: string) => boolean;
	addChangeListener?: (listener: () => void) => void;
	removeChangeListener?: (listener: () => void) => void;
};
type MemberStore = { getNick?: (guildId: string, userId: string) => string | null | undefined };
type AvatarComponents = {
	Avatar: any;
	AvatarSizes: { SIZE_16: unknown };
};
type ThemeModule = {
	colors: Record<string, unknown>;
	internal: { resolveSemanticColor: (theme: string, color: unknown) => string };
	themes: Record<string, string>;
};
type ThemeStore = {
	theme?: string;
	addChangeListener?: (listener: () => void) => void;
	removeChangeListener?: (listener: () => void) => void;
};

let typingStore: TypingStore | null = null;
let userStore: UserStore | null = null;
let relationshipStore: RelationshipStore | null = null;
let selectedChannelStore: SelectedChannelStore | null = null;
let guildSettingsStore: GuildSettingsStore | null = null;
let memberStore: MemberStore | null = null;
let avatarComponents: AvatarComponents | null = null;
let themeStore: ThemeStore | null = null;
let unpatchText: (() => void) | null = null;
let unpatchThread: (() => void) | null = null;
let unpatchThreadRenderer: (() => void) | null = null;
let threadRenderer: ((props: any) => any) | null = null;
let threadRendererHost: { render: (props: any) => any } | null = null;
let removeModuleListener: (() => boolean) | null = null;
let started = false;
const activeIndicators = new Set<() => void>();

export function visibleTypingIds(
	typingUsers: Record<string, number> | null | undefined,
	currentUserId: string | undefined,
	isBlocked: (id: string) => boolean,
	includeBlockedUsers: boolean,
	isIgnored: (id: string) => boolean = () => false,
	includeIgnoredUsers: boolean = false,
): string[] {
	if (!typingUsers) return [];
	return Object.keys(typingUsers).filter(
		(id) =>
			id !== currentUserId &&
			(includeBlockedUsers || !isBlocked(id)) &&
			(includeIgnoredUsers || !isIgnored(id)),
	);
}

export function sameIds(first: string[], second: string[]): boolean {
	return first.length === second.length && first.every((id, index) => id === second[index]);
}

function displayName(user: User, guildId?: string): string {
	return (
		(guildId ? memberStore?.getNick?.(guildId, user.id) : undefined) ??
		user.globalName ??
		user.username ??
		user.id
	);
}

function readTypingIds(
	channel: Channel,
	muted: boolean,
	includeMuted: boolean,
	includeBlocked: boolean,
	includeIgnored: boolean,
	includeCurrent: boolean,
): string[] {
	if (!includeCurrent && selectedChannelStore?.getChannelId?.() === channel.id) return [];
	if (
		!includeMuted &&
		(muted || guildSettingsStore?.isChannelMuted?.(channel.guild_id, channel.id))
	)
		return [];
	return visibleTypingIds(
		typingStore?.getTypingUsers(channel.id),
		userStore?.getCurrentUser()?.id,
		(id) => relationshipStore?.isBlocked(id) ?? false,
		includeBlocked,
		(id) => relationshipStore?.isIgnored?.(id) ?? false,
		includeIgnored,
	);
}

function TypingDots() {
	const { React, ReactNative } = metro.common;
	const Animated = ReactNative.Animated;
	const theme = (metro.common as any).Theme as ThemeModule;
	const [appearance, setAppearance] = React.useState(themeStore?.theme ?? theme.themes.DARK);
	const dotColor = theme.internal.resolveSemanticColor(appearance, theme.colors.TEXT_MUTED);
	const values = React.useRef([
		new Animated.Value(0.35),
		new Animated.Value(0.35),
		new Animated.Value(0.35),
	]).current;

	React.useEffect(() => {
		const currentStore = themeStore;
		function refresh(): void {
			setAppearance(currentStore?.theme ?? theme.themes.DARK);
		}
		currentStore?.addChangeListener?.(refresh);
		return () => currentStore?.removeChangeListener?.(refresh);
	}, [theme]);

	React.useEffect(() => {
		const timing = (value: any, toValue: number) =>
			Animated.timing(value, { toValue, duration: 220, useNativeDriver: true });
		const animation = Animated.loop(
			Animated.sequence([
				timing(values[0], 1),
				Animated.parallel([timing(values[0], 0.35), timing(values[1], 1)]),
				Animated.parallel([timing(values[1], 0.35), timing(values[2], 1)]),
				timing(values[2], 0.35),
				Animated.delay(240),
			]),
		);
		animation.start();
		return () => animation.stop();
	}, [Animated, values]);

	return (
		<ReactNative.View
			style={{ alignItems: 'center', flexDirection: 'row', height: 16, marginLeft: 4 }}
		>
			{values.map((value: any, index: number) => (
				<Animated.View
					key={index}
					style={{
						backgroundColor: dotColor,
						borderRadius: 2.5,
						height: 5,
						marginHorizontal: 1.5,
						opacity: value,
						width: 5,
					}}
				/>
			))}
		</ReactNative.View>
	);
}

function TypingAvatars({ users, guildId }: { users: User[]; guildId?: string }) {
	const { ReactNative } = metro.common;
	const visible = users.slice(0, MAX_AVATARS);
	const components = avatarComponents;
	if (!components?.Avatar) return null;
	return (
		<ReactNative.View style={{ alignItems: 'center', flexDirection: 'row', marginLeft: 6 }}>
			{visible.map((user, index) => (
				<ReactNative.View
					key={user.id}
					style={{ marginLeft: index ? -6 : 0, zIndex: visible.length - index }}
				>
					<components.Avatar user={user} size={components.AvatarSizes.SIZE_16} guildId={guildId} />
				</ReactNative.View>
			))}
		</ReactNative.View>
	);
}

function ChannelTypingIndicator({ channel, muted }: { channel: Channel; muted: boolean }) {
	const { React, ReactNative } = metro.common;
	const settings = STORE.useSettingsStore();
	const includeMuted = settings.get('includeMutedChannels', false);
	const includeBlocked = settings.get('includeBlockedUsers', false);
	const includeIgnored = settings.get('includeIgnoredUsers', false);
	const includeCurrent = settings.get('includeCurrentChannel', true);
	const indicatorMode = settings.get('indicatorMode', DOTS | AVATARS);
	const [typingIds, setTypingIds] = React.useState<string[]>(() =>
		readTypingIds(channel, muted, includeMuted, includeBlocked, includeIgnored, includeCurrent),
	);

	React.useEffect(() => {
		const currentTypingStore = typingStore;
		const currentRelationshipStore = relationshipStore;
		const currentGuildSettingsStore = guildSettingsStore;
		const currentSelectedChannelStore = selectedChannelStore;
		function refresh(): void {
			const next = readTypingIds(
				channel,
				muted,
				includeMuted,
				includeBlocked,
				includeIgnored,
				includeCurrent,
			);
			setTypingIds((current) => (sameIds(current, next) ? current : next));
		}
		function remove(): void {
			currentTypingStore?.removeChangeListener(refresh);
			currentRelationshipStore?.removeChangeListener?.(refresh);
			currentGuildSettingsStore?.removeChangeListener?.(refresh);
			currentSelectedChannelStore?.removeChangeListener?.(refresh);
			activeIndicators.delete(dispose);
		}
		function dispose(): void {
			remove();
			setTypingIds([]);
		}

		refresh();
		currentTypingStore?.addChangeListener(refresh);
		currentRelationshipStore?.addChangeListener?.(refresh);
		currentGuildSettingsStore?.addChangeListener?.(refresh);
		currentSelectedChannelStore?.addChangeListener?.(refresh);
		activeIndicators.add(dispose);
		return remove;
	}, [
		channel.id,
		channel.guild_id,
		muted,
		includeMuted,
		includeBlocked,
		includeIgnored,
		includeCurrent,
	]);

	if (!typingIds.length) return null;
	const typingUsers = typingIds
		.map((id) => userStore?.getUser(id))
		.filter((user): user is User => Boolean(user));
	const names = typingUsers.map((user) => displayName(user, channel.guild_id));
	const label = `${names.join(', ') || `${typingIds.length} people`} typing`;

	return (
		<ReactNative.View
			accessibilityLabel={label}
			pointerEvents='none'
			style={{ alignItems: 'center', flexDirection: 'row', flexShrink: 0 }}
		>
			{indicatorMode & AVATARS && typingUsers.length ? (
				<TypingAvatars users={typingUsers} guildId={channel.guild_id} />
			) : null}
			{indicatorMode & DOTS ? <TypingDots /> : null}
		</ReactNative.View>
	);
}

export function insertTypingIndicator(result: any, channel: Channel, muted: boolean): any {
	const { React } = metro.common;
	const outerChildren = result?.props?.children;
	if (!Array.isArray(outerChildren)) return result;
	const row = outerChildren.find((child) => child?.props?.accessibilityRole === 'button');
	const rowChildren = row?.props?.children;
	if (!Array.isArray(rowChildren)) return result;
	const content = rowChildren.find(
		(child) =>
			Array.isArray(child?.props?.children) &&
			child.props.children.some((part: any) => part?.props?.channel?.id === channel.id),
	);
	if (!content) return result;
	const contentChildren = content.props.children;
	if (contentChildren.some((part: any) => part?.type === ChannelTypingIndicator)) return result;
	const infoIndex = contentChildren.findIndex(
		(part: any) => part?.props?.channel?.id === channel.id,
	);
	if (infoIndex < 0) return result;
	const indicator = <ChannelTypingIndicator channel={channel} muted={muted} />;
	const nextContent = React.cloneElement(content, {}, [
		...contentChildren.slice(0, infoIndex),
		indicator,
		...contentChildren.slice(infoIndex),
	]);
	const nextRow = React.cloneElement(
		row,
		{},
		rowChildren.map((child: any) => (child === content ? nextContent : child)),
	);
	return React.cloneElement(
		result,
		{},
		outerChildren.map((child: any) => (child === row ? nextRow : child)),
	);
}

export function insertThreadTypingIndicator(result: any, channel: Channel, muted: boolean): any {
	const { React, ReactNative } = metro.common;
	const outerChildren = result?.props?.children;
	if (!Array.isArray(outerChildren)) return result;
	for (const container of outerChildren) {
		const children = container?.props?.children;
		if (!Array.isArray(children)) continue;
		const row = children.find(
			(child) =>
				child?.props?.channel?.id === channel.id && child.props.accessibilityRole === 'button',
		);
		if (!row) continue;
		const currentInfo = row.props.channelInfo;
		if (
			currentInfo?.type === ChannelTypingIndicator ||
			currentInfo?.props?.children?.[1]?.type === ChannelTypingIndicator
		)
			return result;
		const indicator = <ChannelTypingIndicator channel={channel} muted={muted} />;
		const channelInfo = currentInfo ? (
			<ReactNative.View style={{ alignItems: 'center', flexDirection: 'row' }}>
				{currentInfo}
				{indicator}
			</ReactNative.View>
		) : (
			indicator
		);
		const nextRow = React.cloneElement(row, { channelInfo });
		const nextContainer = React.cloneElement(
			container,
			{},
			children.map((child: any) => (child === row ? nextRow : child)),
		);
		return React.cloneElement(
			result,
			{},
			outerChildren.map((child: any) => (child === container ? nextContainer : child)),
		);
	}
	return result;
}

function patchTextChannel(module: any): boolean {
	const target = module?.default;
	if (unpatchText || typeof target?.type !== 'function') return Boolean(unpatchText);
	unpatchText = patcher.after(target, 'type', ({ args, result }) => {
		const { channel, muted } = (args[0] ?? {}) as ChannelRowProps;
		if (!channel?.id) return result;
		return insertTypingIndicator(result, channel, Boolean(muted));
	});
	return true;
}

function patchThreadChannel(module: any): boolean {
	if (unpatchThread || typeof module?.default !== 'function') return Boolean(unpatchThread);
	unpatchThread = patcher.after(module, 'default', ({ result }) => {
		if (typeof result?.type !== 'function') return result;
		if (threadRenderer !== result.type) {
			unpatchThreadRenderer?.();
			threadRenderer = result.type;
			threadRendererHost = { render: result.type };
			unpatchThreadRenderer = patcher.after(threadRendererHost, 'render', ({ args, result }) => {
				const { channel, muted } = (args[0] ?? {}) as ChannelRowProps;
				if (!channel?.id) return result;
				return insertThreadTypingIndicator(result, channel, Boolean(muted));
			});
		}
		const { React } = metro.common;
		return React.createElement(threadRendererHost!.render, { ...result.props, key: result.key });
	});
	return true;
}

function waitForChannelModules(): void {
	const textReady = patchTextChannel(metro.findByFilePath(TEXT_CHANNEL_PATH, { interop: false }));
	const threadReady = patchThreadChannel(
		metro.findByFilePath(THREAD_CHANNEL_PATH, { interop: false }),
	);
	if (textReady && threadReady) return;
	removeModuleListener = metro.addListener(() => {
		const textAvailable = patchTextChannel(
			metro.findByFilePath(TEXT_CHANNEL_PATH, { interop: false }),
		);
		const threadAvailable = patchThreadChannel(
			metro.findByFilePath(THREAD_CHANNEL_PATH, { interop: false }),
		);
		if (!textAvailable || !threadAvailable) return;
		removeModuleListener?.();
		removeModuleListener = null;
	});
}

function ChannelTypingSettings() {
	const settings = STORE.useSettingsStore();
	const indicatorMode = settings.get('indicatorMode', DOTS | AVATARS);
	return (
		<SettingsScrollView>
			<SettingsSection title='Channel typing indicators'>
				<SettingsSwitchRow
					label='Include current channel'
					description='Show typing activity in the selected channel.'
					value={settings.get('includeCurrentChannel', true)}
					onValueChange={(value: boolean) => settings.set('includeCurrentChannel', value)}
				/>
				<SettingsSwitchRow
					label='Include muted channels'
					description='Show typing activity in muted channels.'
					value={settings.get('includeMutedChannels', false)}
					onValueChange={(value: boolean) => settings.set('includeMutedChannels', value)}
				/>
				<SettingsSwitchRow
					label='Include ignored users'
					description='Show typing activity from ignored users.'
					value={settings.get('includeIgnoredUsers', false)}
					onValueChange={(value: boolean) => settings.set('includeIgnoredUsers', value)}
				/>
				<SettingsSwitchRow
					label='Include blocked users'
					description='Show typing activity from blocked users.'
					value={settings.get('includeBlockedUsers', false)}
					onValueChange={(value: boolean) => settings.set('includeBlockedUsers', value)}
				/>
			</SettingsSection>
			<SettingsSection title='Appearance'>
				<SettingsRow
					label='Avatars and animated dots'
					trailing={indicatorMode === (DOTS | AVATARS) ? '✓' : undefined}
					onPress={() => settings.set('indicatorMode', DOTS | AVATARS)}
				/>
				<SettingsRow
					label='Animated dots'
					trailing={indicatorMode === DOTS ? '✓' : undefined}
					onPress={() => settings.set('indicatorMode', DOTS)}
				/>
				<SettingsRow
					label='Avatars'
					trailing={indicatorMode === AVATARS ? '✓' : undefined}
					onPress={() => settings.set('indicatorMode', AVATARS)}
				/>
			</SettingsSection>
		</SettingsScrollView>
	);
}

export default {
	start() {
		if (started) return;
		started = true;
		typingStore = metro.findByProps('getTypingUsers') as TypingStore | null;
		userStore = metro.findByProps('getCurrentUser', 'getUser') as UserStore | null;
		relationshipStore = metro.findByProps('isBlocked') as RelationshipStore | null;
		selectedChannelStore = metro.findByProps('getChannelId') as SelectedChannelStore | null;
		guildSettingsStore = metro.findByProps('isChannelMuted') as GuildSettingsStore | null;
		memberStore = metro.findByProps('getNick') as MemberStore | null;
		avatarComponents = metro.findByProps(
			'SummarizedIconRow',
			'Avatar',
			'AvatarSizes',
		) as AvatarComponents | null;
		const theme = (metro.common as any).Theme as ThemeModule;
		themeStore = metro.find((module) => {
			const appearance = module?.theme;
			return typeof appearance === 'string' && Object.values(theme.themes).includes(appearance);
		}) as ThemeStore | null;
		if (!typingStore?.getTypingUsers || !userStore?.getUser) return;
		waitForChannelModules();
	},
	stop() {
		started = false;
		for (const dispose of [...activeIndicators]) dispose();
		unpatchText?.();
		unpatchText = null;
		unpatchThread?.();
		unpatchThread = null;
		unpatchThreadRenderer?.();
		unpatchThreadRenderer = null;
		threadRenderer = null;
		threadRendererHost = null;
		removeModuleListener?.();
		removeModuleListener = null;
		typingStore = null;
		userStore = null;
		relationshipStore = null;
		selectedChannelStore = null;
		guildSettingsStore = null;
		memberStore = null;
		avatarComponents = null;
		themeStore = null;
	},
	getSettingsPanel: () => <ChannelTypingSettings />,
};
