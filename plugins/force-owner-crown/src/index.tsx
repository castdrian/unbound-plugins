import { assets, metro, patcher } from '@unbound-app/api';

const ROW_GENERATOR_PATH = 'modules/messages/native/renderer/MessageWithContent.tsx';
const CROWN_ASSET = 'ic_crown_16px';
const CROWN_LABEL = 'Server Owner';

let unpatch: (() => void) | null = null;
let crownSource: string | null = null;

function resolveCrownSource(): string | null {
	const id = assets.getIDByName(CROWN_ASSET);
	if (id == null) return null;

	const resolved = metro.common.ReactNative.Image.resolveAssetSource(id);
	return resolved?.uri ?? null;
}

function isGuildOwner(guildId: string | undefined, userId: string | undefined): boolean {
	if (!guildId || !userId) return false;

	const guilds = metro.findStore('Guild') as { getGuild?: (id: string) => { ownerId?: string } | null };
	return guilds?.getGuild?.(guildId)?.ownerId === userId;
}

function applyCrown(rowMessage: any): void {
	if (!rowMessage || rowMessage.roleIcon) return;
	if (!isGuildOwner(rowMessage.guildId, rowMessage.authorId)) return;

	rowMessage.roleIcon = {
		source: crownSource,
		name: CROWN_LABEL,
		size: 18,
		alt: CROWN_LABEL,
	};
}

export default {
	start() {
		crownSource = resolveCrownSource();
		if (!crownSource) return;

		const target = metro.findByFilePath(ROW_GENERATOR_PATH);
		if (typeof target?.generateMessageRowData !== 'function') return;

		unpatch = patcher.after(target, 'generateMessageRowData', (ctx) => {
			try {
				const row = ctx.result?.message;
				if (!row) return;

				applyCrown(row);
				applyCrown(row.referencedMessage?.message);
			} catch { }
		});
	},

	stop() {
		unpatch?.();
		unpatch = null;
		crownSource = null;
	},
};
