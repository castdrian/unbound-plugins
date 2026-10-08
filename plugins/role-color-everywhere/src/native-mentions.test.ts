import { expect, mock, test } from 'bun:test';
import type { NativeObjCBridge } from '@unbound-app/api/native';

type NativeHandle = { className: string; hash: number; text?: string; attributed?: NativeHandle };
type HookContext = { self: NativeHandle };
type HookHandler = (context: HookContext) => void;

const handlers = new Map<string, HookHandler>();
const cell: NativeHandle = { className: 'DCDMessageTableViewCell', hash: 1 };
const label: NativeHandle = { className: 'DCDReusableYYLabel', hash: 2 };
const viewModel: NativeHandle = { className: 'DCDMessageViewModel', hash: 3 };
const message: NativeHandle = { className: 'DCDMessage', hash: 4 };
const window: NativeHandle = { className: 'UIWindow', hash: 5 };
const original: NativeHandle = { className: 'NSAttributedString', hash: 6, text: '@Alice' };
let delayedText: Promise<NativeHandle> | null = null;
let appliedCount = 0;
let onApplied: (() => void) | null = null;
let onRead: (() => void) | null = null;

mock.module('@unbound-app/api', () => ({
	metro: {
		findStore(name: string) {
			if (name === 'Message')
				return { getMessage: () => ({ content: '<@123>', guildId: 'guild', id: 'message' }) };
			if (name === 'Channel') return { getChannel: () => ({ guild_id: 'guild' }) };
			if (name === 'User') return { getUser: () => ({ username: 'Alice' }) };
			return null;
		},
		findByProps: () => ({ getChannelId: () => 'channel' }),
	},
}));

const { installNativeMentionColors } = await import('@role-color-everywhere/native-mentions');

function bridge() {
	return {
		alloc(name: string) {
			return { className: name, hash: 20, text: '' };
		},
		call(target: NativeHandle, selector: string, ...args: unknown[]) {
			if (selector === 'hash') return target.hash;
			if (selector === 'message') return message;
			if (selector === 'id') return 'message';
			if (selector === 'string') return target.text;
			if (selector === 'initWithAttributedString:') {
				target.text = (args[0] as NativeHandle).text;
				return target;
			}
			if (selector === 'attributesAtIndex:effectiveRange:') return { YYTextHighlight: true };
			if (selector === 'isEqual:') return target === args[0];
			return null;
		},
		className: (target: NativeHandle) => target.className,
		getClass: (name: string) => ({ className: name, hash: 30 }),
		getIvar: () => viewModel,
		hook(_name: string, selector: string, hooks: { after: HookHandler }) {
			handlers.set(selector, hooks.after);
			return { remove: () => handlers.delete(selector) };
		},
		async invokeAsync(target: NativeHandle, selector: string, args: unknown[]) {
			if (selector === 'window') return window;
			if (selector === 'attributedText') {
				if (delayedText) onRead?.();
				return delayedText ?? target.attributed;
			}
			if (selector === 'setAttributedText:') {
				target.attributed = args[0] as NativeHandle;
				appliedCount++;
				onApplied?.();
			}
			if (selector === 'colorWithRed:green:blue:alpha:') return { className: 'UIColor', hash: 40 };
			return null;
		},
		respondsTo: (_target: NativeHandle, selector: string) =>
			selector === 'attributedText' || selector === 'setAttributedText:',
		async snapshot() {
			return [{ view: label }];
		},
		struct: () => ({ className: 'NSRange', hash: 50 }),
	};
}

function start() {
	handlers.clear();
	label.attributed = original;
	delayedText = null;
	appliedCount = 0;
	onApplied = null;
	onRead = null;
	const nativeBridge = Object.assign(Object.create(null) as NativeObjCBridge, bridge());
	const stop = installNativeMentionColors(
		nativeBridge,
		{ getMember: () => ({ colorString: '#1abc9c' }) },
		() => true,
	);
	return stop;
}

test('renders a native mention after an asynchronous view read', async () => {
	const stop = start();
	const applied = new Promise<void>((resolve) => {
		onApplied = resolve;
	});
	handlers.get('layoutSubviews')?.({ self: cell });
	await Promise.race([
		applied,
		Bun.sleep(1000).then(() => {
			throw new Error('Native mention was not applied');
		}),
	]);
	expect(appliedCount).toBe(1);
	expect(label.attributed).not.toBe(original);
	stop();
});

test('discards a stale render after the cell is reused', async () => {
	const stop = start();
	const reading = new Promise<void>((resolve) => {
		onRead = resolve;
	});
	let release: ((value: NativeHandle) => void) | undefined;
	delayedText = new Promise((resolve) => {
		release = resolve;
	});
	handlers.get('layoutSubviews')?.({ self: cell });
	await reading;
	handlers.get('prepareForReuse')?.({ self: cell });
	release?.(original);
	await Bun.sleep(0);
	expect(appliedCount).toBe(0);
	stop();
});
