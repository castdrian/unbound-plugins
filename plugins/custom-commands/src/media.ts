import type { TagMedia } from '@custom-commands/tags';
import { fs, metro } from '@unbound-app/api';
import type { PluginContext } from '@unbound-app/api/native';

export type PickedMedia = {
	duration?: number;
	fileName: string;
	fileSize: number;
	height?: number;
	id?: string;
	type: string;
	uri: string;
	width?: number;
};

type PickerResult = {
	assets?: PickedMedia[];
	didCancel?: boolean;
	errorCode?: string;
	errorMessage?: string;
};

type MediaPicker = {
	launchImageLibraryAsync: (options: Record<string, unknown>) => Promise<PickerResult>;
};

let pluginContext: PluginContext | null = null;

export function setMediaContext(context: PluginContext | null): void {
	pluginContext = context;
}

export function mediaUri(media: TagMedia): string {
	return `file://${fs.Documents}/${media.storedName}`;
}

export async function pickMedia(): Promise<PickedMedia[]> {
	const picker = metro.findByProps('launchImageLibraryAsync') as MediaPicker | null;
	if (typeof picker?.launchImageLibraryAsync !== 'function')
		throw new Error('The media picker is unavailable on this Discord build.');

	const result = await picker.launchImageLibraryAsync({
		includeBase64: false,
		mediaType: 'mixed',
		selectionLimit: 10,
	});
	if (result.errorCode) throw new Error(result.errorMessage || result.errorCode);
	return (result.assets ?? []).filter(
		(asset) =>
			asset &&
			typeof asset.uri === 'string' &&
			typeof asset.type === 'string' &&
			(asset.type.startsWith('image/') || asset.type.startsWith('video/')),
	);
}

export async function persistMedia(asset: PickedMedia): Promise<TagMedia> {
	const context = pluginContext;
	if (!context) throw new Error('Custom Commands is not running.');
	const extension =
		asset.fileName.match(/\.([a-z0-9]+)$/i)?.[1] ?? asset.type.split('/')[1] ?? 'bin';
	const storedName = `custom-commands-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension.toLowerCase()}`;
	const sourcePath = asset.uri.startsWith('file://')
		? decodeURI(asset.uri.slice('file://'.length))
		: asset.uri;
	const destinationPath = `${fs.Documents}/${storedName}`;
	let copied = false;

	try {
		const objc = context.native.objc;
		const fileManagerClass = objc.getClass('NSFileManager');
		if (fileManagerClass) {
			const fileManager = objc.call(fileManagerClass, 'defaultManager');
			if (fileManager && typeof fileManager === 'object') {
				copied = Boolean(
					objc.call(fileManager, 'copyItemAtPath:toPath:error:', sourcePath, destinationPath, null),
				);
			}
		}
	} catch {}

	if (!copied) {
		const encoded = await fs.read(sourcePath, 'base64', false);
		await fs.write(storedName, encoded, 'base64');
	}

	return {
		storedName,
		fileName: asset.fileName || storedName,
		mimeType: asset.type,
		fileSize: asset.fileSize,
		width: asset.width,
		height: asset.height,
		duration: asset.duration,
	};
}

export async function removeStoredMedia(media: TagMedia): Promise<void> {
	await fs.rm(media.storedName);
}
