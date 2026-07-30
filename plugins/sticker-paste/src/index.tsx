import { metro, patcher } from '@unbound-app/api';

const FLOATING_INPUT_PATH = 'modules/chat_input/native/FloatingChatInputContainer.tsx';
const SEND_BUTTON_PATH = 'modules/chat_input/native/accessories/ChatInputSendButton.tsx';
const STICKER_PICKER_PATH = 'modules/stickers/native/StickerPicker.tsx';
const STICKER_PATH = 'modules/stickers/native/Sticker.tsx';
const EMPTY_STICKERS: any[] = [];
let unpatches: Array<() => void> = [];
const sendButtonRefs = new Map<string, { current?: { setHasText?: (hasText: boolean) => void } }>();

function unwrap(module: any): { holder: any; prop: string } | null {
	let holder = module;
	let prop = 'default';
	let current = module?.default;
	while (current && typeof current === 'object') {
		const next = current.type ? 'type' : current.render ? 'render' : null;
		if (!next) break;
		holder = current;
		prop = next;
		current = current[next];
	}
	return typeof current === 'function' ? { holder, prop } : null;
}

function PendingSticker({ channelId, previews, clearSticker, Sticker }: any) {
	const React = metro.common.React;
	const ReactNative = metro.common.ReactNative;
	const stickers = React.useSyncExternalStore((notify: () => void) => {
		previews.addChangeListener(notify);
		return () => previews.removeChangeListener(notify);
	}, () => previews.getStickerPreview(channelId, false) ?? EMPTY_STICKERS);
	const sticker = stickers[0];
	const progress = React.useRef(new ReactNative.Animated.Value(sticker ? 1 : 0)).current;
	React.useEffect(() => {
		ReactNative.Animated.timing(progress, { toValue: sticker ? 1 : 0, duration: sticker ? 160 : 120, useNativeDriver: true }).start();
	}, [sticker, progress]);
	if (!sticker) return null;
	return React.createElement(ReactNative.Animated.View, { style: { position: 'absolute', right: 12, bottom: '100%', zIndex: 10, opacity: progress, transform: [{ translateY: -12 }, { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] } }, React.createElement(ReactNative.Pressable, { onPress: () => clearSticker(channelId), style: { borderRadius: 10, overflow: 'hidden' } }, React.createElement(Sticker, { sticker, size: 88, animated: true, opaque: true })));
}

function start(): void {
	const registry = metro.findByProps('getBestActiveInputForChannelId');
	const selectedChannel = metro.findByProps('getCurrentlySelectedChannelId');
	const previews = metro.findByProps('getStickerPreview');
	const stickerActions = metro.findByProps('addStickerPreview', 'clearStickerPreview');
	const stickerStore = metro.findByProps('getStickerById');
	const drafts = metro.findByProps('getDraft');
	const stickerMessages = metro.findByProps('sendStickers', 'sendMessage');
	const messages = metro.findByProps('sendMessage', 'editMessage');
	const Sticker = metro.findByFilePath(STICKER_PATH, { interop: false })?.default;
	if (!registry || !selectedChannel || !previews || !stickerActions || !stickerStore || !drafts || !stickerMessages || !messages || !Sticker) return;
	const updateSendButton = (channelId: string, hasText: boolean) => sendButtonRefs.get(channelId)?.current?.setHasText?.(hasText);
	const clearSticker = (channelId: string) => {
		stickerActions.clearStickerPreview(channelId, false);
		updateSendButton(channelId, Boolean((drafts.getDraft(channelId, 0) ?? '').trim()));
	};
	const activeChannelId = selectedChannel.getCurrentlySelectedChannelId?.() ?? selectedChannel.getChannelId?.();
	if (activeChannelId) clearSticker(activeChannelId);
	const stageSticker = (channelId: string, sticker: any) => {
		const input = registry.getBestActiveInputForChannelId?.(channelId);
		input?.closeCustomKeyboard?.();
		setTimeout(() => {
			stickerActions.addStickerPreview(channelId, sticker, false);
			updateSendButton(channelId, true);
		}, 0);
	};
	const sendStagedSticker = (channelId: string) => {
		const stickers = previews.getStickerPreview(channelId, false) ?? EMPTY_STICKERS;
		if (!stickers.length) return;
		const content = drafts.getDraft(channelId, 0) ?? '';
		clearSticker(channelId);
		const result = messages.sendMessage(channelId, { content, tts: false }, true, { stickerIds: stickers.map((sticker: any) => sticker.id), location: 'unbound_sticker_paste' });
		registry.getBestActiveInputForChannelId?.(channelId)?.clearText?.();
		updateSendButton(channelId, false);
		return result;
	};
	const picker = unwrap(metro.findByFilePath(STICKER_PICKER_PATH, { interop: false }));
	if (picker) unpatches.push(patcher.before(picker.holder, picker.prop, (ctx) => {
		const props = ctx.args[0];
		if (!props?.onPressSticker || props.__unboundStickerPaste) return;
		ctx.args[0] = { ...props, __unboundStickerPaste: true, onPressSticker: (sticker: any) => stageSticker(props.channel?.id ?? selectedChannel.getChannelId(), sticker) };
	}));
	unpatches.push(patcher.instead(stickerMessages, 'sendStickers', (ctx) => {
		const [channelId, ids, , metadata] = ctx.args as [string, string[], unknown, { location?: string }];
		if (metadata?.location === 'unbound_sticker_paste') return ctx.original.apply(ctx.this, ctx.args);
		for (const id of ids) {
			const sticker = stickerStore.getStickerById?.(id);
			if (sticker) stageSticker(channelId, sticker);
		}
	}));
	const sendButton = unwrap(metro.findByFilePath(SEND_BUTTON_PATH, { interop: false }));
	if (sendButton) unpatches.push(patcher.after(sendButton.holder, sendButton.prop, (ctx) => {
		const channelId = ctx.args[0]?.channel?.id;
		const ref = ctx.args[1];
		if (channelId && ref) setTimeout(() => {
			sendButtonRefs.set(channelId, ref);
			if (!(previews.getStickerPreview(channelId, false) ?? EMPTY_STICKERS).length) updateSendButton(channelId, Boolean((drafts.getDraft(channelId, 0) ?? '').trim()));
		}, 0);
		return ctx.result;
	}));
	if (sendButton) unpatches.push(patcher.before(sendButton.holder, sendButton.prop, (ctx) => {
		const props = ctx.args[0];
		const channelId = props?.channel?.id;
		if (!(previews.getStickerPreview(channelId, false) ?? EMPTY_STICKERS).length) return;
		ctx.args[0] = { ...props, hasPendingAttachments: true, requireTextContent: false, onSendMessage: () => sendStagedSticker(channelId) };
	}));
	const target = unwrap(metro.findByFilePath(FLOATING_INPUT_PATH, { interop: false }));
	if (!target) return;
	unpatches.push(patcher.after(target.holder, target.prop, (ctx) => {
		const channelId = ctx.args[0]?.channel?.id ?? selectedChannel.getChannelId?.();
		if (!channelId || !ctx.result?.props) return ctx.result;
		const React = metro.common.React;
		const children = React.Children.toArray(ctx.result.props.children);
		children.unshift(React.createElement(PendingSticker, { key: 'unbound-sticker-paste', channelId, previews, clearSticker, Sticker }));
		return React.cloneElement(ctx.result, null, ...children);
	}));
}

function stop(): void {
	while (unpatches.length) unpatches.pop()!();
	sendButtonRefs.clear();
}

export default { start, stop };
