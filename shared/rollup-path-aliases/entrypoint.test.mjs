import { afterEach, expect, test } from 'bun:test';

import { hermesExpressionEntrypoint } from './entrypoint.mjs';

afterEach(() => {
	delete globalThis.__sharedPluginEntrypointCalls;
});

test('forwards lifecycle methods and context to a default plugin export', () => {
	globalThis.__sharedPluginEntrypointCalls = [];
	const chunk = {
		code: '({default:{start(context){globalThis.__sharedPluginEntrypointCalls.push(context);},stop(){globalThis.__sharedPluginEntrypointCalls.push("stop");},getSettingsPanel(){return "panel";}}})',
		type: 'chunk',
	};
	const bundle = hermesExpressionEntrypoint();
	bundle.generateBundle({}, { entry: chunk });
	const entry = Function(`return ${chunk.code}`)();
	const context = { id: 'plugin' };

	entry.start(context);
	entry.stop();

	expect(entry.getSettingsPanel()).toBe('panel');
	expect(globalThis.__sharedPluginEntrypointCalls).toEqual([context, 'stop']);
});

test('forwards lifecycle methods to a namespace export without a default', () => {
	globalThis.__sharedPluginEntrypointCalls = [];
	const chunk = {
		code: '({start(context){globalThis.__sharedPluginEntrypointCalls.push(context);},stop(){globalThis.__sharedPluginEntrypointCalls.push("stop");},getSettingsPanel(){return "panel";}})',
		type: 'chunk',
	};
	const bundle = hermesExpressionEntrypoint();
	bundle.generateBundle({}, { entry: chunk });
	const entry = Function(`return ${chunk.code}`)();
	const context = { id: 'plugin' };

	entry.start(context);
	entry.stop();

	expect(entry.getSettingsPanel()).toBe('panel');
	expect(globalThis.__sharedPluginEntrypointCalls).toEqual([context, 'stop']);
});
