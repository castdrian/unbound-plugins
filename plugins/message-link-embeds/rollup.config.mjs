import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import iife from 'rollup-plugin-iife';
import { swc } from 'rollup-plugin-swc3';
import {
	bunPathAliases,
	hermesExpressionEntrypoint,
	workerExpressionEntrypoint,
} from '@unbound-plugins/rollup-path-aliases';

const pluginRoot = fileURLToPath(new URL('.', import.meta.url));

function manifestToDist() {
	return {
		name: 'manifest-to-dist',
		buildStart() {
			const manifest = JSON.parse(readFileSync(resolve(pluginRoot, 'manifest.json'), 'utf8'));
			manifest.main = manifest.main.replace(/\.(tsx|ts|jsx|mjs)$/, '.js');
			this.emitFile({
				type: 'asset',
				fileName: 'manifest.json',
				source: `${JSON.stringify(manifest, null, '\t')}\n`,
			});
		},
	};
}

const globals = {
	'@unbound-app/api': 'window.unbound',
	'react': 'window.React',
	'react-native': 'window.ReactNative',
};

const pluginConfig = {
	input: 'src/index.tsx',
	external: Object.keys(globals),
	plugins: [bunPathAliases(), json(), nodeResolve(), swc({ tsconfig: false }), iife(), hermesExpressionEntrypoint(), manifestToDist()],
	output: {
		dir: 'dist',
		entryFileNames: 'index.js',
		format: 'es',
		compact: true,
		exports: 'named',
		globals,
	},
};

const workerConfig = {
	input: 'src/worker.ts',
	plugins: [
		bunPathAliases(),
		nodeResolve(),
		swc({ tsconfig: false }),
		iife(),
		workerExpressionEntrypoint(),
	],
	output: {
		dir: 'dist',
		entryFileNames: 'worker.js',
		format: 'es',
		compact: true,
		exports: 'named',
	},
};

export default [pluginConfig, workerConfig];
