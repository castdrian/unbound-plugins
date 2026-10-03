import { languageNames } from '@shikijs/langs';

export const DEFAULT_THEME = 'dark-plus';
export const SHIKI_ASSET_COMMIT = 'bc5436518111d87ea58eb56d97b3f9bec30e6b83';
export const LANGUAGE_CATALOG_URL =
	'https://cdn.jsdelivr.net/gh/Vencord/ShikiPluginAssets@75d69df9fdf596a31eef8b7f6f891231a6feab44/grammars.json';

export const THEME_IDS = [
	'dark-plus',
	'andromeeda',
	'aurora-x',
	'ayu-dark',
	'catppuccin-latte',
	'catppuccin-frappe',
	'catppuccin-macchiato',
	'catppuccin-mocha',
	'dracula-soft',
	'dracula',
	'everforest-dark',
	'everforest-light',
	'github-dark-default',
	'github-dark-dimmed',
	'github-dark-high-contrast',
	'github-dark',
	'github-light-default',
	'github-light-high-contrast',
	'github-light',
	'gruvbox-dark-hard',
	'gruvbox-dark-medium',
	'gruvbox-dark-soft',
	'gruvbox-light-hard',
	'gruvbox-light-medium',
	'gruvbox-light-soft',
	'houston',
	'kanagawa-dragon',
	'kanagawa-lotus',
	'kanagawa-wave',
	'laserwave',
	'light-plus',
	'material-theme-darker',
	'material-theme',
	'material-theme-lighter',
	'material-theme-ocean',
	'material-theme-palenight',
	'material-candy',
	'min-dark',
	'min-light',
	'monokai',
	'night-owl',
	'nord',
	'one-dark-pro',
	'one-light',
	'plastic',
	'poimandres',
	'red',
	'rose-pine-dawn',
	'rose-pine-moon',
	'rose-pine',
	'slack-dark',
	'slack-ochin',
	'snazzy-light',
	'solarized-dark',
	'solarized-light',
	'synthwave-84',
	'tokyo-night',
	'vesper',
	'vitesse-black',
	'vitesse-dark',
	'vitesse-light',
] as const;

export type LanguageMetadata = {
	aliases?: string[];
	devicon?: string;
	displayName: string;
	name: string;
	scopeName: string;
};

const knownLanguages = new Set<string>(languageNames);
const languages = new Map<string, LanguageMetadata>();
const aliases = new Map<string, string>();
let catalogPromise: Promise<void> | null = null;

export function grammarUrl(name: string): string {
	return `https://cdn.jsdelivr.net/gh/shikijs/textmate-grammars-themes@${SHIKI_ASSET_COMMIT}/packages/tm-grammars/grammars/${encodeURIComponent(name)}.json`;
}

export function themeUrl(name: string): string {
	if (name.startsWith('custom:')) return name.slice('custom:'.length);
	if (name === 'material-candy') {
		return 'https://raw.githubusercontent.com/millsp/material-candy/master/material-candy.json';
	}
	return `https://cdn.jsdelivr.net/gh/shikijs/textmate-grammars-themes@${SHIKI_ASSET_COMMIT}/packages/tm-themes/themes/${encodeURIComponent(name)}.json`;
}

export function themeLabel(name: string): string {
	return name.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function resolveCatalogLanguage(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const name = value.trim().toLowerCase();
	if (!name) return null;
	return aliases.get(name) ?? (knownLanguages.has(name) ? name : null);
}

export function getLanguageMetadata(name: string): LanguageMetadata | undefined {
	return languages.get(name);
}

export function loadLanguageCatalog(): Promise<void> {
	if (catalogPromise) return catalogPromise;
	catalogPromise = fetch(LANGUAGE_CATALOG_URL)
		.then((response) => {
			if (!response.ok) throw new Error(`Language catalog returned ${response.status}`);
			return response.json() as Promise<LanguageMetadata[]>;
		})
		.then((entries) => {
			for (const entry of entries) {
				if (!entry.name || !entry.scopeName) continue;
				knownLanguages.add(entry.name);
				languages.set(entry.name, entry);
				for (const alias of entry.aliases ?? []) aliases.set(alias, entry.name);
			}
		})
		.catch((error) => {
			catalogPromise = null;
			throw error;
		});
	return catalogPromise;
}
