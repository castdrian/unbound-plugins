import { afterEach, describe, expect, mock, test } from 'bun:test';

const rowGenerator = { generateMessageRowData: () => undefined };
interface TestMessage {
	author?: { bot?: boolean; id?: string };
	id?: unknown;
	nonce?: unknown;
}
interface TestRow {
	timestamp?: string;
	timestampAccessibilityLabel?: string;
	timestampTooltip?: string;
	username?: string;
}
interface TestPatchContext {
	args: Array<{ message?: TestMessage }>;
	result?: { message?: TestRow };
}
interface TestNativeContext {
	native: {
		objc: {
			hook: (
				className: string,
				selector: string,
			) => {
				active: boolean;
				remove: () => number;
			};
		};
	};
}
interface TestHookContext {
	self: object;
}
interface TestHookHandlers {
	before?: (context: TestHookContext) => void;
	after?: (context: TestHookContext) => void;
}
let patchCount = 0;
let unpatchCount = 0;
let removeListenerCount = 0;
let removeHookCount = 0;
let rowGeneratorAvailable = true;
let moduleListener: ((module: unknown, id: string) => void) | null = null;
let afterHandler: ((context: TestPatchContext) => unknown) | null = null;
let subscribedEvents: string[] = [];
let unsubscribedEvents: string[] = [];
let nativeHooks: Array<{ className: string; selector: string }> = [];

mock.module('@unbound-app/api', () => ({
	metro: {
		common: { Theme: { themes: { DARK: 'darker' } } },
		find: () => null,
		findByProps: (...props: string[]) => {
			if (props.includes('generateMessageRowData')) {
				return rowGeneratorAvailable ? rowGenerator : undefined;
			}
			if (props.includes('dispatch') && props.includes('subscribe')) {
				return {
					dispatch: () => undefined,
					subscribe: (event: string) => {
						subscribedEvents.push(event);
					},
					unsubscribe: (event: string) => {
						unsubscribedEvents.push(event);
					},
				};
			}
			if (props.includes('getCurrentUser')) return { getCurrentUser: () => ({ id: 'self' }) };
			return undefined;
		},
		addListener: (listener: (module: unknown, id: string) => void) => {
			moduleListener = listener;
			return () => {
				removeListenerCount++;
				return true;
			};
		},
	},
	patcher: {
		after: (_holder: object, _prop: string, callback: (context: TestPatchContext) => unknown) => {
			patchCount++;
			afterHandler = callback;
			return () => unpatchCount++;
		},
	},
	storage: {
		getStore: () => ({
			get: (_key: string, fallback: unknown) => fallback,
			useSettingsStore: () => ({ get: (_key: string, fallback: unknown) => fallback }),
		}),
	},
}));
mock.module('@shared/settings-ui', () => ({
	SettingsScrollView: () => null,
	SettingsSection: () => null,
	SettingsRow: () => null,
	SettingsSwitchRow: () => null,
}));

const {
	default: plugin,
	formatLatency,
	latencyDetails,
	latencyTooltip,
	messageFromCreateEvent,
	snowflakeTimestamp,
} = await import('@message-latency/index');

const DISCORD_EPOCH = 1_420_070_400_000;

afterEach(() => {
	plugin.stop();
	patchCount = 0;
	unpatchCount = 0;
	removeListenerCount = 0;
	removeHookCount = 0;
	rowGeneratorAvailable = true;
	moduleListener = null;
	afterHandler = null;
	subscribedEvents = [];
	unsubscribedEvents = [];
	nativeHooks = [];
});

function snowflake(timestamp: number): string {
	return (BigInt(timestamp - DISCORD_EPOCH) << 22n).toString();
}

function nativeContext(): TestNativeContext {
	return {
		native: {
			objc: {
				hook: (className: string, selector: string) => {
					nativeHooks.push({ className, selector });
					return { active: true, remove: () => removeHookCount++ };
				},
			},
		},
	};
}

describe('snowflake timestamps', () => {
	test('extracts the millisecond timestamp without relying on BigInt in the runtime', () => {
		const timestamp = DISCORD_EPOCH + 1_700_000_000_000;
		expect(snowflakeTimestamp(snowflake(timestamp))).toBe(timestamp);
	});

	test('rejects malformed and unsafe numeric values', () => {
		expect(snowflakeTimestamp('not-a-snowflake')).toBeNull();
		expect(snowflakeTimestamp(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
	});
});

describe('message latency decisions', () => {
	const defaults = {
		detectDiscordKotlin: true,
		ignoreSelf: false,
		latency: 2,
		showMillis: false,
	};

	test('matches Vencord warning and danger thresholds', () => {
		const warningMessage = {
			author: { id: 'other', bot: false },
			id: snowflake(DISCORD_EPOCH + 20_000),
			nonce: snowflake(DISCORD_EPOCH + 17_500),
		};
		const dangerMessage = {
			...warningMessage,
			nonce: snowflake(DISCORD_EPOCH + 16_000),
		};
		expect(latencyDetails(warningMessage, 'self', defaults)).toEqual({
			ahead: false,
			androidClient: false,
			delta: 3000,
			displayDelta: '3 seconds',
			fill: ['warning', 'warning', 'muted'],
		});
		expect(latencyDetails(dangerMessage, 'self', defaults)?.fill).toEqual([
			'danger',
			'muted',
			'muted',
		]);
	});

	test('uses muted bars for clock-ahead and long delays', () => {
		const aheadMessage = {
			author: { id: 'other', bot: false },
			id: snowflake(DISCORD_EPOCH + 20_000),
			nonce: snowflake(DISCORD_EPOCH + 25_000),
		};
		const longDelayMessage = {
			author: { id: 'other', bot: false },
			id: snowflake(DISCORD_EPOCH + 200_000),
			nonce: snowflake(DISCORD_EPOCH + 1000),
		};
		expect(latencyDetails(aheadMessage, 'self', defaults)?.fill).toEqual([
			'muted',
			'muted',
			'muted',
		]);
		expect(latencyDetails(longDelayMessage, 'self', defaults)?.fill).toEqual([
			'muted',
			'muted',
			'muted',
		]);
	});

	test('ignores missing nonces, bot messages, fast sends, and optional self messages', () => {
		expect(latencyDetails({ id: snowflake(DISCORD_EPOCH + 20_000) }, 'self', defaults)).toBeNull();
		expect(
			latencyDetails(
				{
					author: { bot: true },
					id: snowflake(DISCORD_EPOCH + 20_000),
					nonce: snowflake(DISCORD_EPOCH + 17_000),
				},
				'self',
				defaults,
			),
		).toBeNull();
		expect(
			latencyDetails(
				{
					id: snowflake(DISCORD_EPOCH + 20_000),
					nonce: snowflake(DISCORD_EPOCH + 19_000),
				},
				'self',
				defaults,
			),
		).toBeNull();
		expect(
			latencyDetails(
				{
					author: { id: 'self' },
					id: snowflake(DISCORD_EPOCH + 20_000),
					nonce: snowflake(DISCORD_EPOCH + 17_000),
				},
				'self',
				{ ...defaults, ignoreSelf: true },
			),
		).toBeNull();
	});

	test('detects the old Discord Kotlin nonce offset', () => {
		const message = {
			author: { id: 'other', bot: false },
			id: snowflake(DISCORD_EPOCH + 20_000),
			nonce: snowflake(DISCORD_EPOCH + 20_000 + 1_471_228_928),
		};
		expect(latencyDetails(message, 'self', defaults)).toEqual({
			ahead: true,
			androidClient: true,
			delta: 72,
			displayDelta: null,
			fill: ['positive', 'positive', 'muted'],
		});
		expect(latencyDetails(message, 'self', { ...defaults, detectDiscordKotlin: false })).toBeNull();
	});

	test('builds the Vencord tooltip text for delays, clock offsets, and old clients', () => {
		const delayed = latencyDetails(
			{
				author: { id: 'other', bot: false },
				id: snowflake(DISCORD_EPOCH + 20_000),
				nonce: snowflake(DISCORD_EPOCH + 17_500),
			},
			'self',
			defaults,
		);
		const ahead = latencyDetails(
			{
				author: { id: 'other', bot: false },
				id: snowflake(DISCORD_EPOCH + 20_000),
				nonce: snowflake(DISCORD_EPOCH + 25_000),
			},
			'self',
			defaults,
		);
		const android = latencyDetails(
			{
				author: { id: 'other', bot: false },
				id: snowflake(DISCORD_EPOCH + 20_000),
				nonce: snowflake(DISCORD_EPOCH + 20_000 + 1_471_228_928),
			},
			'self',
			defaults,
		);
		expect(delayed && latencyTooltip(delayed)).toBe(
			'This message was sent with a delay of 3 seconds.',
		);
		expect(ahead && latencyTooltip(ahead)).toBe("This user's clock is 5 seconds ahead.");
		expect(android && latencyTooltip(android)).toBe(
			'User is suspected to be on an old Discord Android client',
		);
	});
});

describe('message create events', () => {
	test('extracts gateway messages and rejects malformed event payloads', () => {
		const message = { id: 'message-id', nonce: 'message-nonce' };

		expect(messageFromCreateEvent({ type: 'MESSAGE_CREATE', message })).toEqual(message);
		expect(messageFromCreateEvent({ type: 'MESSAGE_CREATE', message: null })).toBeNull();
		expect(messageFromCreateEvent({ type: 'MESSAGE_CREATE' })).toBeNull();
	});

	test('subscribes to live messages and releases the subscription on stop', () => {
		plugin.start(nativeContext() as Parameters<typeof plugin.start>[0]);
		expect(subscribedEvents).toContain('MESSAGE_CREATE');

		plugin.stop();
		expect(unsubscribedEvents).toContain('MESSAGE_CREATE');
	});
});

describe('latency formatting', () => {
	test('uses Vencord unit names and separator behavior', () => {
		expect(formatLatency(3000, false)).toBe('3 seconds');
		expect(formatLatency(123_000, false)).toBe('2 minutes and 3 seconds');
		expect(formatLatency(2500, true)).toBe('2 seconds and 500 milliseconds');
		expect(formatLatency(325, true)).toBe('325 milliseconds');
		expect(formatLatency(0, true)).toBe('0 seconds');
	});
});

describe('message row and native lifecycle', () => {
	test('installs one row patch and removes it when stopped', () => {
		plugin.start();
		plugin.start();
		expect(patchCount).toBe(1);

		plugin.stop();
		expect(unpatchCount).toBe(1);
	});

	test('uses the native ABI cell hooks and disposes their tokens', () => {
		plugin.start(nativeContext() as Parameters<typeof plugin.start>[0]);
		expect(nativeHooks).toEqual([
			{ className: 'UIControl', selector: 'endTrackingWithTouch:withEvent:' },
			{ className: 'DCDMessageTableViewCell', selector: 'didMoveToWindow' },
			{ className: 'DCDMessageTableViewCell', selector: 'prepareForReuse' },
		]);

		plugin.stop();
		expect(removeHookCount).toBe(3);
	});

	test('processes cells on window entry and reuse without a per-layout hook', async () => {
		const cell = {};
		const viewModel = {};
		const message = {};
		const window = {};
		const messageId = snowflake(DISCORD_EPOCH + 20_000);
		const calls: string[] = [];
		const handlers = new Map<string, TestHookHandlers>();
		const context = {
			native: {
				objc: {
					className: () => 'DCDMessageTableViewCell',
					getIvar: () => viewModel,
					respondsTo: () => true,
					invoke: (_handle: unknown, selector: string) => {
						calls.push(selector);
						if (selector === 'hash') return 1;
						if (selector === 'window') return window;
						if (selector === 'message') return message;
						if (selector === 'id') return messageId;
						return null;
					},
					hook: (_className: string, selector: string, callback: TestHookHandlers) => {
						handlers.set(selector, callback);
						return { remove: () => undefined };
					},
				},
			},
		};
		plugin.start(context as Parameters<typeof plugin.start>[0]);
		const entered = handlers.get('didMoveToWindow');
		const reuse = handlers.get('prepareForReuse');
		if (!entered?.after || !reuse?.after) throw new Error('Expected asynchronous cell hooks');
		expect(handlers.has('layoutSubviews')).toBe(false);
		expect(reuse.before).toBeUndefined();
		expect(typeof reuse.after).toBe('function');
		entered.after({ self: cell });
		await Bun.sleep(5);
		expect(calls.filter((selector) => selector === 'message')).toHaveLength(2);
		reuse.after({ self: cell });
		await Bun.sleep(5);
		expect(calls.filter((selector) => selector === 'message')).toHaveLength(4);
		const windowCalls = calls.filter((selector) => selector === 'window').length;
		afterHandler?.({
			args: [
				{
					message: {
						author: { id: 'other', bot: false },
						id: messageId,
						nonce: snowflake(DISCORD_EPOCH + 17_000),
					},
				},
			],
			result: { message: { username: 'adrián' } },
		});
		await Bun.sleep(5);
		expect(calls.filter((selector) => selector === 'window').length).toBeGreaterThan(windowCalls);
	});

	test('uses row generation as metadata only without changing Discord row text', () => {
		plugin.start();
		const row = {
			timestamp: '10:00',
			timestampAccessibilityLabel: '10:00 AM',
			timestampTooltip: 'Monday, June 1 at 10:00',
			username: 'adrián',
		};
		const message = {
			author: { id: 'other', bot: false },
			id: snowflake(DISCORD_EPOCH + 20_000),
			nonce: snowflake(DISCORD_EPOCH + 17_500),
		};

		afterHandler?.({ args: [{ message }], result: { message: row } });

		expect(row).toEqual({
			timestamp: '10:00',
			timestampAccessibilityLabel: '10:00 AM',
			timestampTooltip: 'Monday, June 1 at 10:00',
			username: 'adrián',
		});
	});

	test('waits for the message row module and removes its listener', () => {
		rowGeneratorAvailable = false;
		plugin.start();
		expect(patchCount).toBe(0);

		rowGeneratorAvailable = true;
		moduleListener?.(rowGenerator, 'row-generator');

		expect(patchCount).toBe(1);
		expect(removeListenerCount).toBe(1);
	});
});
