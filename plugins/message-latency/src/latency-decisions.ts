const ANDROID_NONCE_OFFSET = 1_471_228_928;
const ANDROID_OFFSET_TOLERANCE = 86_400_000;
const DISCORD_EPOCH = 1_420_070_400_000;
const SNOWFLAKE_SHIFT = 4_194_304;

type LatencyColor = 'danger' | 'muted' | 'positive' | 'warning';
type LatencyFill = [LatencyColor, LatencyColor, LatencyColor];

export interface LatencyMessage {
	author?: { bot?: boolean; id?: string; username?: string };
	id?: unknown;
	nonce?: unknown;
}

export interface LatencyOptions {
	detectDiscordKotlin: boolean;
	ignoreSelf: boolean;
	latency: number;
	showMillis: boolean;
}

export interface LatencyDetails {
	ahead: boolean;
	androidClient: boolean;
	delta: number;
	displayDelta: string | null;
	fill: LatencyFill;
}

export interface LatencyDecisionInput {
	currentUserId?: string;
	message: LatencyMessage;
	options: LatencyOptions;
}

export interface LatencyDecision {
	details: LatencyDetails;
	tooltip: string;
}

export function snowflakeTimestamp(value: unknown): number | null {
	if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
	const digits = String(value);
	if (!/^\d+$/.test(digits)) return null;

	let remainder = 0;
	let quotient = '';
	for (const digit of digits) {
		const current = remainder * 10 + Number(digit);
		const next = Math.floor(current / SNOWFLAKE_SHIFT);
		remainder = current % SNOWFLAKE_SHIFT;
		if (quotient || next) quotient += String(next);
	}

	if (!quotient) return null;
	const timestamp = DISCORD_EPOCH + Number(quotient);
	return Number.isSafeInteger(timestamp) ? timestamp : null;
}

export function formatLatency(delta: number, showMillis: boolean): string {
	const values: Array<[number, string]> = [
		[Math.floor(delta / 86_400_000), 'days'],
		[Math.floor((delta / 3_600_000) % 24), 'hours'],
		[Math.floor((delta / 60_000) % 60), 'minutes'],
		[Math.floor((delta / 1000) % 60), 'seconds'],
		[Math.floor(delta % 1000), 'milliseconds'],
	];
	let result = '';

	for (const [value, unit] of values) {
		if (!value) continue;
		const part = `${value} ${value > 1 ? unit : unit.slice(0, -1)}`;
		if (result) {
			const separator = showMillis ? unit === 'milliseconds' : unit === 'seconds';
			result += separator ? ' and ' : ' ';
		}
		result += part;
	}

	return result || '0 seconds';
}

export function latencyDetails(
	message: LatencyMessage,
	currentUserId: string | undefined,
	options: LatencyOptions,
): LatencyDetails | null {
	if (message.nonce == null || message.author?.bot) return null;
	if (options.ignoreSelf && message.author?.id === currentUserId) return null;

	const messageTimestamp = snowflakeTimestamp(message.id);
	const nonceTimestamp = snowflakeTimestamp(message.nonce);
	if (messageTimestamp == null || nonceTimestamp == null) return null;

	let delta = messageTimestamp - nonceTimestamp;
	if (!options.showMillis) delta = Math.round(delta / 1000) * 1000;

	let androidClient = false;
	if (-delta >= ANDROID_NONCE_OFFSET - ANDROID_OFFSET_TOLERANCE) {
		androidClient = options.detectDiscordKotlin;
		delta += ANDROID_NONCE_OFFSET;
	}

	const absoluteDelta = Math.abs(delta);
	const ahead = absoluteDelta !== delta;
	const displayDelta =
		absoluteDelta >= options.latency * 1000
			? formatLatency(absoluteDelta, options.showMillis)
			: null;
	const fill: LatencyFill = androidClient
		? ['positive', 'positive', 'muted']
		: delta >= 120_000 || ahead
			? ['muted', 'muted', 'muted']
			: delta >= options.latency * 2000
				? ['danger', 'muted', 'muted']
				: ['warning', 'warning', 'muted'];

	if (displayDelta === null && !androidClient) return null;
	return { ahead, androidClient, delta: absoluteDelta, displayDelta, fill };
}

export function latencyTooltip(details: LatencyDetails): string {
	if (!details.displayDelta) return 'User is suspected to be on an old Discord Android client';
	const message = details.ahead
		? `This user's clock is ${details.displayDelta} ahead.`
		: `This message was sent with a delay of ${details.displayDelta}.`;
	return details.androidClient
		? `${message} User is suspected to be on an old Discord Android client.`
		: message;
}

export function messageFromCreateEvent(event: Record<string, unknown>): LatencyMessage | null {
	const message = event.message;
	if (!message || typeof message !== 'object') return null;
	return message as LatencyMessage;
}

export function latencyDecision(input: LatencyDecisionInput): LatencyDecision | null {
	const details = latencyDetails(input.message, input.currentUserId, input.options);
	return details ? { details, tooltip: latencyTooltip(details) } : null;
}

export function isLatencyDecision(value: unknown): value is LatencyDecision | null {
	if (value === null) return true;
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	if (typeof record.tooltip !== 'string') return false;
	const details = record.details;
	if (!details || typeof details !== 'object') return false;
	const fields = details as Record<string, unknown>;
	return (
		typeof fields.ahead === 'boolean' &&
		typeof fields.androidClient === 'boolean' &&
		typeof fields.delta === 'number' &&
		(fields.displayDelta === null || typeof fields.displayDelta === 'string') &&
		Array.isArray(fields.fill) &&
		fields.fill.length === 3 &&
		fields.fill.every((color) => ['danger', 'muted', 'positive', 'warning'].includes(color))
	);
}
