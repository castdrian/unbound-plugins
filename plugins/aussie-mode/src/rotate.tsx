import { metro, patcher } from '@unbound-app/api';
import type { ReactNode } from 'react';
import { View } from 'react-native';

const Patcher = patcher.createPatcher('adrian.aussie-mode');

const ROTATED_ROOT_COMPONENT_NAMES = ['ErrorBoundary', 'FullScreenOverlay'];
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

function rotateFileComponent(filePath: string): void {
	const module = metro.findByFilePath(filePath, { interop: false });
	const Component = module?.default;

	if (typeof Component === 'function') {
		Patcher.after(module, 'default', ({ result }) => rotateResult(result));
		return;
	}

	if (typeof Component?.type === 'function') {
		Patcher.after(Component, 'type', ({ result }) => rotateResult(result));
	}
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

	rotateActionSheets();
}

export function stopRotation(): void {
	try {
		Patcher.unpatchAll();
	} catch {}
}
