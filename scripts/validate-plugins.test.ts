import { resolve } from 'node:path';

import { expect, test } from 'bun:test';

import {
	PLUGIN_DESCRIPTION_MAX_LENGTH,
	PLUGIN_FOLDER_MAX_LENGTH,
	PLUGIN_NAME_MAX_LENGTH,
	validatePluginDirectory,
	validatePluginFolder,
} from './validate-plugins';

const validManifest = {
	id: 'unbound.example-plugin',
	name: 'Example Plugin',
	description: 'A concise example plugin description.',
	authors: [{ name: 'Unbound Team', id: '0' }],
	version: '1.0.0',
	main: 'index.js',
};

test('every plugin folder follows the workspace convention', () => {
	expect(validatePluginDirectory(resolve(import.meta.dir, '..', 'plugins'))).toEqual([]);
});

test('accepts a valid plugin folder and manifest', () => {
	expect(validatePluginFolder('example-plugin', validManifest)).toEqual([]);
});

test('rejects folders that are not lowercase kebab-case', () => {
	expect(validatePluginFolder('Example_Plugin', validManifest)).toContain('folder must use lowercase kebab-case');
});

test('requires ids to match their plugin folder suffix', () => {
	expect(validatePluginFolder('other-plugin', validManifest)).toContain('id must end with .other-plugin');
});

test('enforces display name and description limits', () => {
	const manifest = {
		...validManifest,
		name: 'x'.repeat(PLUGIN_NAME_MAX_LENGTH + 1),
		description: 'x'.repeat(PLUGIN_DESCRIPTION_MAX_LENGTH + 1),
	};
	const errors = validatePluginFolder('example-plugin', manifest);

	expect(errors).toContain(`name must be at most ${PLUGIN_NAME_MAX_LENGTH} characters`);
	expect(errors).toContain(`description must be at most ${PLUGIN_DESCRIPTION_MAX_LENGTH} characters`);
});

test('enforces the plugin folder length limit', () => {
	const folder = `a${'b'.repeat(PLUGIN_FOLDER_MAX_LENGTH)}`;
	expect(validatePluginFolder(folder, validManifest)).toContain(
		`folder must be at most ${PLUGIN_FOLDER_MAX_LENGTH} characters`,
	);
});
