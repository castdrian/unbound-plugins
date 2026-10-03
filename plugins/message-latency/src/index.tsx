import {
	SettingsRow,
	SettingsScrollView,
	SettingsSection,
	SettingsSwitchRow,
} from '@shared/settings-ui';
import { metro, patcher, storage } from '@unbound-app/api';
import type {
	NativeFabricBridge,
	NativeFabricSurface,
	NativeHookToken,
	NativeObjCBridge,
	NativeObjectHandle,
	PluginContext,
} from '@unbound-app/api/native';
import type { ReactNode } from 'react';

const ADDON_ID = 'unbound.message-latency';
const ANDROID_NONCE_OFFSET = 1_471_228_928;
const ANDROID_OFFSET_TOLERANCE = 86_400_000;
const DISCORD_EPOCH = 1_420_070_400_000;
const SNOWFLAKE_SHIFT = 4_194_304;
const LATENCY_OPTIONS = [1, 2, 3, 5, 10];
const LATENCY_ICON_WIDTH = 12;
const LATENCY_ICON_HEIGHT = 12;
const LATENCY_CONTROL_WIDTH = 16;
const LATENCY_CONTROL_HEIGHT = 20;
const LATENCY_ROW_RESERVATION = LATENCY_CONTROL_WIDTH;
const TOOLTIP_MAX_WIDTH = 250;
const TOOLTIP_ARROW_HEIGHT = 8;
const TOOLTIP_ANCHOR_GAP = 3;
const LAYOUT_ATTRIBUTE_CENTER_Y = 10;
const LAYOUT_ATTRIBUTE_HEIGHT = 8;
const LAYOUT_ATTRIBUTE_LEADING = 5;
const LAYOUT_ATTRIBUTE_NOT_AN_ATTRIBUTE = 0;
const LAYOUT_ATTRIBUTE_TRAILING = 6;
const LAYOUT_ATTRIBUTE_WIDTH = 7;
const LAYOUT_RELATION_EQUAL = 0;
const MAX_LATENCY_RECORDS = 500;
const MAX_CELL_NODES = 120;
const MAX_CELL_DEPTH = 12;
const STORE = storage.getStore(ADDON_ID);

type LatencyColor = 'danger' | 'muted' | 'positive' | 'warning';
type LatencyFill = [LatencyColor, LatencyColor, LatencyColor];

interface LatencyMessage {
	author?: { bot?: boolean; id?: string; username?: string };
	id?: unknown;
	nonce?: unknown;
}

interface Dispatcher {
	subscribe?: (event: string, listener: (event: Record<string, unknown>) => void) => void;
	unsubscribe?: (event: string, listener: (event: Record<string, unknown>) => void) => void;
}

interface LatencyOptions {
	detectDiscordKotlin: boolean;
	ignoreSelf: boolean;
	latency: number;
	showMillis: boolean;
}

interface ThemeModule {
	colors: Record<string, unknown>;
	internal: {
		resolveSemanticColor: (theme: string, color: unknown) => string;
	};
	themes: Record<string, string>;
}

interface ThemeStore {
	addChangeListener?: (listener: () => void) => void;
	removeChangeListener?: (listener: () => void) => void;
	theme?: string;
}

interface LatencyDetails {
	ahead: boolean;
	androidClient: boolean;
	delta: number;
	displayDelta: string | null;
	fill: LatencyFill;
}

interface MessageRowData {
	username?: unknown;
}

interface RowPatchContext {
	args: Array<{ message?: LatencyMessage }>;
	result?: { message?: MessageRowData };
}

interface LatencyRecord {
	details: LatencyDetails;
	messageId: string;
	tooltip: string;
	username: string;
}

interface NativeFrame {
	height: number;
	width: number;
	x: number;
	y: number;
}

interface LatencyViewState {
	cellKey: string;
	fillKey: string;
	icon: NativeObjectHandle;
	layout: LatencyLayoutState;
	messageId: string;
	tooltip: string;
	username: string;
}

interface LatencyConstraintState {
	constraint: NativeObjectHandle;
	container: NativeObjectHandle;
}

interface LatencyFrameState {
	frame: NativeFrame;
	translates: boolean;
	view: NativeObjectHandle;
}

interface LatencyViewFrame {
	frame: NativeFrame;
	view: NativeObjectHandle;
}

interface LatencyLayoutState {
	constraints: LatencyConstraintState[];
	views: LatencyFrameState[];
}

interface LatencyTooltipProps {
	arrowDirection: 'UP' | 'DOWN';
	arrowOffset: number;
	label: string;
	width: number;
}

interface TooltipModule {
	Tooltip: (props: Record<string, unknown>) => ReactNode;
	TooltipArrowPositions: { LEFT: string };
}

type LatencyConstraintSpec = readonly [
	NativeObjectHandle,
	number,
	NativeObjectHandle | null,
	number,
	number,
];

let rowUnpatch: (() => void) | null = null;
let users: { getCurrentUser?: () => { id?: string } | null } | null = null;
let themeStore: ThemeStore | null = null;
let objc: NativeObjCBridge | null = null;
let fabric: NativeFabricBridge | null = null;
let started = false;
let activeTooltip: NativeObjectHandle | null = null;
let activeTooltipSurface: NativeFabricSurface | null = null;
let activeTooltipOwnerKey: string | null = null;
let tooltipTimer: ReturnType<typeof setTimeout> | null = null;
let tooltipDismissHook: NativeHookToken | null = null;
let tooltipGeneration = 0;
let tooltipSurfaceModuleName = '';
let removeModuleListener: (() => boolean) | null = null;
let removeMessageCreateListener: (() => void) | null = null;
let removeThemeListener: (() => void) | null = null;
let lifecycle = 0;
let cellHooks: NativeHookToken[] = [];
const latencyRecords = new Map<string, LatencyRecord>();
const activeCells = new Map<string, NativeObjectHandle>();
const activeCellMessageIds = new Map<string, string>();
const cellsByMessageId = new Map<string, NativeObjectHandle>();
const pendingCells = new Set<string>();
const latencyViews = new Map<string, LatencyViewState>();

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

function currentOptions(): LatencyOptions {
	return {
		detectDiscordKotlin: STORE.get('detectDiscordKotlin', true),
		ignoreSelf: STORE.get('ignoreSelf', false),
		latency: STORE.get('latency', 2),
		showMillis: STORE.get('showMillis', false),
	};
}

function nativeCall(handle: NativeObjectHandle, selector: string, ...args: unknown[]): unknown {
	if (!objc) return null;
	try {
		return objc.invoke(handle, selector, args, { thread: 'main' });
	} catch {
		return null;
	}
}

function nativeKey(handle: NativeObjectHandle): string | null {
	try {
		const value = nativeCall(handle, 'hash');
		return value == null ? null : `${objc?.className(handle) ?? 'NSObject'}:${String(value)}`;
	} catch {
		return null;
	}
}

function nativeArray(value: unknown): NativeObjectHandle[] {
	if (Array.isArray(value)) return value as NativeObjectHandle[];
	if (!objc || !value || typeof value !== 'object') return [];
	try {
		return objc.array(value as NativeObjectHandle) as NativeObjectHandle[];
	} catch {
		return [];
	}
}

function frameFromRect(value: unknown): NativeFrame | null {
	const rect = (value as { value?: unknown } | null)?.value ?? value;
	if (!rect || typeof rect !== 'object') return null;
	const origin = (rect as { origin?: Record<string, unknown> }).origin;
	const size = (rect as { size?: Record<string, unknown> }).size;
	if (!origin || !size) return null;
	const x = Number(origin.x);
	const y = Number(origin.y);
	const width = Number(size.width);
	const height = Number(size.height);
	if (![x, y, width, height].every(Number.isFinite)) return null;
	return { height, width, x, y };
}

function nativeFrame(view: NativeObjectHandle): NativeFrame | null {
	return frameFromRect(nativeCall(view, 'frame'));
}

function setNativeFrame(view: NativeObjectHandle, frame: NativeFrame): void {
	if (!objc) return;
	try {
		nativeCall(
			view,
			'setFrame:',
			objc.struct('CGRect', {
				origin: { x: frame.x, y: frame.y },
				size: { width: frame.width, height: frame.height },
			}),
		);
	} catch {
		return;
	}
}

function cellMessageId(cell: NativeObjectHandle): string | null {
	if (!objc) return null;
	try {
		const viewModel = objc.getIvar(cell, 'viewModel') as NativeObjectHandle | null;
		if (!viewModel || !objc.respondsTo(viewModel, 'message')) return null;
		const message = nativeCall(viewModel, 'message') as NativeObjectHandle | null;
		if (!message || !objc.respondsTo(message, 'id')) return null;
		const id = nativeCall(message, 'id');
		return id == null ? null : String(id);
	} catch {
		return null;
	}
}

function labelForUsername(cell: NativeObjectHandle, username: string): NativeObjectHandle | null {
	if (!objc) return null;
	const queue: Array<{ depth: number; view: NativeObjectHandle }> = [{ depth: 0, view: cell }];
	for (let index = 0; index < queue.length && index < MAX_CELL_NODES; index++) {
		const current = queue[index];
		if (!current) continue;
		let isMatchingLabel = false;
		try {
			isMatchingLabel =
				objc.className(current.view) === 'DCDLabel' &&
				nativeCall(current.view, 'text') === username;
		} catch {
			isMatchingLabel = false;
		}
		if (isMatchingLabel) {
			const frame = nativeFrame(current.view);
			if (frame && frame.width > 0 && frame.height > 0) return current.view;
		}
		if (current.depth >= MAX_CELL_DEPTH) continue;
		for (const child of nativeArray(nativeCall(current.view, 'subviews'))) {
			queue.push({ depth: current.depth + 1, view: child });
		}
	}
	return null;
}

function headerForUsername(label: NativeObjectHandle): NativeObjectHandle | null {
	if (!objc) return null;
	const labelFrame = nativeFrame(label);
	if (!labelFrame) return null;
	let current: NativeObjectHandle | null = label;
	for (let depth = 0; current && depth < 8; depth++) {
		current = nativeCall(current, 'superview') as NativeObjectHandle | null;
		if (!current) return null;
		const frame = nativeFrame(current);
		if (
			frame &&
			frame.height <= labelFrame.height + 4 &&
			frame.width >= 120 &&
			frame.width > labelFrame.width * 1.5
		) {
			return current;
		}
	}
	return null;
}

function iconColors(fill: LatencyFill): Array<NativeObjectHandle | null> {
	if (!objc) return [];
	const theme = metro.common.Theme as ThemeModule;
	const appearance = themeStore?.theme ?? theme.themes.DARK;
	const tokens: Record<LatencyColor, string> = {
		danger: 'STATUS_DANGER',
		muted: 'TEXT_MUTED',
		positive: 'STATUS_POSITIVE',
		warning: 'STATUS_WARNING',
	};
	const uiColor = objc.getClass('UIColor');
	if (!uiColor) return [];
	return fill.map((color) => {
		try {
			const hex = theme.internal.resolveSemanticColor(appearance, theme.colors[tokens[color]]);
			const match = /^#([0-9a-f]{6})$/i.exec(hex);
			if (!match?.[1]) return null;
			const value = Number.parseInt(match[1], 16);
			return nativeCall(
				uiColor,
				'colorWithRed:green:blue:alpha:',
				((value >> 16) & 255) / 255,
				((value >> 8) & 255) / 255,
				(value & 255) / 255,
				1,
			) as NativeObjectHandle;
		} catch {
			return null;
		}
	});
}

function createLatencyIcon(record: LatencyRecord): NativeObjectHandle | null {
	if (!objc) return null;
	const view = objc.alloc('UIButton');
	nativeCall(view, 'setUserInteractionEnabled:', true);
	nativeCall(view, 'setExclusiveTouch:', true);
	nativeCall(view, 'setIsAccessibilityElement:', true);
	nativeCall(view, 'setAccessibilityIdentifier:', 'message-latency');
	nativeCall(
		view,
		'setAccessibilityLabel:',
		record.details.displayDelta ?? 'Old Discord Android client',
	);
	nativeCall(view, 'setAccessibilityHint:', record.tooltip);
	const colors = iconColors(record.details.fill);
	if (colors.length !== 3 || colors.some((color) => !color)) return null;
	const bars = [
		{ height: 2.4, width: 2.4, x: 1.2, y: 12.4 },
		{ height: 6, width: 2.4, x: 4.8, y: 8.8 },
		{ height: 9.6, width: 2.4, x: 8.4, y: 5.2 },
	];
	for (let index = 0; index < bars.length; index++) {
		const bar = objc.alloc('UIView');
		const frame = bars[index];
		const color = colors[index];
		if (!frame || !color) continue;
		setNativeFrame(bar, { ...frame, width: frame.width, height: frame.height });
		nativeCall(bar, 'setUserInteractionEnabled:', false);
		nativeCall(bar, 'setBackgroundColor:', color);
		const layer = nativeCall(bar, 'layer') as NativeObjectHandle | null;
		if (layer) nativeCall(layer, 'setCornerRadius:', 0.5);
		nativeCall(view, 'addSubview:', bar);
	}
	return view;
}

function captureLatencyFrame(view: NativeObjectHandle): LatencyFrameState {
	const frame = nativeFrame(view);
	if (!frame) throw new Error('Failed to read message latency layout frame');
	return {
		frame,
		translates: Boolean(nativeCall(view, 'translatesAutoresizingMaskIntoConstraints')),
		view,
	};
}

function removeLatencyConstraints(constraints: LatencyConstraintState[]): void {
	if (!objc) return;
	for (const { constraint, container } of constraints) {
		nativeCall(container, 'removeConstraint:', constraint);
	}
}

function restoreLatencyLayout(layout: LatencyLayoutState): void {
	removeLatencyConstraints(layout.constraints);
	for (const { frame, translates, view } of layout.views) {
		setNativeFrame(view, frame);
		nativeCall(view, 'setTranslatesAutoresizingMaskIntoConstraints:', translates);
	}
}

function addLatencyConstraints(
	container: NativeObjectHandle,
	specs: LatencyConstraintSpec[],
	state: LatencyLayoutState,
): void {
	if (!objc) throw new Error('Native Objective-C bridge is unavailable');
	const constraintClass = objc.getClass('NSLayoutConstraint');
	if (!constraintClass) throw new Error('NSLayoutConstraint is unavailable');
	for (const [firstItem, firstAttribute, secondItem, secondAttribute, constant] of specs) {
		const constraint = objc.invoke(
			constraintClass,
			'constraintWithItem:attribute:relatedBy:toItem:attribute:multiplier:constant:',
			[firstItem, firstAttribute, LAYOUT_RELATION_EQUAL, secondItem, secondAttribute, 1, constant],
			{ thread: 'main' },
		) as NativeObjectHandle | null;
		if (!constraint) throw new Error('Failed to create message latency layout constraint');
		objc.invoke(container, 'addConstraint:', [constraint], { thread: 'main' });
		state.constraints.push({ constraint, container });
	}
}

function installLatencyLayout(
	icon: NativeObjectHandle,
	username: NativeObjectHandle,
	row: NativeObjectHandle,
): LatencyLayoutState {
	if (!objc) throw new Error('Native Objective-C bridge is unavailable');
	const usernameWrapper = nativeCall(username, 'superview') as NativeObjectHandle | null;
	const group = usernameWrapper
		? (nativeCall(usernameWrapper, 'superview') as NativeObjectHandle | null)
		: null;
	const groupRow = group ? (nativeCall(group, 'superview') as NativeObjectHandle | null) : null;
	if (!usernameWrapper || !group || !groupRow || nativeKey(groupRow) !== nativeKey(row)) {
		throw new Error('Message latency username row has an unsupported native layout');
	}
	const groupFrame = nativeFrame(group);
	const rowFrame = nativeFrame(row);
	const usernameFrame = nativeFrame(usernameWrapper);
	if (!groupFrame || !rowFrame || !usernameFrame) {
		throw new Error('Message latency username row has an unsupported native frame');
	}
	const trailingViews = nativeArray(nativeCall(group, 'subviews'))
		.filter((view) => nativeKey(view) !== nativeKey(usernameWrapper))
		.map((view) => ({ frame: nativeFrame(view), view }))
		.filter((entry): entry is LatencyViewFrame =>
			Boolean(
				entry.frame &&
					entry.frame.width > 0 &&
					entry.frame.x >= usernameFrame.x + usernameFrame.width - 0.5,
			),
		)
		.sort((left, right) => left.frame.x - right.frame.x);
	const timestamp = nativeArray(nativeCall(row, 'subviews')).find((view) => {
		const frame = nativeFrame(view);
		return (
			objc?.className(view) === 'DCDLabel' &&
			frame != null &&
			frame.width > 0 &&
			frame.x >= groupFrame.x + groupFrame.width - 0.5
		);
	});
	const timestampFrame = timestamp ? nativeFrame(timestamp) : null;
	if (!timestamp || !timestampFrame) {
		throw new Error('Message latency timestamp row is unavailable');
	}
	const layout: LatencyLayoutState = {
		constraints: [],
		views: [group, usernameWrapper, ...trailingViews.map(({ view }) => view), timestamp].map(
			captureLatencyFrame,
		),
	};
	try {
		for (const { view } of layout.views) {
			nativeCall(view, 'setTranslatesAutoresizingMaskIntoConstraints:', false);
		}
		nativeCall(icon, 'setTranslatesAutoresizingMaskIntoConstraints:', false);
		nativeCall(group, 'addSubview:', icon);
		addLatencyConstraints(
			row,
			[
				[group, LAYOUT_ATTRIBUTE_LEADING, row, LAYOUT_ATTRIBUTE_LEADING, groupFrame.x],
				[group, LAYOUT_ATTRIBUTE_CENTER_Y, row, LAYOUT_ATTRIBUTE_CENTER_Y, 0],
				[
					group,
					LAYOUT_ATTRIBUTE_WIDTH,
					null,
					LAYOUT_ATTRIBUTE_NOT_AN_ATTRIBUTE,
					groupFrame.width + LATENCY_ROW_RESERVATION,
				],
				[
					group,
					LAYOUT_ATTRIBUTE_HEIGHT,
					null,
					LAYOUT_ATTRIBUTE_NOT_AN_ATTRIBUTE,
					groupFrame.height,
				],
				[
					timestamp,
					LAYOUT_ATTRIBUTE_LEADING,
					group,
					LAYOUT_ATTRIBUTE_TRAILING,
					timestampFrame.x - groupFrame.x - groupFrame.width,
				],
				[
					timestamp,
					LAYOUT_ATTRIBUTE_CENTER_Y,
					row,
					LAYOUT_ATTRIBUTE_CENTER_Y,
					timestampFrame.y + timestampFrame.height / 2 - rowFrame.height / 2,
				],
				[
					timestamp,
					LAYOUT_ATTRIBUTE_WIDTH,
					null,
					LAYOUT_ATTRIBUTE_NOT_AN_ATTRIBUTE,
					timestampFrame.width,
				],
				[
					timestamp,
					LAYOUT_ATTRIBUTE_HEIGHT,
					null,
					LAYOUT_ATTRIBUTE_NOT_AN_ATTRIBUTE,
					timestampFrame.height,
				],
			],
			layout,
		);
		const groupCenterOffset = usernameFrame.y + usernameFrame.height / 2 - groupFrame.height / 2;
		addLatencyConstraints(
			group,
			[
				[icon, LAYOUT_ATTRIBUTE_LEADING, group, LAYOUT_ATTRIBUTE_LEADING, usernameFrame.x],
				[icon, LAYOUT_ATTRIBUTE_CENTER_Y, group, LAYOUT_ATTRIBUTE_CENTER_Y, 0],
				[
					icon,
					LAYOUT_ATTRIBUTE_WIDTH,
					null,
					LAYOUT_ATTRIBUTE_NOT_AN_ATTRIBUTE,
					LATENCY_CONTROL_WIDTH,
				],
				[
					icon,
					LAYOUT_ATTRIBUTE_HEIGHT,
					null,
					LAYOUT_ATTRIBUTE_NOT_AN_ATTRIBUTE,
					LATENCY_CONTROL_HEIGHT,
				],
				[usernameWrapper, LAYOUT_ATTRIBUTE_LEADING, icon, LAYOUT_ATTRIBUTE_TRAILING, 0],
				[
					usernameWrapper,
					LAYOUT_ATTRIBUTE_CENTER_Y,
					group,
					LAYOUT_ATTRIBUTE_CENTER_Y,
					groupCenterOffset,
				],
				[
					usernameWrapper,
					LAYOUT_ATTRIBUTE_WIDTH,
					null,
					LAYOUT_ATTRIBUTE_NOT_AN_ATTRIBUTE,
					usernameFrame.width,
				],
				[
					usernameWrapper,
					LAYOUT_ATTRIBUTE_HEIGHT,
					null,
					LAYOUT_ATTRIBUTE_NOT_AN_ATTRIBUTE,
					usernameFrame.height,
				],
			],
			layout,
		);
		let previousView = usernameWrapper;
		let previousFrame = usernameFrame;
		for (const { frame, view } of trailingViews) {
			const spacing = frame.x - previousFrame.x - previousFrame.width;
			addLatencyConstraints(
				group,
				[
					[view, LAYOUT_ATTRIBUTE_LEADING, previousView, LAYOUT_ATTRIBUTE_TRAILING, spacing],
					[
						view,
						LAYOUT_ATTRIBUTE_CENTER_Y,
						group,
						LAYOUT_ATTRIBUTE_CENTER_Y,
						frame.y + frame.height / 2 - groupFrame.height / 2,
					],
					[view, LAYOUT_ATTRIBUTE_WIDTH, null, LAYOUT_ATTRIBUTE_NOT_AN_ATTRIBUTE, frame.width],
					[view, LAYOUT_ATTRIBUTE_HEIGHT, null, LAYOUT_ATTRIBUTE_NOT_AN_ATTRIBUTE, frame.height],
				],
				layout,
			);
			previousView = view;
			previousFrame = frame;
		}
	} catch (error) {
		restoreLatencyLayout(layout);
		nativeCall(icon, 'removeFromSuperview');
		throw error;
	}
	return layout;
}

function fillKey(fill: LatencyFill): string {
	return `${themeStore?.theme ?? 'darker'}:${fill.join(':')}`;
}

function restoreLatencyView(state: LatencyViewState): void {
	if (activeTooltipOwnerKey === state.cellKey) dismissLatencyTooltip();
	restoreLatencyLayout(state.layout);
	if (objc) {
		nativeCall(state.icon, 'removeFromSuperview');
	}
	latencyViews.delete(state.cellKey);
}

function createLatencyView(
	cellKey: string,
	messageId: string,
	record: LatencyRecord,
	username: NativeObjectHandle,
	header: NativeObjectHandle,
): LatencyViewState | null {
	if (!objc) return null;
	const icon = createLatencyIcon(record);
	const iconKey = icon ? nativeKey(icon) : null;
	if (!icon || !iconKey) return null;
	const layout = installLatencyLayout(icon, username, header);
	const state: LatencyViewState = {
		cellKey,
		fillKey: fillKey(record.details.fill),
		icon,
		layout,
		messageId,
		tooltip: record.tooltip,
		username: record.username,
	};
	latencyViews.set(cellKey, state);
	nativeCall(header, 'setNeedsLayout');
	nativeCall(header, 'layoutIfNeeded');
	return state;
}

function updateLatencyView(state: LatencyViewState, record: LatencyRecord): void {
	if (!objc) return;
	if (state.fillKey !== fillKey(record.details.fill)) {
		const colors = iconColors(record.details.fill);
		const bars = nativeArray(nativeCall(state.icon, 'subviews'));
		for (let index = 0; index < bars.length && index < colors.length; index++) {
			const bar = bars[index];
			const color = colors[index];
			if (bar && color) nativeCall(bar, 'setBackgroundColor:', color);
		}
		state.fillKey = fillKey(record.details.fill);
	}
	if (state.tooltip !== record.tooltip) {
		nativeCall(
			state.icon,
			'setAccessibilityLabel:',
			record.details.displayDelta ?? 'Old Discord Android client',
		);
		nativeCall(state.icon, 'setAccessibilityHint:', record.tooltip);
		state.tooltip = record.tooltip;
	}
}

function dismissLatencyTooltip(): void {
	if (tooltipTimer) clearTimeout(tooltipTimer);
	tooltipTimer = null;
	tooltipGeneration++;
	tooltipDismissHook?.remove();
	tooltipDismissHook = null;
	if (activeTooltipSurface && fabric) fabric.unmount(activeTooltipSurface);
	activeTooltipSurface = null;
	if (activeTooltip) nativeCall(activeTooltip, 'removeFromSuperview');
	activeTooltip = null;
	activeTooltipOwnerKey = null;
}

function installTooltipDismissHook(generation: number): void {
	if (!objc || !activeTooltip || tooltipDismissHook || generation !== tooltipGeneration) return;
	try {
		tooltipDismissHook = objc.hook('UIWindow', 'sendEvent:', {
			after: () => {
				if (generation === tooltipGeneration) dismissLatencyTooltip();
			},
		});
	} catch {
		return;
	}
}

function LatencyTooltipSurface({
	arrowDirection,
	arrowOffset,
	label,
	width,
}: LatencyTooltipProps): ReactNode {
	const tooltip = metro.findByProps('TooltipArrowDirections', 'TooltipArrowPositions') as
		| TooltipModule
		| undefined;
	if (!tooltip?.Tooltip) return null;
	const theme = metro.common.Theme as ThemeModule;
	const appearance = themeStore?.theme ?? theme.themes.DARK;
	const background = theme.internal.resolveSemanticColor(
		appearance,
		theme.colors.BACKGROUND_SURFACE_HIGHEST,
	);
	const foreground = theme.internal.resolveSemanticColor(appearance, theme.colors.TEXT_DEFAULT);
	return metro.common.React.createElement(tooltip.Tooltip, {
		arrowDirection,
		arrowOffset,
		arrowPosition: tooltip.TooltipArrowPositions.LEFT,
		arrowStyle: {
			borderBottomColor: background,
			borderTopColor: background,
		},
		containerStyle: { backgroundColor: background },
		label,
		labelStyle: { color: foreground },
		style: { width },
	});
}

function registerTooltipSurface(): boolean {
	if (tooltipSurfaceModuleName) return true;
	const registry = metro.common.ReactNative.AppRegistry;
	if (typeof registry?.registerComponent !== 'function') return false;
	const moduleName = `MessageLatencyTooltipSurface${Date.now()}`;
	try {
		registry.registerComponent(moduleName, () => LatencyTooltipSurface);
		tooltipSurfaceModuleName = moduleName;
		return true;
	} catch {
		return false;
	}
}

function showLatencyTooltip(state: LatencyViewState): void {
	if (!objc || !fabric || !registerTooltipSurface()) return;
	dismissLatencyTooltip();
	const window = nativeCall(state.icon, 'window') as NativeObjectHandle | null;
	const windowFrame = window ? frameFromRect(nativeCall(window, 'bounds')) : null;
	if (!window || !windowFrame) return;
	try {
		const label = objc.alloc('UILabel');
		nativeCall(label, 'setText:', state.tooltip);
		nativeCall(label, 'setNumberOfLines:', 0);
		const fonts = objc.getClass('UIFont');
		if (!fonts) return;
		nativeCall(label, 'setFont:', nativeCall(fonts, 'systemFontOfSize:', 13));
		const maximumWidth = Math.max(120, Math.min(TOOLTIP_MAX_WIDTH, windowFrame.width - 32));
		const measured = objc.invoke(
			label,
			'sizeThatFits:',
			[objc.struct('CGSize', { width: maximumWidth - 20, height: 1000 })],
			{ thread: 'main' },
		) as { value?: unknown } | null;
		const measuredSize = (measured?.value ?? measured) as Record<string, unknown> | null;
		const textWidth = Math.min(maximumWidth - 20, Number(measuredSize?.width));
		const textHeight = Number(measuredSize?.height);
		if (![textWidth, textHeight].every(Number.isFinite) || textWidth <= 0 || textHeight <= 0)
			return;
		const bubbleWidth = textWidth + 28;
		const bubbleHeight = textHeight + 20 + TOOLTIP_ARROW_HEIGHT;
		const iconRect = objc.struct('CGRect', {
			origin: { x: 0, y: 4 },
			size: { width: LATENCY_ICON_WIDTH, height: LATENCY_ICON_HEIGHT },
		});
		const iconFrame = frameFromRect(
			nativeCall(state.icon, 'convertRect:toView:', iconRect, window),
		);
		if (!iconFrame) return;
		const x = Math.max(
			8,
			Math.min(
				iconFrame.x + (iconFrame.width - bubbleWidth) / 2,
				windowFrame.width - bubbleWidth - 8,
			),
		);
		const belowY = iconFrame.y + iconFrame.height + TOOLTIP_ANCHOR_GAP;
		const below = belowY + bubbleHeight <= windowFrame.height - 8;
		const y = below ? belowY : Math.max(8, iconFrame.y - bubbleHeight - TOOLTIP_ANCHOR_GAP);
		const host = objc.alloc('UIView');
		nativeCall(host, 'setUserInteractionEnabled:', false);
		nativeCall(host, 'setAccessibilityIdentifier:', 'message-latency-tooltip');
		setNativeFrame(host, { height: bubbleHeight, width: bubbleWidth, x, y });
		nativeCall(window, 'addSubview:', host);
		activeTooltip = host;
		const surface = fabric.mount(host, tooltipSurfaceModuleName, {
			arrowDirection: below ? 'UP' : 'DOWN',
			arrowOffset: iconFrame.x + iconFrame.width / 2 - x - 8,
			label: state.tooltip,
			width: bubbleWidth,
		});
		fabric.setSize(
			surface,
			{ width: bubbleWidth, height: bubbleHeight },
			{ width: bubbleWidth, height: bubbleHeight },
		);
		fabric.setFrame(surface, { x: 0, y: 0, width: bubbleWidth, height: bubbleHeight });
		activeTooltipSurface = surface;
		activeTooltipOwnerKey = state.cellKey;
		const generation = tooltipGeneration;
		setTimeout(() => installTooltipDismissHook(generation), 0);
		tooltipTimer = setTimeout(() => {
			if (generation !== tooltipGeneration) return;
			dismissLatencyTooltip();
		}, 3000);
	} catch {
		dismissLatencyTooltip();
	}
}

function renderCell(cell: NativeObjectHandle): void {
	if (!objc) return;
	const key = nativeKey(cell);
	const messageId = cellMessageId(cell);
	if (!key || !messageId) return;
	const existing = latencyViews.get(key);
	if (existing && existing.messageId !== messageId) restoreLatencyView(existing);
	const record = latencyRecords.get(messageId);
	if (!record) {
		const current = latencyViews.get(key);
		if (current) restoreLatencyView(current);
		return;
	}
	const current = latencyViews.get(key);
	if (current) {
		updateLatencyView(current, record);
		return;
	}
	try {
		const label = labelForUsername(cell, record.username);
		if (!label) return;
		const header = headerForUsername(label);
		if (!header) return;
		createLatencyView(key, messageId, record, label, header);
	} catch {
		return;
	}
}

function scheduleCell(cell: NativeObjectHandle): void {
	if (!objc) return;
	const key = nativeKey(cell);
	if (!key || pendingCells.has(key)) return;
	pendingCells.add(key);
	const token = lifecycle;
	setTimeout(() => {
		pendingCells.delete(key);
		if (token !== lifecycle || !objc) return;
		if (nativeCall(cell, 'window')) {
			activeCells.set(key, cell);
			const messageId = cellMessageId(cell);
			const previousMessageId = activeCellMessageIds.get(key);
			if (previousMessageId && previousMessageId !== messageId) {
				cellsByMessageId.delete(previousMessageId);
				activeCellMessageIds.delete(key);
			}
			if (messageId) {
				activeCellMessageIds.set(key, messageId);
				cellsByMessageId.set(messageId, cell);
			}
			try {
				renderCell(cell);
			} catch {
				disposeCell(cell);
			}
		}
	}, 0);
}

function disposeCell(cell: NativeObjectHandle): void {
	const key = nativeKey(cell);
	if (!key) return;
	const state = latencyViews.get(key);
	if (state) restoreLatencyView(state);
	activeCells.delete(key);
	const messageId = activeCellMessageIds.get(key);
	if (messageId && cellsByMessageId.get(messageId) === cell) cellsByMessageId.delete(messageId);
	activeCellMessageIds.delete(key);
	pendingCells.delete(key);
}

function installNativeHooks(): void {
	if (!objc || cellHooks.length > 0) return;
	const installed: NativeHookToken[] = [];
	try {
		installed.push(
			objc.hook('UIControl', 'endTrackingWithTouch:withEvent:', {
				after: ({ self }) => {
					const key = nativeKey(self);
					if (!key) return;
					for (const state of latencyViews.values()) {
						if (nativeKey(state.icon) !== key) continue;
						showLatencyTooltip(state);
						return;
					}
				},
			}),
		);
		installed.push(
			objc.hook('DCDMessageTableViewCell', 'didMoveToWindow', {
				after: ({ self }) => {
					if (nativeCall(self, 'window')) {
						scheduleCell(self);
					} else {
						disposeCell(self);
					}
				},
			}),
		);
		installed.push(
			objc.hook('DCDMessageTableViewCell', 'prepareForReuse', {
				after: ({ self }) => {
					disposeCell(self);
					scheduleCell(self);
				},
			}),
		);
		cellHooks = installed;
	} catch {
		for (const hook of installed) hook.remove();
	}
}

function cacheLatency(
	messageRow: MessageRowData | undefined,
	message: LatencyMessage | undefined,
	fallbackUsername: string = '',
): void {
	if (!message || message.id == null) return;
	if (message.nonce == null) return;
	const messageId = String(message.id);
	const details = latencyDetails(message, users?.getCurrentUser?.()?.id, currentOptions());
	if (!details) {
		if (latencyRecords.delete(messageId)) {
			const cell = cellsByMessageId.get(messageId);
			if (cell) scheduleCell(cell);
		}
		return;
	}
	const username =
		(typeof messageRow?.username === 'string' && messageRow.username) ||
		fallbackUsername ||
		message.author?.username ||
		latencyRecords.get(messageId)?.username ||
		'';
	if (!username) return;
	latencyRecords.delete(messageId);
	latencyRecords.set(messageId, {
		details,
		messageId,
		tooltip: latencyTooltip(details),
		username,
	});
	while (latencyRecords.size > MAX_LATENCY_RECORDS) {
		const oldest = latencyRecords.keys().next().value;
		if (!oldest) break;
		latencyRecords.delete(oldest);
	}
	const cell = cellsByMessageId.get(messageId);
	if (cell) scheduleCell(cell);
}

function onMessageCreate(event: Record<string, unknown>): void {
	const message = messageFromCreateEvent(event);
	if (!message) return;
	cacheLatency(undefined, message, message.author?.username);
}

function subscribeToMessageCreate(): void {
	if (removeMessageCreateListener) return;
	const dispatcher = metro.findByProps('dispatch', 'subscribe') as Dispatcher | null;
	if (!dispatcher?.subscribe || !dispatcher.unsubscribe) return;
	dispatcher.subscribe('MESSAGE_CREATE', onMessageCreate);
	removeMessageCreateListener = () => dispatcher.unsubscribe?.('MESSAGE_CREATE', onMessageCreate);
}

function initialize(): boolean {
	if (!started) return false;
	users = metro.findByProps('getCurrentUser');
	subscribeToMessageCreate();
	installNativeHooks();
	if (rowUnpatch) return true;
	const target = metro.findByProps('generateMessageRowData');
	if (typeof target?.generateMessageRowData !== 'function') return false;
	themeStore = metro.find((module) => {
		const theme = module?.theme;
		return (
			typeof theme === 'string' &&
			Object.values((metro.common.Theme as ThemeModule).themes).includes(theme)
		);
	});
	if (!removeThemeListener && themeStore?.addChangeListener && themeStore.removeChangeListener) {
		const onThemeChange = () => {
			for (const state of latencyViews.values()) {
				const record = latencyRecords.get(state.messageId);
				if (record) updateLatencyView(state, record);
			}
		};
		themeStore.addChangeListener(onThemeChange);
		removeThemeListener = () => themeStore?.removeChangeListener?.(onThemeChange);
	}
	rowUnpatch = patcher.after(target, 'generateMessageRowData', (context: RowPatchContext) => {
		try {
			cacheLatency(context.result?.message, context.args[0]?.message);
		} catch {
			return;
		}
	});
	return true;
}

function waitForMessageRows(): void {
	if (initialize()) return;
	removeModuleListener = metro.addListener(() => {
		if (!initialize()) return;
		removeModuleListener?.();
		removeModuleListener = null;
	});
}

function MessageLatencySettings() {
	const state = STORE.useSettingsStore();
	const latency = state.get('latency', 2);
	const thresholdIndex = LATENCY_OPTIONS.indexOf(latency);
	const nextThreshold = LATENCY_OPTIONS[(thresholdIndex + 1) % LATENCY_OPTIONS.length];

	return (
		<SettingsScrollView>
			<SettingsSection title='Indicator'>
				<SettingsRow
					label='Latency threshold'
					description='Show an indicator when a message takes at least this long to send.'
					trailing={`${latency}s`}
					onPress={() => state.set('latency', nextThreshold)}
				/>
				<SettingsSwitchRow
					label='Show milliseconds'
					description='Include millisecond precision in the indicator.'
					value={state.get('showMillis', false)}
					onValueChange={(value: boolean) => state.set('showMillis', value)}
				/>
				<SettingsSwitchRow
					label='Ignore my messages'
					description='Only mark messages sent by other people.'
					value={state.get('ignoreSelf', false)}
					onValueChange={(value: boolean) => state.set('ignoreSelf', value)}
				/>
				<SettingsSwitchRow
					label='Detect legacy Android clients'
					description='Show a marker for the known timestamp offset in older Discord Android clients.'
					value={state.get('detectDiscordKotlin', true)}
					onValueChange={(value: boolean) => state.set('detectDiscordKotlin', value)}
				/>
			</SettingsSection>
		</SettingsScrollView>
	);
}

function cleanup(): void {
	dismissLatencyTooltip();
	for (const state of [...latencyViews.values()]) restoreLatencyView(state);
	for (const hook of cellHooks) hook.remove();
	cellHooks = [];
	for (const cell of activeCells.values()) pendingCells.delete(nativeKey(cell) ?? '');
	activeCells.clear();
	activeCellMessageIds.clear();
	cellsByMessageId.clear();
	pendingCells.clear();
	latencyRecords.clear();
	rowUnpatch?.();
	rowUnpatch = null;
	removeModuleListener?.();
	removeModuleListener = null;
	removeMessageCreateListener?.();
	removeMessageCreateListener = null;
	removeThemeListener?.();
	removeThemeListener = null;
	users = null;
	themeStore = null;
	started = false;
	objc = null;
	fabric = null;
}

export default {
	start(context?: PluginContext) {
		if (started) return;
		started = true;
		lifecycle++;
		objc = context?.native.objc ?? null;
		fabric = context?.native.fabric ?? null;
		waitForMessageRows();
	},
	stop() {
		started = false;
		lifecycle++;
		cleanup();
	},
	getSettingsPanel: () => <MessageLatencySettings />,
};
