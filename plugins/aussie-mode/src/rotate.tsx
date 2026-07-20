import { metro, patcher, toasts } from '@unbound-app/api';
import { View } from 'react-native';

const Patcher = patcher.createPatcher('adrian.aussie-mode');

const ROTATED_ROOT_COMPONENT_NAMES = ['ErrorBoundary', 'FullScreenOverlay'];

function rotateClassComponentRender(componentName: string): void {
	const Component = metro.findByName(componentName);

	if (!Component?.prototype?.render) {
		console.log(`[Aussie Mode] could not find a class component named ${componentName} to rotate`);
		toasts.showToast({ title: 'Aussie Mode', content: `Could not find ${componentName} to rotate.` });
		return;
	}

	let hasAppliedFirstRotatedRender = false;

	Patcher.after(Component.prototype, 'render', ({ result }) => {
		if (!hasAppliedFirstRotatedRender) {
			hasAppliedFirstRotatedRender = true;
			console.log(`[Aussie Mode] rotating ${componentName} for the first time`);
			toasts.showToast({ title: 'Aussie Mode', content: `Rotating ${componentName} now.` });
		}

		return <View style={{ flex: 1, transform: [{ rotate: '180deg' }] }}>{result}</View>;
	});
}

export function startRotation(): void {
	for (const componentName of ROTATED_ROOT_COMPONENT_NAMES) {
		rotateClassComponentRender(componentName);
	}
}

export function stopRotation(): void {
	try {
		Patcher.unpatchAll();
	} catch (error) {
		console.log('[Aussie Mode] unpatchAll failed, ignoring since a reload follows:', error);
	}
}
