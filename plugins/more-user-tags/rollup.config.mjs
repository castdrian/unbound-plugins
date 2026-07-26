import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import iife from 'rollup-plugin-iife';
import { swc } from 'rollup-plugin-swc3';

const pluginRoot = fileURLToPath(new URL('.', import.meta.url));

function resolveModule(source) {
	const candidate = resolve(pluginRoot, 'src', source.replace(/^@force-owner-crown\//, ''));
	const search = [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`, `${candidate}.mjs`, `${candidate}.json`, resolve(candidate, 'index.ts'), resolve(candidate, 'index.tsx'), resolve(candidate, 'index.js')];

	for (const file of search) {
		if (existsSync(file)) return file;
	}

	return null;
}

function pluginAlias() {
	return {
		name: 'force-owner-crown-alias',
		resolveId(source) {
			if (!source.startsWith('@force-owner-crown/')) return null;
			return resolveModule(source);
		},
	};
}

function hermesExpressionEntrypoint() {
	return {
		name: 'hermes-expression-entrypoint',
		generateBundle(_outputOptions, bundle) {
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== 'chunk') continue;
				let code = chunk.code.trim();
				code = code.replace(/^var\s+[A-Za-z_$][\w$]*\s*=\s*/, '');
				code = code.replace(/;\s*$/, '');
				chunk.code = `({__plugin:null,__load(){if(this.__plugin)return this.__plugin;this.__plugin=${code};return this.__plugin;},start(){const plugin=this.__load();if(plugin&&typeof plugin.start==='function')return plugin.start();},stop(){const plugin=this.__load();if(plugin&&typeof plugin.stop==='function')return plugin.stop();}})`;
			}
		},
	};
}

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
	'react-native-reanimated': 'window.unbound.metro.common.Reanimated',
	'@react-native-clipboard/clipboard': 'window.unbound.metro.common.Clipboard',
	'moment': 'window.unbound.metro.common.Moment',
};

/** @type {import('rollup').RollupOptions} */
export default {
	input: 'src/index.tsx',
	external: Object.keys(globals),
	plugins: [
		pluginAlias(),
		nodeResolve(),
		json(),
		swc({ tsconfig: false }),
		iife(),
		hermesExpressionEntrypoint(),
		manifestToDist(),
	],
	output: {
		dir: 'dist',
		entryFileNames: 'index.js',
		format: 'es',
		compact: true,
		exports: 'named',
		globals,
	},
};
