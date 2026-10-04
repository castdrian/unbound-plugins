import { expect, test } from 'bun:test';

import { inspectBundle } from './extract-hermes-bundle';

test('identifies Hermes bytecode without an IPA or device', () => {
	const value = Buffer.alloc(12);
	value.writeBigUInt64LE(0x1f1903c103bc1fc6n, 0);
	value.writeUInt32LE(96, 8);

	expect(inspectBundle(value)).toMatchObject({ format: 'hermes-bytecode', bytecodeVersion: 96, size: 12 });
});

test('identifies plain JavaScript bundles', () => {
	expect(inspectBundle(Buffer.from('var global = globalThis;'))).toMatchObject({
		format: 'javascript',
		bytecodeVersion: null,
	});
});
