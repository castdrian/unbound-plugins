import { expect, mock, test } from 'bun:test';

let pickerResult: unknown;
let fileType = 'NSFileTypeRegular';
let fileSize = 4096;

const picker = {
	launchImageLibraryAsync: async () => pickerResult,
};
const fileManager = {};
const batchSelectors: string[][] = [];

mock.module('@unbound-app/api', () => ({
	fs: { Documents: '/Documents' },
	metro: { findByProps: () => picker },
}));

const { pickMedia, persistMedia, setMediaContext } = await import('@custom-commands/media');

setMediaContext({
	native: {
		objc: {
			getClass: (name: string) => name,
			batch: async (steps: { target: unknown; selector: string; args: unknown[] }[]) => {
				batchSelectors.push(steps.map((step) => step.selector));
				const results: unknown[] = [];
				for (const step of steps) {
					const index = (step.target as { $nativeBatchResult?: number })?.$nativeBatchResult;
					const receiver = index === undefined ? step.target : results[index];
					if (step.selector === 'defaultManager') results.push(fileManager);
					else if (step.selector === 'attributesOfItemAtPath:error:')
						results.push({ NSFileType: fileType, NSFileSize: fileSize });
					else if (step.selector === 'typeWithFilenameExtension:') results.push(step.args[0]);
					else if (step.selector === 'preferredMIMEType')
						results.push(receiver === 'mov' ? 'video/quicktime' : 'image/png');
					else if (step.selector === 'copyItemAtPath:toPath:error:') results.push(true);
					else results.push(null);
				}
				return results;
			},
		},
	},
} as Parameters<typeof setMediaContext>[0]);

test('fills missing picker filename and size from a regular image file', async () => {
	fileType = 'NSFileTypeRegular';
	fileSize = 193309;
	pickerResult = {
		assets: [
			{ uri: 'file:///Documents/tmp/photo.png', type: 'image/png', width: 750, height: 1334 },
		],
	};

	const [media] = await pickMedia();
	expect(media.fileName).toBe('photo.png');
	expect(media.fileSize).toBe(193309);
	expect(media.type).toBe('image/png');
	expect((await persistMedia(media)).fileSize).toBe(193309);
	expect(batchSelectors).toContainEqual(['defaultManager', 'attributesOfItemAtPath:error:']);
	expect(batchSelectors).toContainEqual(['defaultManager', 'copyItemAtPath:toPath:error:']);
});

test('resolves missing MIME type from the file extension', async () => {
	fileType = 'NSFileTypeRegular';
	fileSize = 8192;
	pickerResult = { assets: [{ uri: 'file:///Documents/tmp/clip.mov' }] };

	const [media] = await pickMedia();
	expect(media.fileName).toBe('clip.mov');
	expect(media.fileSize).toBe(8192);
	expect(media.type).toBe('video/quicktime');
});

test('rejects picker results that point at a directory', async () => {
	fileType = 'NSFileTypeDirectory';
	fileSize = 0;
	pickerResult = { assets: [{ uri: 'file:///Documents/tmp/' }] };

	expect(pickMedia()).rejects.toThrow('available');
});
