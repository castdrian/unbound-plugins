const source = await Bun.file('plugins/mention-avatars/src/index.ts').text();
const forbidden = ['UnboundNative?.chat', 'setMentionAvatars', 'clearMentionAvatars', 'PluginAPI'];
const matches = forbidden.filter((value) => source.includes(value));

if (matches.length > 0) {
	console.error(`Legacy native mention APIs found: ${matches.join(', ')}`);
	process.exit(1);
}

const manifest = await Bun.file('plugins/mention-avatars/manifest.json').json();
const capabilities = manifest.capabilities ?? [];
const expected = [
	'native.objc.classes',
	'native.objc.invoke',
	'native.objc.ivars',
	'native.objc.hooks',
];

if (manifest.minNativePluginApi !== '1.0.0' || expected.some((capability) => !capabilities.includes(capability))) {
	console.error('Mention avatars native capability manifest is incomplete.');
	process.exit(1);
}
