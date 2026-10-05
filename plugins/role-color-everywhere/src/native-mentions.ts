import { getRoleColorAppearance, roleColorAt, type RoleColorStops } from '@shared/role-colors';
import { metro } from '@unbound-app/api';
import type { NativeHookToken, NativeObjCBridge } from '@unbound-app/api/native';

type NativeValue = any;

interface Member {
	nick?: string | null;
	colorString?: string | null;
	colorStrings?: RoleColorStops | null;
}

interface Message {
	authorId?: string;
	channelId?: string;
	content?: string;
	guildId?: string;
	id?: string;
}

interface Mention {
	colors: string[];
	labels: string[];
	userId: string;
}

interface TextViewState {
	applied: NativeValue;
	messageId: string;
	original: NativeValue;
	view: NativeValue;
}

interface MemberStore {
	getMember(guildId: string, userId: string): Member | null | undefined;
}

interface MessageStore {
	getMessage(channelId: string, messageId: string): Message | null | undefined;
}

interface ChannelStore {
	getChannel(channelId: string): { guild_id?: string } | null | undefined;
}

interface UserStore {
	getUser(userId: string): { globalName?: string | null; username?: string } | null | undefined;
}

interface SelectedChannelStore {
	addChangeListener?(listener: () => void): void;
	getChannelId(): string | undefined;
	removeChangeListener?(listener: () => void): void;
}

const MAX_SCAN_NODES = 1_600;
const MAX_SCAN_DEPTH = 40;
const MAX_TEXT_VIEWS = 80;

function selectMentionLabel(text: string, labels: string[]): string | undefined {
	const at = text.indexOf('@');
	if (at < 0) return;
	return [...labels]
		.sort((a, b) => b.length - a.length)
		.find((label) => {
			const prefix = `@${label}`;
			if (!text.slice(at).startsWith(prefix)) return false;
			const next = text[at + prefix.length];
			return !next || next === '\u2068' || next === '\u2069' || /\s/u.test(next);
		});
}

function hexChannels(hex: string): [number, number, number] | null {
	if (!/^#[\da-f]{6}$/i.test(hex)) return null;
	return [
		Number.parseInt(hex.slice(1, 3), 16) / 255,
		Number.parseInt(hex.slice(3, 5), 16) / 255,
		Number.parseInt(hex.slice(5, 7), 16) / 255,
	];
}

export function installNativeMentionColors(
	bridge: NativeObjCBridge,
	members: MemberStore,
	enabled: () => boolean,
): () => void {
	const messageStore = metro.findStore('Message') as MessageStore | null;
	const channelStore = metro.findStore('Channel') as ChannelStore | null;
	const userStore = metro.findStore('User') as UserStore | null;
	const selectedStore = metro.findByProps(
		'getChannelId',
		'getLastSelectedChannelId',
	) as SelectedChannelStore | null;
	if (!messageStore || !channelStore || !userStore || !selectedStore) return () => {};
	const messages = messageStore;
	const channels = channelStore;
	const users = userStore;
	const selected = selectedStore;

	const hooks: NativeHookToken[] = [];
	const textViews = new Map<string, TextViewState>();
	const pendingCells = new Set<string>();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const colors = new Map<string, NativeValue>();
	let currentChannelId = selected.getChannelId();
	let stopped = false;

	function call(handle: NativeValue, selector: string, ...args: NativeValue[]): NativeValue {
		if (!handle) return null;
		try {
			return bridge.invoke(handle, selector, args, { thread: 'main' });
		} catch {
			return null;
		}
	}

	function keyFor(handle: NativeValue): string | undefined {
		const name = bridge.className(handle);
		const hash = call(handle, 'hash');
		return name && hash != null ? `${name}:${String(hash)}` : undefined;
	}

	function messageIdForCell(cell: NativeValue): string | undefined {
		const viewModel = bridge.getIvar(cell, 'viewModel');
		const message = call(viewModel, 'message');
		const identifier = call(message, 'id');
		if (typeof identifier === 'string') return identifier;
		const description = call(identifier, 'description');
		return typeof description === 'string' ? description : undefined;
	}

	function mentionsFor(message: Message, guildId: string): Mention[] {
		if (typeof message.content !== 'string') return [];
		const result: Mention[] = [];
		for (const match of message.content.matchAll(/<@!?([0-9]+)>/g)) {
			const userId = match[1];
			const member = members.getMember(guildId, userId);
			const appearance = getRoleColorAppearance(member?.colorStrings, member?.colorString);
			if (!appearance.colors.length) continue;
			const user = users.getUser(userId);
			const labels = [member?.nick, user?.globalName, user?.username].filter(
				(value): value is string => typeof value === 'string' && value.length > 0,
			);
			if (labels.length) result.push({ colors: appearance.colors, labels, userId });
		}
		return result;
	}

	function colorFor(hex: string): NativeValue {
		const cached = colors.get(hex);
		if (cached) return cached;
		const channels = hexChannels(hex);
		if (!channels) return null;
		const color = call(
			bridge.getClass('UIColor'),
			'colorWithRed:green:blue:alpha:',
			...channels,
			1,
		);
		if (colors.size >= 256) colors.clear();
		if (color) colors.set(hex, color);
		return color;
	}

	function colorMention(
		attributed: NativeValue,
		text: string,
		location: number,
		colors: string[],
	): void {
		const characters = colors.length === 1 ? [text] : Array.from(text);
		let position = location;
		for (let index = 0; index < characters.length; index++) {
			const character = characters[index];
			const hex = roleColorAt(
				colors,
				characters.length === 1 ? 0 : index / (characters.length - 1),
			);
			const color = hex ? colorFor(hex) : null;
			if (color)
				call(
					attributed,
					'addAttribute:value:range:',
					'NSColor',
					color,
					bridge.struct('NSRange', { location: position, length: character.length }),
				);
			position += character.length;
		}
	}

	function childViews(root: NativeValue): NativeValue[] {
		const queue = [root];
		const result: NativeValue[] = [];
		for (let index = 0; index < queue.length && index < MAX_TEXT_VIEWS; index++) {
			const view = queue[index];
			if (
				bridge.respondsTo(view, 'attributedText') &&
				bridge.respondsTo(view, 'setAttributedText:')
			) {
				result.push(view);
			}
			const children = call(view, 'subviews');
			if (!children) continue;
			try {
				queue.push(...(Array.isArray(children) ? children : bridge.array(children)));
			} catch {
				continue;
			}
		}
		return result;
	}

	function restoreView(key: string): void {
		const state = textViews.get(key);
		if (!state) return;
		const current = call(state.view, 'attributedText');
		if (call(current, 'isEqual:', state.applied)) {
			call(state.view, 'setAttributedText:', state.original);
		}
		textViews.delete(key);
	}

	function updateView(view: NativeValue, messageId: string, mentions: Mention[]): void {
		const key = keyFor(view);
		if (!key) return;
		const current = call(view, 'attributedText');
		if (!current) return;
		const state = textViews.get(key);
		if (state?.messageId === messageId && call(current, 'isEqual:', state.applied)) return;
		if (state) textViews.delete(key);
		const text = call(current, 'string');
		if (typeof text !== 'string' || !text.includes('@')) return;
		const updated = bridge.alloc('NSMutableAttributedString');
		if (!call(updated, 'initWithAttributedString:', current)) return;
		let offset = 0;
		let changed = false;

		for (const mention of mentions) {
			for (let at = text.indexOf('@', offset); at >= 0; at = text.indexOf('@', at + 1)) {
				const label = selectMentionLabel(text.slice(at), mention.labels);
				if (!label) continue;
				const attributes = call(current, 'attributesAtIndex:effectiveRange:', at, null);
				if (!attributes?.YYTextHighlight) continue;
				const length = label.length + 1;
				colorMention(updated, text.slice(at, at + length), at, mention.colors);
				offset = at + length;
				changed = true;
				break;
			}
		}

		if (!changed) return;
		textViews.set(key, { applied: updated, messageId, original: current, view });
		call(view, 'setAttributedText:', updated);
	}

	function renderCell(cell: NativeValue): void {
		if (stopped || !enabled() || !currentChannelId) return;
		const messageId = messageIdForCell(cell);
		if (!messageId) return;
		const message = messages.getMessage(currentChannelId, messageId);
		if (!message) return;
		const guildId = message.guildId ?? channels.getChannel(currentChannelId)?.guild_id;
		if (!guildId) return;
		const mentions = mentionsFor(message, guildId);
		if (!mentions.length) return;
		for (const view of childViews(cell)) updateView(view, messageId, mentions);
	}

	function scheduleCell(cell: NativeValue): void {
		if (stopped || !enabled()) return;
		const key = keyFor(cell);
		if (!key || pendingCells.has(key)) return;
		pendingCells.add(key);
		const timer = setTimeout(() => {
			timers.delete(timer);
			pendingCells.delete(key);
			if (stopped) return;
			try {
				renderCell(cell);
			} catch (error) {
				console.error('Role Color Everywhere native mention rendering failed:', error);
			}
		}, 0);
		timers.add(timer);
	}

	function forgetCell(cell: NativeValue): void {
		for (const view of childViews(cell)) {
			const viewKey = keyFor(view);
			if (viewKey) textViews.delete(viewKey);
		}
	}

	function scanVisible(): void {
		if (stopped || !enabled()) return;
		const application = call(bridge.getClass('UIApplication'), 'sharedApplication');
		const windows = call(application, 'windows');
		if (!windows) return;
		const roots = Array.isArray(windows) ? windows : bridge.array(windows);
		const queue = roots.map((view) => ({ depth: 0, view }));
		for (let index = 0; index < queue.length && index < MAX_SCAN_NODES; index++) {
			const { depth, view } = queue[index];
			if ((bridge.className(view) ?? '').includes('DCDMessageTableViewCell')) {
				if (call(view, 'window')) scheduleCell(view);
				continue;
			}
			if (depth >= MAX_SCAN_DEPTH) continue;
			const children = call(view, 'subviews');
			if (!children) continue;
			try {
				for (const child of Array.isArray(children) ? children : bridge.array(children)) {
					queue.push({ depth: depth + 1, view: child });
				}
			} catch {
				continue;
			}
		}
	}

	function scheduleScan(delay: number): void {
		const timer = setTimeout(() => {
			timers.delete(timer);
			try {
				scanVisible();
			} catch (error) {
				console.error('Role Color Everywhere visible-cell scan failed:', error);
			}
		}, delay);
		timers.add(timer);
	}

	function onChannelChange(): void {
		const nextChannelId = selected.getChannelId();
		if (!nextChannelId || nextChannelId === currentChannelId) return;
		currentChannelId = nextChannelId;
		pendingCells.clear();
		textViews.clear();
		for (const delay of [0, 100, 500]) scheduleScan(delay);
	}

	hooks.push(
		bridge.hook('DCDMessageTableViewCell', 'didMoveToWindow', {
			after: ({ self }) => {
				if (call(self, 'window')) scheduleCell(self);
				else forgetCell(self);
			},
		}),
		bridge.hook('DCDMessageTableViewCell', 'layoutSubviews', {
			after: ({ self }) => scheduleCell(self),
		}),
		bridge.hook('DCDMessageTableViewCell', 'prepareForReuse', {
			after: ({ self }) => forgetCell(self),
		}),
	);
	selected.addChangeListener?.(onChannelChange);
	for (const delay of [0, 100, 500]) scheduleScan(delay);

	return () => {
		stopped = true;
		selected.removeChangeListener?.(onChannelChange);
		for (const hook of hooks) hook.remove();
		for (const timer of timers) clearTimeout(timer);
		for (const key of [...textViews.keys()]) restoreView(key);
		pendingCells.clear();
		colors.clear();
	};
}
