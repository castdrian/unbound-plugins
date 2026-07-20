import { metro, patcher } from '@unbound-app/api';
import type { ReactNode } from 'react';
import { View } from 'react-native';

const Patcher = patcher.createPatcher('adrian.aussie-mode');

const ROTATED_ROOT_COMPONENT_NAMES = ['ErrorBoundary'];
const ROTATED_COMPONENT_FILE_PATHS = [
	'modules/main_tabs_v2/native/tabs/you/YouScreen.tsx',
	'modules/main_tabs_v2/native/tabs/settings/Settings.tsx',
	'modules/main_tabs_v2/native/tabs/you/YouAccountActionSheet.tsx',
];

function rotateResult(result: ReactNode) {
	return (
		<View pointerEvents='box-none' style={{ flex: 1, transform: [{ rotate: '180deg' }] }}>
			{result}
		</View>
	);
}

function rotateClassComponentRender(componentName: string): void {
	const Component = metro.findByName(componentName);

	if (!Component?.prototype?.render) return;

	Patcher.after(Component.prototype, 'render', ({ result }) => {
		return rotateResult(result);
	});
}

const FILE_COMPONENT_POLL_INTERVAL_MS = 500;
const FILE_COMPONENT_POLL_MAX_ATTEMPTS = 60;

function attachFileRotation(module: any): void {
	const Component = module?.default;

	if (typeof Component === 'function') {
		Patcher.after(module, 'default', ({ result }) => rotateResult(result));
		return;
	}

	if (typeof Component?.type === 'function') {
		Patcher.after(Component, 'type', ({ result }) => rotateResult(result));
	}
}

function rotateFileComponent(filePath: string): void {
	const existing = metro.findByFilePath(filePath, { interop: false });
	if (existing) {
		attachFileRotation(existing);
		return;
	}

	let attempts = 0;
	const interval = setInterval(() => {
		attempts++;

		const module = metro.findByFilePath(filePath, { interop: false });
		if (module) {
			clearInterval(interval);
			attachFileRotation(module);
			return;
		}

		if (attempts >= FILE_COMPONENT_POLL_MAX_ATTEMPTS) clearInterval(interval);
	}, FILE_COMPONENT_POLL_INTERVAL_MS);
}

function rotateNavigatorScreen(siblingRouteNames: string[], targetRouteName: string): void {
	const nav = metro.findByProps('useNavigationBuilder');
	if (typeof nav?.useNavigationBuilder !== 'function') return;

	const patchedComponents = new WeakSet<object>();

	Patcher.before(nav, 'useNavigationBuilder', ({ args }) => {
		const children = (args[1] as { children?: unknown } | undefined)?.children;
		const screens = Array.isArray(children) ? children : children ? [children] : [];
		const names = screens.map((screen: any) => screen?.props?.name).filter(Boolean);

		if (!siblingRouteNames.every((name) => names.includes(name))) return;

		const target = screens.find((screen: any) => screen?.props?.name === targetRouteName);
		const getComponent = target?.props?.getComponent;
		if (typeof getComponent !== 'function') return;

		const Component = getComponent();
		if (!Component || typeof Component !== 'object' || typeof Component.type !== 'function') return;
		if (patchedComponents.has(Component)) return;

		patchedComponents.add(Component);
		Patcher.after(Component, 'type', ({ result }) => rotateResult(result));
	});
}

function rotateActionSheets(): void {
	const sheets = metro.findByProps('openLazy', 'hideActionSheet');

	if (typeof sheets?.openLazy !== 'function') return;

	Patcher.before(sheets, 'openLazy', ({ args }) => {
		const [componentPromise] = args;
		if (typeof componentPromise?.then !== 'function') return;

		args[0] = componentPromise.then((module: any) => {
			const Component = module?.default;
			if (!Component) return module;

			return {
				...module,
				default: (props: any) => rotateResult(<Component {...props} />),
			};
		});
	});
}

export function startRotation(): void {
	for (const componentName of ROTATED_ROOT_COMPONENT_NAMES) {
		rotateClassComponentRender(componentName);
	}

	for (const filePath of ROTATED_COMPONENT_FILE_PATHS) {
		rotateFileComponent(filePath);
	}

	rotateNavigatorScreen(['root', 'search_chat_preview', 'pinned-messages', 'mute', 'threads'], 'root');

	rotateActionSheets();
}

export function stopRotation(): void {
	try {
		Patcher.unpatchAll();
	} catch {}
}
