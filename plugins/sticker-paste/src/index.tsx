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

function PendingSticker({ channelId, previews, clearSticker, Sticker, keyboardPaddingStyle }: any) {
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
	return React.createElement(ReactNative.Animated.View, { style: [{ position: 'absolute', right: 12, bottom: '100%', zIndex: 10, opacity: progress, transform: [{ translateY: -12 }, { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] }, keyboardPaddingStyle] }, React.createElement(ReactNative.Pressable, { onPress: () => clearSticker(channelId), style: { borderRadius: 10, overflow: 'hidden' } }, React.createElement(Sticker, { sticker, size: 88, animated: true, opaque: true })));
}

function start(): void {
	const registry = metro.findByProps('getBestActiveInputForChannelId');
	const selectedChannel = metro.findByProps('getCurrentlySelectedChannelId');
	const previews = metro.findByProps('getStickerPreview');
	const stickerActions = metro.findByProps('addStickerPreview', 'clearStickerPreview');
	const drafts = metro.findByProps('getDraft');
	const messages = metro.findByProps('sendMessage', 'editMessage');
	const Sticker = metro.findByFilePath(STICKER_PATH, { interop: false })?.default;
	if (!registry || !selectedChannel || !previews || !stickerActions || !drafts || !messages || !Sticker) return;
	const nativeSendHandlers = new Map<string, { input: any; handleSend: () => void }>();
	const updateSendButton = (channelId: string, hasText: boolean) => sendButtonRefs.get(channelId)?.current?.setHasText?.(hasText);
	function restoreNativeSend(channelId: string): void {
		const entry = nativeSendHandlers.get(channelId);
		if (!entry) return;
		entry.input.handleSend = entry.handleSend;
		nativeSendHandlers.delete(channelId);
	}
	const clearSticker = (channelId: string) => {
		stickerActions.clearStickerPreview(channelId, false);
		restoreNativeSend(channelId);
		setTimeout(() => updateSendButton(channelId, Boolean((drafts.getDraft(channelId, 0) ?? '').trim())), 32);
	};
	const activeChannelId = selectedChannel.getCurrentlySelectedChannelId?.() ?? selectedChannel.getChannelId?.();
	if (activeChannelId) clearSticker(activeChannelId);
	const stageSticker = (channelId: string, sticker: any) => {
		const input = registry.getBestActiveInputForChannelId?.(channelId);
		if (input?.handleSend && !nativeSendHandlers.has(channelId)) {
			nativeSendHandlers.set(channelId, { input, handleSend: input.handleSend });
			input.handleSend = () => sendStagedSticker(channelId);
		}
		input?.closeCustomKeyboard?.();
		setTimeout(() => {
			stickerActions.addStickerPreview(channelId, sticker, false);
			updateSendButton(channelId, true);
		}, 0);
	};
	function sendStagedSticker(channelId: string) {
		const stickers = previews.getStickerPreview(channelId, false) ?? EMPTY_STICKERS;
		if (!stickers.length) return;
		const content = drafts.getDraft(channelId, 0) ?? '';
		const result = messages.sendMessage(channelId, { content, tts: false }, true, { stickerIds: stickers.map((sticker: any) => sticker.id), location: 'unbound_sticker_paste' });
		registry.getBestActiveInputForChannelId?.(channelId)?.clearText?.();
		clearSticker(channelId);
		updateSendButton(channelId, false);
		setTimeout(() => {
			const current = previews.getStickerPreview(channelId, false) ?? EMPTY_STICKERS;
			if (current.every((sticker: any) => stickers.some((sent: any) => sent.id === sticker.id))) clearSticker(channelId);
			updateSendButton(channelId, Boolean((drafts.getDraft(channelId, 0) ?? '').trim()));
		}, 32);
		return result;
	}
	const picker = unwrap(metro.findByFilePath(STICKER_PICKER_PATH, { interop: false }));
	if (picker) unpatches.push(patcher.before(picker.holder, picker.prop, (ctx) => {
		const props = ctx.args[0];
		if (!props?.onPressSticker || props.__unboundStickerPaste) return;
		ctx.args[0] = { ...props, __unboundStickerPaste: true, onPressSticker: (sticker: any) => stageSticker(props.channel?.id ?? selectedChannel.getChannelId(), sticker) };
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
	const target = unwrap(metro.findByFilePath(FLOATING_INPUT_PATH, { interop: false }));
	if (!target) return;
	unpatches.push(patcher.after(target.holder, target.prop, (ctx) => {
		const channelId = ctx.args[0]?.channel?.id ?? selectedChannel.getChannelId?.();
		if (!channelId || !ctx.result?.props) return ctx.result;
		const React = metro.common.React;
		const children = React.Children.toArray(ctx.result.props.children);
		const styles = ctx.result.props.style;
		const keyboardPaddingStyle = Array.isArray(styles) ? styles[styles.length - 1] : undefined;
		children.unshift(React.createElement(PendingSticker, { key: 'unbound-sticker-paste', channelId, previews, clearSticker, Sticker, keyboardPaddingStyle }));
		return React.cloneElement(ctx.result, null, ...children);
	}));
}

function stop(): void {
	while (unpatches.length) unpatches.pop()!();
	sendButtonRefs.clear();
	for (const channelId of nativeSendHandlers.keys()) restoreNativeSend(channelId);
}

export default { start, stop };
