import { assets, metro, patcher } from '@unbound-app/api';

const RIGHT_ACTIONS_PATH = 'modules/chat_input/native/action_buttons/ChatInputRightActions.tsx';
const CHAT_ITEM_PATH = 'components_native/chat/ChatItem.tsx';
const HAPTICS_PATH = 'modules/haptics/HapticUtils.native.tsx';
const CHANNEL_MESSAGE_DRAFT_TYPE = 0;
const MESSAGE_ROW_TYPE = 1;
const BUTTON_SIZE = 32;
const BUTTON_GAP = 8;
const ICON_SIZE = 22;
const ICON_TINT = '#b5bac1';
const ICON_MIN_SCALE = 0.6;
const PRESS_OPACITY = 0.5;
const PRESS_SCALE = 0.86;
const SHOW_DELAY_MS = 60;
const SHOW_MS = 70;
const HIDE_MS = 25;
const FADE_IN_MS = 160;
const FADE_OUT_MS = 120;
const EMPTY_STICKERS: any[] = [];

let unpatch: (() => void) | null = null;
let drafts: any = null;
let selectedChannel: any = null;
let users: any = null;
let chatItem: any = null;
let messageRecord: any = null;
let rowManager: any = null;
let haptics: any = null;
let eyeIcon: number | null = null;
let stickerPreviews: any = null;

function unwrapComponent(mod: any): { holder: any; prop: string } | null {
	let holder = mod;
	let prop = 'default';
	let current = mod?.default;
	let depth = 0;

	while (current && typeof current === 'object' && depth < 5) {
		const next = current.type !== undefined ? 'type' : current.render !== undefined ? 'render' : null;
		if (!next) break;

		holder = current;
		prop = next;
		current = current[next];
		depth++;
	}

	return typeof current === 'function' ? { holder, prop } : null;
}

function buildRecord(channelId: string, content: string, stickers: any[]) {
	return new messageRecord({
		id: '0',
		type: 0,
		channel_id: channelId,
		content,
		author: users.getCurrentUser(),
		attachments: [],
		embeds: [],
		mentions: [],
		mention_roles: [],
		timestamp: new Date(),
		edited_timestamp: null,
		pinned: false,
		mention_everyone: false,
		tts: false,
		flags: 0,
		components: [],
		reactions: [],
		sticker_items: stickers,
		stickers,
		state: 'SENT',
		nonce: null,
	});
}

function PreviewOverlay({
	channelId,
	content,
	stickers,
	onClose,
}: {
	channelId: string;
	content: string;
	stickers: any[];
	onClose: () => void;
}) {
	const { React, ReactNative } = metro.common;
	const ChatItem = chatItem;
	const opacity = React.useRef(new ReactNative.Animated.Value(0)).current;

	React.useEffect(() => {
		haptics?.triggerHapticFeedback?.(haptics.HapticFeedbackTypes.IMPACT_MEDIUM);

		ReactNative.Animated.timing(opacity, {
			toValue: 1,
			duration: FADE_IN_MS,
			useNativeDriver: true,
		}).start();
	}, [opacity]);

	const dismiss = () => {
		ReactNative.Animated.timing(opacity, {
			toValue: 0,
			duration: FADE_OUT_MS,
			useNativeDriver: true,
		}).start(onClose);
	};

	let body: any;
	try {
		const record = buildRecord(channelId, content, stickers);
		const generator = new rowManager();
		generator.generate({ rowType: MESSAGE_ROW_TYPE, message: record });
		body = <ChatItem rowGenerator={generator} message={record} />;
	} catch (error) {
		body = (
			<ReactNative.Text style={{ color: '#ff7b72', paddingHorizontal: 14 }}>
				{`Preview failed: ${(error as Error)?.message}`}
			</ReactNative.Text>
		);
	}

	return (
		<ReactNative.Animated.View
			style={{
				position: 'absolute',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: 'rgba(0,0,0,0.65)',
				justifyContent: 'center',
				padding: 18,
				opacity,
			}}
		>
			<ReactNative.Pressable
				onPress={dismiss}
				style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
			/>
			<ReactNative.View
				style={{
					backgroundColor: '#2b2d31',
					borderRadius: 14,
					paddingVertical: 12,
					maxHeight: '70%',
				}}
			>
				<ReactNative.Text
					style={{
						color: '#f2f3f5',
						fontWeight: '600',
						paddingHorizontal: 14,
						paddingBottom: 10,
					}}
				>
					Message Preview
				</ReactNative.Text>
				{body}
			</ReactNative.View>
		</ReactNative.Animated.View>
	);
}

function PreviewButton({ channelId }: { channelId: string }) {
	const { React, ReactNative } = metro.common;
	const Portal = (metro.components as any).Portal.Portal;
	const [open, setOpen] = React.useState(false);

	const draft = React.useSyncExternalStore(
		(onChange: () => void) => {
			drafts.addChangeListener(onChange);
			return () => drafts.removeChangeListener(onChange);
		},
		() => drafts.getDraft(channelId, CHANNEL_MESSAGE_DRAFT_TYPE) ?? '',
	);
	const stickers = React.useSyncExternalStore(
		(onChange: () => void) => {
			stickerPreviews?.addChangeListener?.(onChange);
			return () => stickerPreviews?.removeChangeListener?.(onChange);
		},
		() => stickerPreviews?.getStickerPreview?.(channelId, false) ?? EMPTY_STICKERS,
	);

	const visible = Boolean(draft.trim() || stickers.length);
	const progress = React.useRef(new ReactNative.Animated.Value(visible ? 1 : 0)).current;

	React.useEffect(() => {
		ReactNative.Animated.timing(progress, {
			toValue: visible ? 1 : 0,
			duration: visible ? SHOW_MS : HIDE_MS,
			delay: visible ? SHOW_DELAY_MS : 0,
			useNativeDriver: false,
		}).start();
	}, [visible, progress]);

	return (
		<>
			<ReactNative.Animated.View
				style={{
					width: visible ? BUTTON_SIZE : 0,
					marginRight: visible ? 0 : -BUTTON_GAP,
					height: BUTTON_SIZE,
					opacity: progress,
					overflow: 'hidden',
					alignItems: 'center',
					justifyContent: 'center',
				}}
			>
				<ReactNative.Pressable
					onPress={() => setOpen(true)}
					onPressIn={() =>
						haptics?.triggerHapticFeedback?.(haptics.HapticFeedbackTypes.IMPACT_LIGHT)
					}
					hitSlop={8}
					style={({ pressed }: { pressed: boolean }) => ({
						width: BUTTON_SIZE,
						height: BUTTON_SIZE,
						alignItems: 'center',
						justifyContent: 'center',
						opacity: pressed ? PRESS_OPACITY : 1,
						transform: [{ scale: pressed ? PRESS_SCALE : 1 }],
					})}
				>
					<ReactNative.Animated.Image
						source={eyeIcon}
						style={{
							width: ICON_SIZE,
							height: ICON_SIZE,
							tintColor: ICON_TINT,
							transform: [
								{
									scale: progress.interpolate({
										inputRange: [0, 1],
										outputRange: [ICON_MIN_SCALE, 1],
									}),
								},
							],
						}}
					/>
				</ReactNative.Pressable>
			</ReactNative.Animated.View>
			{open ? (
				<Portal>
					<PreviewOverlay
						channelId={channelId}
						content={draft}
						stickers={stickers}
						onClose={() => setOpen(false)}
					/>
				</Portal>
			) : null}
		</>
	);
}

export default {
	start() {
		drafts = metro.findByProps('getDraft');
		stickerPreviews = metro.findByProps('getStickerPreview');
		selectedChannel = metro.findByProps('getLastSelectedChannelId', 'getChannelId');
		users = metro.findByProps('getCurrentUser', 'getUser');
		chatItem = metro.findByFilePath(CHAT_ITEM_PATH)?.default;
		messageRecord = metro.findByName('MessageRecord');
		rowManager = metro.findByName('RowManager');
		haptics = metro.findByFilePath(HAPTICS_PATH);
		eyeIcon = assets.getIDByName('EyeIcon');

		if (!drafts?.getDraft || !stickerPreviews?.getStickerPreview || !users?.getCurrentUser || !chatItem || !messageRecord) return;
		if (!rowManager || !selectedChannel || eyeIcon == null) return;

		const target = unwrapComponent(metro.findByFilePath(RIGHT_ACTIONS_PATH, { interop: false }));
		if (!target) return;

		unpatch = patcher.after(target.holder, target.prop, (ctx) => {
			try {
				const result = ctx.result as any;
				if (!result?.props) return;

				const channelId = (ctx.args[0] as any)?.channel?.id ?? selectedChannel.getChannelId();
				if (!channelId) return;

				const { React } = metro.common;
				const children = React.Children.toArray(result.props.children);
				children.unshift(<PreviewButton key="unbound-preview-message" channelId={channelId} />);

				return React.cloneElement(result, null, ...children);
			} catch { }
		});
	},

	stop() {
		unpatch?.();
		unpatch = null;
		drafts = null;
		selectedChannel = null;
		users = null;
		chatItem = null;
		messageRecord = null;
		rowManager = null;
		haptics = null;
		eyeIcon = null;
		stickerPreviews = null;
	},
};
