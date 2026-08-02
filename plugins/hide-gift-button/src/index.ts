import { metro, patcher } from '@unbound-app/api';

const GIFT_BUTTON_PATH = 'modules/chat_input/native/action_buttons/ChatInputActionButtonGiftOrThread.tsx';
const RIGHT_ACTIONS_PATH = 'modules/chat_input/native/action_buttons/ChatInputRightActions.tsx';

let unpatchGiftButton: (() => void) | null = null;
let unpatchRightActions: (() => void) | null = null;
let removeModuleListener: (() => boolean) | null = null;
let giftComponent: any = null;

function unwrapComponent(mod: any): { holder: any; prop: string; component: any } | null {
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

	return typeof current === 'function' ? { holder, prop, component: current } : null;
}

function modulePath(id: string): string | undefined {
	return (globalThis as any).window?.modules?.get(id)?.__filePath;
}

function resolveComponent(value: any): any {
	let current = value;
	let depth = 0;

	while (current && typeof current === 'object' && depth < 5) {
		const next = current.type !== undefined ? 'type' : current.render !== undefined ? 'render' : null;
		if (!next) break;
		current = current[next];
		depth++;
	}

	return current;
}

function containsGift(node: any, depth = 0): boolean {
	if (!node || depth > 10 || typeof node !== 'object') return false;
	if (resolveComponent(node.type) === giftComponent) return true;

	const props = node.props;
	if (!props || typeof props !== 'object') return false;
	if (containsGift(props.item, depth + 1)) return true;
	if (containsGift(props.children, depth + 1)) return true;
	if (Array.isArray(props.children)) return props.children.some((child) => containsGift(child, depth + 1));
	return false;
}

function patchGiftButton(mod: any): boolean {
	if (unpatchGiftButton) return true;

	const target = unwrapComponent(mod);
	if (!target) return false;

	giftComponent = target.component;
	unpatchGiftButton = patcher.instead(target.holder, target.prop, (ctx) => {
		const props = ctx.args[0];
		if (props && typeof props === 'object' && typeof props.hideGiftButton === 'boolean') {
			ctx.args[0] = { ...props, hideGiftButton: true };
			return ctx.original.apply(ctx.this, ctx.args);
		}
		return null;
	});
	return true;
}

function patchRightActions(mod: any): boolean {
	if (unpatchRightActions) return true;

	const target = unwrapComponent(mod);
	if (!target) return false;

	unpatchRightActions = patcher.after(target.holder, target.prop, (ctx) => {
		try {
			const result = ctx.result as any;
			if (!result?.props || !giftComponent) return;

			const { React } = metro.common;
			const children = React.Children.toArray(result.props.children);
			const filtered = children.filter((child: any) => !containsGift(child));
			if (filtered.length === children.length) return;

			return React.cloneElement(result, null, ...filtered);
		} catch { }
	});
	return true;
}

function patchLoadedModules(): boolean {
	const giftPatched = patchGiftButton(metro.findByFilePath(GIFT_BUTTON_PATH, { interop: false }));
	const rightActionsPatched = patchRightActions(metro.findByFilePath(RIGHT_ACTIONS_PATH, { interop: false }));
	return giftPatched && rightActionsPatched;
}

export default {
	start() {
		if (patchLoadedModules()) return;

		removeModuleListener = metro.addListener((module, id) => {
			const path = modulePath(id);
			if (path !== GIFT_BUTTON_PATH && path !== RIGHT_ACTIONS_PATH) return;
			if (!patchLoadedModules()) return;
			removeModuleListener?.();
			removeModuleListener = null;
		});
	},

	stop() {
		unpatchRightActions?.();
		unpatchRightActions = null;
		unpatchGiftButton?.();
		unpatchGiftButton = null;
		giftComponent = null;
		removeModuleListener?.();
		removeModuleListener = null;
	},
};
