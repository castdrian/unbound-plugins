import { SettingsScrollView, SettingsSection, SettingsSwitchRow } from '@shared/settings-ui';
import { metro, patcher, storage } from '@unbound-app/api';

const ADDON_ID = 'unbound.channel-typing-indicators';
const TEXT_CHANNEL_PATH = 'modules/channel_list_v2/native/items/TextChannel.tsx';
const STORE = storage.getStore(ADDON_ID);
const MAX_AVATARS = 3;

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
let guildSettingsStore: GuildSettingsStore | null = null;
let memberStore: MemberStore | null = null;
let avatarComponents: AvatarComponents | null = null;
let themeStore: ThemeStore | null = null;
let unpatch: (() => void) | null = null;
let removeModuleListener: (() => boolean) | null = null;
let started = false;
const activeIndicators = new Set<() => void>();

export function visibleTypingIds(
	typingUsers: Record<string, number> | null | undefined,
	currentUserId: string | undefined,
	isBlocked: (id: string) => boolean,
	includeBlockedUsers: boolean,
): string[] {
	if (!typingUsers) return [];
	return Object.keys(typingUsers).filter(
		(id) => id !== currentUserId && (includeBlockedUsers || !isBlocked(id)),
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
): string[] {
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
				Animated.parallel([timing(values[0], 1), timing(values[2], 1)]),
				Animated.parallel([timing(values[0], 0.35), timing(values[1], 1), timing(values[2], 0.35)]),
				timing(values[1], 0.35),
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
	const showAvatars = settings.get('showAvatars', true);
	const [typingIds, setTypingIds] = React.useState<string[]>(() =>
		readTypingIds(channel, muted, includeMuted, includeBlocked),
	);

	React.useEffect(() => {
		const currentTypingStore = typingStore;
		const currentRelationshipStore = relationshipStore;
		const currentGuildSettingsStore = guildSettingsStore;
		function refresh(): void {
			const next = readTypingIds(channel, muted, includeMuted, includeBlocked);
			setTypingIds((current) => (sameIds(current, next) ? current : next));
		}
		function remove(): void {
			currentTypingStore?.removeChangeListener(refresh);
			currentRelationshipStore?.removeChangeListener?.(refresh);
			currentGuildSettingsStore?.removeChangeListener?.(refresh);
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
		activeIndicators.add(dispose);
		return remove;
	}, [channel.id, channel.guild_id, muted, includeMuted, includeBlocked]);

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
			{showAvatars && typingUsers.length ? (
				<TypingAvatars users={typingUsers} guildId={channel.guild_id} />
			) : null}
			<TypingDots />
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

function patchTextChannel(module: any): boolean {
	const target = module?.default;
	if (unpatch || typeof target?.type !== 'function') return Boolean(unpatch);
	unpatch = patcher.after(target, 'type', ({ args, result }) => {
		const { channel, muted } = (args[0] ?? {}) as ChannelRowProps;
		if (!channel?.id) return result;
		return insertTypingIndicator(result, channel, Boolean(muted));
	});
	return true;
}

function waitForTextChannel(): void {
	if (patchTextChannel(metro.findByFilePath(TEXT_CHANNEL_PATH, { interop: false }))) return;
	removeModuleListener = metro.addListener(() => {
		if (!patchTextChannel(metro.findByFilePath(TEXT_CHANNEL_PATH, { interop: false }))) return;
		removeModuleListener?.();
		removeModuleListener = null;
	});
}

function ChannelTypingSettings() {
	const settings = STORE.useSettingsStore();
	return (
		<SettingsScrollView>
			<SettingsSection title='Channel typing indicators'>
				<SettingsSwitchRow
					label='Show avatars'
					description='Show the avatars of people typing beside the animated dots.'
					value={settings.get('showAvatars', true)}
					onValueChange={(value: boolean) => settings.set('showAvatars', value)}
				/>
				<SettingsSwitchRow
					label='Include muted channels'
					description='Show typing activity in muted channels.'
					value={settings.get('includeMutedChannels', false)}
					onValueChange={(value: boolean) => settings.set('includeMutedChannels', value)}
				/>
				<SettingsSwitchRow
					label='Include blocked users'
					description='Show typing activity from blocked users.'
					value={settings.get('includeBlockedUsers', false)}
					onValueChange={(value: boolean) => settings.set('includeBlockedUsers', value)}
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
		waitForTextChannel();
	},
	stop() {
		started = false;
		for (const dispose of [...activeIndicators]) dispose();
		unpatch?.();
		unpatch = null;
		removeModuleListener?.();
		removeModuleListener = null;
		typingStore = null;
		userStore = null;
		relationshipStore = null;
		guildSettingsStore = null;
		memberStore = null;
		avatarComponents = null;
		themeStore = null;
	},
	getSettingsPanel: () => <ChannelTypingSettings />,
};
