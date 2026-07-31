import { metro, patcher } from '@unbound-app/api';

const AVATAR_GUTTER = 32;
const AVATAR_GAP = 4;
const AVATAR_HEIGHT = 16;
const AVATAR_LIFT = 3;
const AVATAR_OVERLAP = -6;
const MAX_AVATARS = 3;

let components: any = null;
let users: { getUser?: (id: string) => User | undefined } | null = null;
let unpatch: (() => void) | null = null;

type Channel = {
	guild_id?: string;
	id: string;
};

type User = {
	id: string;
};

type TypingItem = {
	channel?: Channel;
	typingUserIds?: string[];
	wrapperStyle?: unknown;
};

function collapseGutter(item: TypingItem): void {
	if (!Array.isArray(item.wrapperStyle)) return;

	item.wrapperStyle = item.wrapperStyle.map((style: any) =>
		style?.paddingLeft != null ? { ...style, paddingLeft: 0 } : style,
	);
}

function TypingAvatars({ item, typingUsers }: { item: TypingItem; typingUsers: User[] }) {
	return (
		<components.SummarizedIconRow
			items={typingUsers}
			max={MAX_AVATARS}
			offsetAmount={AVATAR_OVERLAP}
			style={{ height: AVATAR_HEIGHT, marginRight: AVATAR_GAP, paddingBottom: AVATAR_LIFT }}
			renderItem={(user: User) => (
				<components.Avatar
					user={user}
					size={components.AvatarSizes.SIZE_16}
					guildId={item.channel?.guild_id}
				/>
			)}
		/>
	);
}

function start(): void {
	components = metro.findByProps('SummarizedIconRow', 'Avatar', 'AvatarSizes');
	users = metro.findByProps('getCurrentUser', 'getUser');

	if (!components?.SummarizedIconRow || !components?.Avatar || !users?.getUser) return;

	const target = metro.findByProps('TypingIndicator') as { TypingIndicator?: unknown } | null;
	if (typeof target?.TypingIndicator !== 'function') return;

	unpatch = patcher.after(target, 'TypingIndicator', ({ result }) => {
		const renderItem = result?.props?.renderItem;
		const item = result?.props?.item as TypingItem | undefined;
		const ids = item?.typingUserIds;
		if (typeof renderItem !== 'function' || !item || !ids?.length) return result;

		const { React, ReactNative } = metro.common;
		collapseGutter(item);

		return React.cloneElement(result, {
			renderItem: (...args: unknown[]) => {
				const inner = renderItem(...args);
				const typingUsers = ids
					.map((id) => users?.getUser?.(id))
					.filter((user): user is User => Boolean(user));

				if (!typingUsers.length) return inner;

				return (
					<ReactNative.View
						style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: AVATAR_GUTTER }}
					>
						<TypingAvatars item={item} typingUsers={typingUsers} />
						<ReactNative.View style={{ flex: 1 }}>{inner}</ReactNative.View>
					</ReactNative.View>
				);
			},
		});
	});
}

export default {
	start,
	stop() {
		unpatch?.();
		unpatch = null;
		components = null;
		users = null;
	},
};
