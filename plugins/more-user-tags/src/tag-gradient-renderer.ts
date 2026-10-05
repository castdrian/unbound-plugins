import {
	getRoleGradientKey,
	parseNativeColorDescription,
	type RoleColorAppearance,
	type RoleColorStyle,
} from '@shared/role-colors';
import type {
	NativeAssociationKey,
	NativeClassHandle,
	NativeObjectHandle,
	PluginContext,
} from '@unbound-app/api/native';

type NativeObjC = PluginContext['native']['objc'];

interface TagGradientRecord {
	id: string;
	label: NativeObjectHandle;
	layer: NativeObjectHandle;
	frameSignature: string;
	cornerRadius: number | null;
	sheenFrameSignature: string;
	sheenCornerRadius: number | null;
	originalBackground: NativeObjectHandle | null;
	originalOpaque: boolean;
	labelName: string;
	primaryColor: string;
	colors: string[];
	style: RoleColorStyle;
	sheenLayer: NativeObjectHandle | null;
}

interface TagGradientRenderer {
	setAppearance(labels: string[], appearance: RoleColorAppearance): void;
	stop(): void;
}

interface NativeRectFields {
	origin: { x: number; y: number };
	size: { width: number; height: number };
}

function rectSignature(rect: unknown): string | null {
	const value = (rect as { value?: NativeRectFields } | null)?.value;
	if (!value) return null;
	const coordinates = [value.origin.x, value.origin.y, value.size.width, value.size.height];
	return coordinates.every(Number.isFinite) ? coordinates.join(':') : null;
}

function invoke(
	objc: NativeObjC,
	target: NativeObjectHandle,
	selector: string,
	args: unknown[] = [],
): unknown {
	return objc.invoke(target, selector, args, { thread: 'main' });
}

function gradientColorObject(
	objc: NativeObjC,
	arrayClass: NativeClassHandle,
	uiColorClass: NativeObjectHandle,
	color: string,
	alpha: number = 1,
): NativeObjectHandle | null {
	if (!/^#[\da-f]{6}$/i.test(color)) return null;
	const value = Number.parseInt(color.slice(1), 16);
	const red = ((value >> 16) & 0xff) / 255;
	const green = ((value >> 8) & 0xff) / 255;
	const blue = (value & 0xff) / 255;

	try {
		const uiColor = invoke(objc, uiColorClass, 'colorWithRed:green:blue:alpha:', [
			red,
			green,
			blue,
			alpha,
		]) as NativeObjectHandle | null;
		if (!uiColor) return null;
		const pointer = invoke(objc, uiColor, 'CGColor');
		if (!pointer) return null;
		const colors = invoke(objc, arrayClass, 'arrayWithObject:', [pointer]);
		if (!Array.isArray(colors)) return null;

		const [nativeColor] = colors;
		return nativeColor && typeof nativeColor === 'object'
			? (nativeColor as NativeObjectHandle)
			: null;
	} catch {
		return null;
	}
}

function keyForLabel(label: string, color: string): string {
	return getRoleGradientKey(label, color);
}

function appearanceForLabel(
	appearances: Map<string, RoleColorAppearance>,
	label: string,
	primaryColor: string | null,
): { primaryColor: string; appearance: RoleColorAppearance } | null {
	if (primaryColor) {
		const appearance = appearances.get(keyForLabel(label, primaryColor));
		if (appearance) return { primaryColor, appearance };
	}

	const prefix = `${label.trim().toLowerCase()}:`;
	const unique = new Map<string, { primaryColor: string; appearance: RoleColorAppearance }>();

	for (const [key, appearance] of appearances) {
		if (!key.startsWith(prefix)) continue;
		unique.set(JSON.stringify(appearance), {
			primaryColor: key.slice(prefix.length),
			appearance,
		});
	}

	if (unique.size !== 1) return null;
	return unique.values().next().value ?? null;
}

function viewIdentifier(objc: NativeObjC, view: NativeObjectHandle): string {
	return String(invoke(objc, view, 'hash'));
}

function nativeChildren(objc: NativeObjC, view: NativeObjectHandle): NativeObjectHandle[] {
	const children = invoke(objc, view, 'subviews');
	if (Array.isArray(children)) return children as NativeObjectHandle[];
	if (!children || typeof children !== 'object') return [];

	try {
		return objc.array(children as NativeObjectHandle);
	} catch {
		return [];
	}
}

function attempt(operation: () => unknown): boolean {
	try {
		operation();
		return true;
	} catch {
		return false;
	}
}

export function createTagGradientRenderer(context: PluginContext): TagGradientRenderer | null {
	const objc = context.native.objc;
	const tagViewClass = objc.getClass('DiscordChat.MessageTagView');
	const labelClass = objc.getClass('DCDLabel');
	const gradientLayerClass = objc.getClass('CAGradientLayer');
	const arrayClass = objc.getClass('NSArray');
	const basicAnimationClass = objc.getClass('CABasicAnimation');
	const timingFunctionClass = objc.getClass('CAMediaTimingFunction');
	const accessibilityClass = objc.getClass('UIAccessibility');
	const uiColorClass = objc.getClass('UIColor');

	if (!tagViewClass || !labelClass || !gradientLayerClass || !arrayClass || !uiColorClass) {
		return null;
	}
	const resolvedTagViewClass: NativeObjectHandle = tagViewClass;
	const resolvedGradientLayerClass: NativeObjectHandle = gradientLayerClass;
	const resolvedArrayClass: NativeClassHandle = arrayClass;
	const resolvedBasicAnimationClass: NativeObjectHandle | null = basicAnimationClass;
	const resolvedTimingFunctionClass: NativeObjectHandle | null = timingFunctionClass;
	const resolvedAccessibilityClass: NativeObjectHandle | null = accessibilityClass;
	const resolvedUIColorClass: NativeObjectHandle = uiColorClass;
	const clearColor = (() => {
		try {
			return invoke(objc, resolvedUIColorClass, 'clearColor') as NativeObjectHandle | null;
		} catch {
			return null;
		}
	})();
	if (!clearColor) return null;
	if (!invoke(objc, resolvedTagViewClass, 'instancesRespondToSelector:', ['layoutSubviews']))
		return null;

	const associationKey: NativeAssociationKey = objc.createAssociationKey();
	const appearances = new Map<string, RoleColorAppearance>();
	const records = new Map<string, TagGradientRecord>();
	const updating = new Set<string>();
	const pendingUpdates = new Map<
		string,
		{ label: NativeObjectHandle; timer: ReturnType<typeof setTimeout> }
	>();
	const hookTokens: ReturnType<NativeObjC['hook']>[] = [];
	let stopped = false;
	const reduceMotion = (() => {
		if (!resolvedAccessibilityClass) return false;
		try {
			return Boolean(invoke(objc, resolvedAccessibilityClass, 'isReduceMotionEnabled'));
		} catch {
			return false;
		}
	})();

	function isTransparent(color: NativeObjectHandle | null): boolean {
		if (!color) return false;
		if (Boolean(invoke(objc, color, 'isEqual:', [clearColor]))) return true;
		const description = invoke(objc, color, 'description');
		return typeof description === 'string' && parseNativeColorDescription(description)?.alpha === 0;
	}

	function removeRecord(record: TagGradientRecord, restoreBackground: boolean): void {
		const wasUpdating = updating.has(record.id);
		updating.add(record.id);

		try {
			attempt(() => invoke(objc, record.layer, 'removeFromSuperlayer'));

			if (restoreBackground) {
				const background = (() => {
					try {
						return invoke(objc, record.label, 'backgroundColor') as NativeObjectHandle | null;
					} catch {
						return null;
					}
				})();
				if (isTransparent(background)) {
					attempt(() =>
						invoke(objc, record.label, 'setBackgroundColor:', [record.originalBackground]),
					);
				}

				if (!Boolean(invoke(objc, record.label, 'isOpaque'))) {
					attempt(() => invoke(objc, record.label, 'setOpaque:', [record.originalOpaque]));
				}
			}

			attempt(() => objc.setAssociatedObject(record.label, associationKey, null, 'assign'));
			records.delete(record.id);
		} finally {
			if (!wasUpdating) updating.delete(record.id);
		}
	}

	function updateFrame(record: TagGradientRecord): void {
		const labelLayer = invoke(objc, record.label, 'layer') as NativeObjectHandle;
		const frame = invoke(objc, record.label, 'frame');
		const signature = rectSignature(frame);
		const radius = Number(invoke(objc, labelLayer, 'cornerRadius'));
		if (signature && signature !== record.frameSignature) {
			invoke(objc, record.layer, 'setFrame:', [frame]);
			record.frameSignature = signature;
		}
		if (Number.isFinite(radius) && radius !== record.cornerRadius) {
			invoke(objc, record.layer, 'setCornerRadius:', [radius]);
			record.cornerRadius = radius;
		}

		if (record.sheenLayer) {
			const layerBounds = invoke(objc, record.layer, 'bounds');
			const sheenSignature = rectSignature(layerBounds);
			if (sheenSignature && sheenSignature !== record.sheenFrameSignature) {
				invoke(objc, record.sheenLayer, 'setFrame:', [layerBounds]);
				record.sheenFrameSignature = sheenSignature;
			}
			if (Number.isFinite(radius) && radius !== record.sheenCornerRadius) {
				invoke(objc, record.sheenLayer, 'setCornerRadius:', [radius]);
				record.sheenCornerRadius = radius;
			}
		}
	}

	function createHolographicSheen(parentLayer: NativeObjectHandle): NativeObjectHandle | null {
		if (!resolvedBasicAnimationClass || reduceMotion) return null;

		let sheenLayer: NativeObjectHandle | null = null;
		try {
			sheenLayer = invoke(objc, resolvedGradientLayerClass, 'layer') as NativeObjectHandle | null;
			if (!sheenLayer) return null;

			const sheenColors = [
				gradientColorObject(objc, resolvedArrayClass, resolvedUIColorClass, '#ffffff', 0),
				gradientColorObject(objc, resolvedArrayClass, resolvedUIColorClass, '#ffffff', 0.26),
				gradientColorObject(objc, resolvedArrayClass, resolvedUIColorClass, '#d8f4ff', 0.34),
				gradientColorObject(objc, resolvedArrayClass, resolvedUIColorClass, '#ffffff', 0.26),
				gradientColorObject(objc, resolvedArrayClass, resolvedUIColorClass, '#ffffff', 0),
			];
			if (sheenColors.some((color) => !color)) return null;

			invoke(objc, sheenLayer, 'setColors:', [sheenColors]);
			invoke(objc, sheenLayer, 'setLocations:', [[0, 0.1, 0.2, 0.3, 0.4]]);
			invoke(objc, sheenLayer, 'setStartPoint:', [objc.struct('CGPoint', { x: 0, y: 0 })]);
			invoke(objc, sheenLayer, 'setEndPoint:', [objc.struct('CGPoint', { x: 1, y: 0 })]);
			invoke(objc, sheenLayer, 'setMasksToBounds:', [true]);
			invoke(objc, sheenLayer, 'setZPosition:', [1]);
			invoke(objc, parentLayer, 'addSublayer:', [sheenLayer]);

			const animation = invoke(objc, resolvedBasicAnimationClass, 'animationWithKeyPath:', [
				'locations',
			]) as NativeObjectHandle | null;
			if (!animation) return sheenLayer;

			invoke(objc, animation, 'setFromValue:', [[0, 0.1, 0.2, 0.3, 0.4]]);
			invoke(objc, animation, 'setToValue:', [[0.6, 0.7, 0.8, 0.9, 1]]);
			invoke(objc, animation, 'setDuration:', [3.2]);
			invoke(objc, animation, 'setAutoreverses:', [true]);
			invoke(objc, animation, 'setRepeatCount:', [100000]);
			invoke(objc, animation, 'setRemovedOnCompletion:', [false]);

			if (resolvedTimingFunctionClass) {
				const timingFunction = invoke(objc, resolvedTimingFunctionClass, 'functionWithName:', [
					'easeInEaseOut',
				]) as NativeObjectHandle | null;
				if (timingFunction) invoke(objc, animation, 'setTimingFunction:', [timingFunction]);
			}

			invoke(objc, sheenLayer, 'addAnimation:forKey:', [
				animation,
				'more-user-tags.holographic-sheen',
			]);
			return sheenLayer;
		} catch {
			if (sheenLayer) {
				const failedSheenLayer = sheenLayer;
				attempt(() => invoke(objc, failedSheenLayer, 'removeFromSuperlayer'));
			}
			return null;
		}
	}

	function removeHolographicSheen(record: TagGradientRecord): void {
		const sheenLayer = record.sheenLayer;
		if (!sheenLayer) return;
		attempt(() => invoke(objc, sheenLayer, 'removeFromSuperlayer'));
		record.sheenLayer = null;
		record.sheenFrameSignature = '';
		record.sheenCornerRadius = null;
	}

	function applyAppearance(record: TagGradientRecord, appearance: RoleColorAppearance): boolean {
		const { colors, style } = appearance;
		if (colors.length < 1 || colors.some((color) => !/^#[\da-f]{6}$/i.test(color))) return false;

		try {
			const background = invoke(objc, record.label, 'backgroundColor') as NativeObjectHandle | null;
			if (!isTransparent(background)) {
				if (background) record.originalBackground = background;
				invoke(objc, record.label, 'setBackgroundColor:', [clearColor]);
			}
			if (Boolean(invoke(objc, record.label, 'isOpaque')))
				invoke(objc, record.label, 'setOpaque:', [false]);

			if (record.colors.join(':') !== colors.join(':') || record.style !== style) {
				const renderColors = colors.length === 1 ? [colors[0], colors[0]] : colors;
				const cgColors = renderColors.map((color) =>
					gradientColorObject(objc, resolvedArrayClass, resolvedUIColorClass, color),
				);
				if (cgColors.some((color) => !color)) return false;

				invoke(objc, record.layer, 'setColors:', [cgColors]);
				invoke(objc, record.layer, 'setLocations:', [
					renderColors.map((_, index) => index / (renderColors.length - 1)),
				]);
				invoke(objc, record.layer, 'setStartPoint:', [objc.struct('CGPoint', { x: 0, y: 0 })]);
				invoke(objc, record.layer, 'setEndPoint:', [objc.struct('CGPoint', { x: 1, y: 0 })]);
				invoke(objc, record.layer, 'setMasksToBounds:', [true]);
				invoke(objc, record.layer, 'setNeedsDisplay');

				if (style === 'holographic') {
					record.sheenLayer ??= createHolographicSheen(record.layer);
				} else {
					removeHolographicSheen(record);
				}

				record.colors = [...colors];
			}

			record.style = style;

			updateFrame(record);
			return true;
		} catch {
			return false;
		}
	}

	function createRecord(
		label: NativeObjectHandle,
		labelName: string,
		primaryColor: string,
		appearance: RoleColorAppearance,
	): TagGradientRecord | null {
		let layer: NativeObjectHandle | null = null;
		let originalBackground: NativeObjectHandle | null = null;
		let associated = false;
		const id = viewIdentifier(objc, label);

		try {
			const parent = invoke(objc, label, 'superview') as NativeObjectHandle | null;
			if (!parent) return null;

			const parentLayer = invoke(objc, parent, 'layer') as NativeObjectHandle | null;
			if (!parentLayer) return null;

			layer = invoke(objc, resolvedGradientLayerClass, 'layer') as NativeObjectHandle | null;
			if (!layer) return null;

			originalBackground = invoke(objc, label, 'backgroundColor') as NativeObjectHandle | null;
			const originalOpaque = Boolean(invoke(objc, label, 'isOpaque'));
			const labelLayer = invoke(objc, label, 'layer') as NativeObjectHandle;
			const record: TagGradientRecord = {
				id,
				label,
				layer,
				frameSignature: '',
				cornerRadius: null,
				sheenFrameSignature: '',
				sheenCornerRadius: null,
				originalBackground,
				originalOpaque,
				labelName,
				primaryColor,
				colors: [],
				style: 'solid',
				sheenLayer: null,
			};

			invoke(objc, parentLayer, 'insertSublayer:below:', [layer, labelLayer]);
			objc.setAssociatedObject(label, associationKey, layer, 'retain');
			associated = true;
			invoke(objc, label, 'setBackgroundColor:', [clearColor]);
			invoke(objc, label, 'setOpaque:', [false]);
			records.set(id, record);

			if (!applyAppearance(record, appearance)) {
				removeRecord(record, true);
				return null;
			}

			return record;
		} catch {
			const failedLayer = layer;
			if (failedLayer) attempt(() => invoke(objc, failedLayer, 'removeFromSuperlayer'));
			if (associated)
				attempt(() => objc.setAssociatedObject(label, associationKey, null, 'assign'));
			attempt(() => invoke(objc, label, 'setBackgroundColor:', [originalBackground]));
			return null;
		}
	}

	function labelColors(label: NativeObjectHandle, record?: TagGradientRecord) {
		const text = invoke(objc, label, 'text');
		const accessibilityLabel = invoke(objc, label, 'accessibilityLabel');
		const labelName =
			typeof text === 'string' && text.length > 0
				? text
				: typeof accessibilityLabel === 'string'
					? accessibilityLabel
					: '';
		if (!labelName) return null;

		const background = invoke(objc, label, 'backgroundColor') as NativeObjectHandle | null;
		const description = background ? invoke(objc, background, 'description') : null;
		const color = typeof description === 'string' ? parseNativeColorDescription(description) : null;
		const primaryColor = color && color.alpha > 0 ? color.hex : (record?.primaryColor ?? null);
		const appearance = appearanceForLabel(appearances, labelName, primaryColor);
		return appearance ? { labelName, ...appearance } : null;
	}

	function updateLabel(label: NativeObjectHandle): void {
		if (stopped || appearances.size === 0 || objc.className(label) !== 'DCDLabel') return;

		const id = viewIdentifier(objc, label);
		if (updating.has(id)) return;
		updating.add(id);

		try {
			let record = records.get(id);
			const result = labelColors(label, record);
			if (!result) {
				if (record) removeRecord(record, true);
				return;
			}

			if (
				record &&
				(record.labelName !== result.labelName || record.primaryColor !== result.primaryColor)
			) {
				removeRecord(record, true);
				record = undefined;
			}

			if (!record) {
				createRecord(label, result.labelName, result.primaryColor, result.appearance);
				return;
			}

			if (!applyAppearance(record, result.appearance)) removeRecord(record, true);
		} catch {
			return;
		} finally {
			updating.delete(id);
		}
	}

	function scheduleLabelUpdate(label: NativeObjectHandle): void {
		if (stopped || appearances.size === 0 || objc.className(label) !== 'DCDLabel') return;

		const id = viewIdentifier(objc, label);
		if (pendingUpdates.has(id)) return;

		let retainedLabel: NativeObjectHandle;
		try {
			retainedLabel = invoke(objc, label, 'retain') as NativeObjectHandle;
		} catch {
			return;
		}

		const timer = setTimeout(() => {
			pendingUpdates.delete(id);
			try {
				updateLabel(retainedLabel);
			} finally {
				attempt(() => invoke(objc, retainedLabel, 'release'));
			}
		}, 0);
		pendingUpdates.set(id, { label: retainedLabel, timer });
	}

	function addHook(
		className: string,
		selector: string,
		handler: (target: NativeObjectHandle) => void,
	): boolean {
		try {
			hookTokens.push(
				objc.hook(className, selector, {
					after: ({ self: target }) => handler(target),
				}),
			);
			return true;
		} catch {
			return false;
		}
	}

	const backgroundHookAvailable = addHook('DCDLabel', 'setBackgroundColor:', scheduleLabelUpdate);
	const textHookAvailable = addHook('DCDLabel', 'setText:', scheduleLabelUpdate);
	const tagViewHookAvailable = addHook('DiscordChat.MessageTagView', 'layoutSubviews', (view) => {
		if (stopped || appearances.size === 0) return;

		try {
			for (const label of nativeChildren(objc, view)) {
				if (objc.className(label) === 'DCDLabel') scheduleLabelUpdate(label);
			}
		} catch {
			return;
		}
	});
	if (!backgroundHookAvailable && !textHookAvailable && !tagViewHookAvailable) return null;

	let reuseHook: ReturnType<NativeObjC['hook']> | null = null;
	if (objc.getClass('DCDMessageTableViewCell')) {
		try {
			reuseHook = objc.hook('DCDMessageTableViewCell', 'prepareForReuse', {
				after: ({ self: cell }) => {
					try {
						const queue = [{ view: cell, depth: 0 }];
						while (queue.length > 0) {
							const current = queue.pop();
							if (!current) continue;
							if (objc.className(current.view) === 'DCDLabel') {
								const record = records.get(viewIdentifier(objc, current.view));
								if (record) removeRecord(record, true);
								continue;
							}

							if (current.depth >= 8) continue;
							for (const child of nativeChildren(objc, current.view).slice(0, 20)) {
								queue.push({
									view: child,
									depth: current.depth + 1,
								});
							}
						}
					} catch {
						return;
					}
				},
			});
		} catch {
			reuseHook = null;
		}
	}

	return {
		setAppearance(labels, appearance) {
			if (stopped) return;

			const normalizedColors = appearance.colors
				.filter((color) => /^#[\da-f]{6}$/i.test(color))
				.map((color) => color.toLowerCase());
			const primaryColor = normalizedColors[0];
			const normalizedAppearance = { colors: normalizedColors, style: appearance.style };

			for (const label of labels) {
				if (!label.trim()) continue;

				const key = primaryColor ? keyForLabel(label, primaryColor) : null;
				if (!key) {
					const prefix = `${label.trim().toLowerCase()}:`;
					for (const existingKey of appearances.keys()) {
						if (existingKey.startsWith(prefix)) appearances.delete(existingKey);
					}
					continue;
				}

				if (normalizedColors.length < 1) {
					appearances.delete(key);
					continue;
				}

				appearances.set(key, normalizedAppearance);
			}
		},
		stop() {
			if (stopped) return;
			stopped = true;
			for (const { label, timer } of pendingUpdates.values()) {
				clearTimeout(timer);
				attempt(() => invoke(objc, label, 'release'));
			}
			pendingUpdates.clear();
			for (const hook of hookTokens) hook.remove();
			reuseHook?.remove();
			for (const record of [...records.values()]) removeRecord(record, true);
			appearances.clear();
		},
	};
}
