import { getRoleColorAppearance, roleColorAt, type RoleColorStops } from '@shared/role-colors';
import type { NativeHookToken, NativeObjCBridge } from '@unbound-app/api/native';
import { metro } from '@unbound-app/api';

type NativeValue = any;

interface Member {
	userId: string;
	nick?: string | null;
	colorString?: string | null;
	colorStrings?: RoleColorStops | null;
}

interface MemberStore {
	getMembers(guildId: string): Member[] | null | undefined;
	getMember(guildId: string, userId: string): Member | null | undefined;
}

interface UserStore {
	getUser(userId: string):
		| {
				discriminator?: string | null;
				globalName?: string | null;
				username?: string;
		  }
		| null
		| undefined;
}

interface TextViewState {
	applied: NativeValue;
	original: NativeValue;
	view: NativeValue;
}

const MAX_SCAN_NODES = 1_600;
const MAX_MEMBERS = 5_000;

export function installComposerMentionColors(
	bridge: NativeObjCBridge,
	members: MemberStore,
	enabled: () => boolean,
): () => void {
	const users = metro.findStore('User') as UserStore | null;
	const channels = metro.findStore('Channel') as {
		getChannel(channelId: string): { guild_id?: string } | null | undefined;
	} | null;
	const selected = metro.findByProps('getChannelId', 'getLastSelectedChannelId') as {
		getChannelId(): string | undefined;
	} | null;
	if (!users || !channels || !selected) return () => {};
	const userStore = users;
	const channelStore = channels;
	const selectedStore = selected;

	const hooks: NativeHookToken[] = [];
	const states = new Map<string, TextViewState>();
	const pending = new Map<string, ReturnType<typeof setTimeout>>();
	const updating = new Set<string>();
	const colors = new Map<string, NativeValue>();
	const aliases = new Map<string, Map<string, string>>();
	let stopped = false;

	function call(handle: NativeValue, selector: string, ...args: NativeValue[]): NativeValue {
		if (!handle) return null;
		try {
			return bridge.invoke(handle, selector, args, { thread: 'main' });
		} catch {
			return null;
		}
	}

	function keyFor(handle: NativeValue): string | null {
		const hash = call(handle, 'hash');
		return hash == null ? null : `${bridge.className(handle)}:${String(hash)}`;
	}

	function aliasesFor(guildId: string): Map<string, string> {
		const cached = aliases.get(guildId);
		if (cached) return cached;
		const result = new Map<string, string>();
		const ambiguous = new Set<string>();
		for (const member of (members.getMembers(guildId) ?? []).slice(0, MAX_MEMBERS)) {
			const user = userStore.getUser(member.userId);
			const names = new Set(
				[
					member.nick,
					user?.globalName,
					user?.username,
					user?.username && user.discriminator && user.discriminator !== '0'
						? `${user.username}#${user.discriminator}`
						: null,
				].filter((value): value is string => typeof value === 'string' && value.length > 0),
			);
			for (const name of names) {
				const token = `@${name}`;
				if (ambiguous.has(token)) continue;
				if (result.has(token) && result.get(token) !== member.userId) {
					result.delete(token);
					ambiguous.add(token);
				} else result.set(token, member.userId);
			}
		}
		aliases.set(guildId, result);
		return result;
	}

	function nativeColor(hex: string): NativeValue {
		const cached = colors.get(hex);
		if (cached) return cached;
		if (!/^#[\da-f]{6}$/i.test(hex)) return null;
		const value = Number.parseInt(hex.slice(1), 16);
		const color = call(
			bridge.getClass('UIColor'),
			'colorWithRed:green:blue:alpha:',
			((value >> 16) & 0xff) / 255,
			((value >> 8) & 0xff) / 255,
			(value & 0xff) / 255,
			1,
		);
		if (colors.size >= 256) colors.clear();
		if (color) colors.set(hex, color);
		return color;
	}

	function colorToken(
		attributed: NativeValue,
		text: string,
		location: number,
		stops: string[],
	): void {
		const characters = stops.length === 1 ? [text] : Array.from(text);
		let position = location;
		for (let index = 0; index < characters.length; index++) {
			const character = characters[index];
			const color = roleColorAt(
				stops,
				characters.length === 1 ? 0 : index / (characters.length - 1),
			);
			const native = color ? nativeColor(color) : null;
			if (native)
				call(
					attributed,
					'addAttribute:value:range:',
					'NSColor',
					native,
					bridge.struct('NSRange', { location: position, length: character.length }),
				);
			position += character.length;
		}
	}

	function update(view: NativeValue): void {
		if (stopped || !enabled()) return;
		const key = keyFor(view);
		if (!key || updating.has(key)) return;
		const channelId = selectedStore.getChannelId();
		const guildId = channelId ? channelStore.getChannel(channelId)?.guild_id : undefined;
		if (!guildId) return;
		const original = call(view, 'attributedText');
		if (!original) return;
		const state = states.get(key);
		if (state && call(original, 'isEqual:', state.applied)) return;
		if (state) states.delete(key);
		const text = call(original, 'string');
		if (typeof text !== 'string' || !text.includes('@')) return;
		let allAliases = aliasesFor(guildId);
		let ordered = [...allAliases.keys()].sort((a, b) => b.length - a.length);
		let refreshed = false;
		const colored = bridge.alloc('NSMutableAttributedString');
		if (!call(colored, 'initWithAttributedString:', original)) return;
		let changed = false;

		for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
			const attributes = call(original, 'attributesAtIndex:effectiveRange:', at, null);
			const font = attributes?.NSFont;
			const fontName = call(font, 'fontName');
			if (typeof fontName !== 'string' || !/bold|semibold/i.test(fontName)) continue;
			function matchingToken(): string | undefined {
				return ordered.find(
					(alias) =>
						text.startsWith(alias, at) &&
						(!text[at + alias.length] || /[\s,.!?;:]/u.test(text[at + alias.length])),
				);
			}
			let token = matchingToken();
			if (!token && !refreshed) {
				aliases.delete(guildId);
				allAliases = aliasesFor(guildId);
				ordered = [...allAliases.keys()].sort((a, b) => b.length - a.length);
				refreshed = true;
				token = matchingToken();
			}
			if (!token) continue;
			const userId = allAliases.get(token);
			const member = userId ? members.getMember(guildId, userId) : null;
			const appearance = getRoleColorAppearance(member?.colorStrings, member?.colorString);
			if (!appearance.colors.length) continue;
			colorToken(colored, token, at, appearance.colors);
			at += token.length - 1;
			changed = true;
		}

		if (!changed) return;
		const selection = call(view, 'selectedRange');
		updating.add(key);
		try {
			call(view, 'setAttributedText:', colored);
			if (selection) call(view, 'setSelectedRange:', selection);
			states.set(key, { applied: colored, original, view });
		} finally {
			updating.delete(key);
		}
	}

	function schedule(view: NativeValue): void {
		if (stopped || !enabled()) return;
		const key = keyFor(view);
		if (!key || pending.has(key)) return;
		const timer = setTimeout(() => {
			pending.delete(key);
			try {
				update(view);
			} catch (error) {
				console.error('Role Color Everywhere composer rendering failed:', error);
			}
		}, 0);
		pending.set(key, timer);
	}

	function scanVisible(): void {
		const application = call(bridge.getClass('UIApplication'), 'sharedApplication');
		const windows = call(application, 'windows');
		if (!windows) return;
		const queue = Array.isArray(windows) ? [...windows] : bridge.array(windows);
		for (let index = 0; index < queue.length && index < MAX_SCAN_NODES; index++) {
			const view = queue[index];
			if (bridge.className(view) === 'DCDChatInputComponentView') schedule(view);
			const children = call(view, 'subviews');
			if (!children) continue;
			try {
				queue.push(...(Array.isArray(children) ? children : bridge.array(children)));
			} catch {
				continue;
			}
		}
	}

	function restore(key: string): void {
		const state = states.get(key);
		if (!state) return;
		const current = call(state.view, 'attributedText');
		if (call(current, 'isEqual:', state.applied)) {
			const selection = call(state.view, 'selectedRange');
			updating.add(key);
			try {
				call(state.view, 'setAttributedText:', state.original);
				if (selection) call(state.view, 'setSelectedRange:', selection);
			} finally {
				updating.delete(key);
			}
		}
		states.delete(key);
	}

	try {
		hooks.push(
			bridge.hook('DCDChatInputComponentView', 'setAttributedText:', {
				after: ({ self }) => schedule(self),
			}),
			bridge.hook('DCDChatInputComponentView', 'setText:', {
				after: ({ self }) => schedule(self),
			}),
			bridge.hook('DCDChatInputComponentView', 'layoutSubviews', {
				after: ({ self }) => schedule(self),
			}),
			bridge.hook('DCDChatInputComponentView', 'didMoveToWindow', {
				after: ({ self }) => {
					if (call(self, 'window')) schedule(self);
				},
			}),
		);
		scanVisible();
	} catch (error) {
		console.error('Role Color Everywhere composer hook failed:', error);
		for (const hook of hooks) hook.remove();
		return () => {};
	}

	return () => {
		stopped = true;
		for (const hook of hooks) hook.remove();
		for (const timer of pending.values()) clearTimeout(timer);
		for (const key of [...states.keys()]) restore(key);
		pending.clear();
		aliases.clear();
		colors.clear();
	};
}
