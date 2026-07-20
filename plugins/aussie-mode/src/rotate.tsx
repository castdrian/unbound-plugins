import { metro, patcher } from '@unbound-app/api';
import type { ReactNode } from 'react';
import { View } from 'react-native';

const Patcher = patcher.createPatcher('adrian.aussie-mode');

const ROTATED_ROOT_COMPONENT_NAMES = ['ErrorBoundary', 'FullScreenOverlay'];

function rotateResult(result: ReactNode) {
	return <View style={{ flex: 1, transform: [{ rotate: '180deg' }] }}>{result}</View>;
}

function rotateClassComponentRender(componentName: string): void {
	const Component = metro.findByName(componentName);

	if (!Component?.prototype?.render) {
		console.warn(`[Aussie Mode] could not find ${componentName}`);
		return;
	}

	Patcher.after(Component.prototype, 'render', ({ result }) => {
		return rotateResult(result);
	});
}

function rotateActionSheets(): void {
	const sheets = metro.findByProps('openLazy', 'hideActionSheet');

	if (typeof sheets?.openLazy !== 'function') {
		console.warn('[Aussie Mode] could not find the action sheet host');
		return;
	}

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

	rotateActionSheets();
}

export function stopRotation(): void {
	try {
		Patcher.unpatchAll();
	} catch {}
}
