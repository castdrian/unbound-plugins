import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pluginsDir = resolve(repoRoot, 'plugins');

interface PluginAuthor {
	name: string;
	id: string;
}

interface PluginManifest {
	id: string;
	name: string;
	description: string;
	version: string;
	authors: PluginAuthor[];
}

interface PluginInfo {
	folder: string;
	manifest: PluginManifest;
	hasReadme: boolean;
}

function readPluginManifests(): PluginInfo[] {
	return readdirSync(pluginsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry): PluginInfo | null => {
			const manifestPath = resolve(pluginsDir, entry.name, 'manifest.json');
			if (!existsSync(manifestPath)) return null;

			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginManifest;
			const hasReadme = existsSync(resolve(pluginsDir, entry.name, 'README.md'));

			return { folder: entry.name, manifest, hasReadme };
		})
		.filter((plugin): plugin is PluginInfo => plugin !== null)
		.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

function renderTable(plugins: PluginInfo[]): string {
	const header = '| Plugin | Description | Version | Authors |\n| --- | --- | --- | --- |';
	const rows = plugins.map(({ folder, manifest, hasReadme }) => {
		const authors = manifest.authors.map((author) => author.name).join(', ');
		const name = hasReadme ? `[${manifest.name}](${folder}/README.md)` : manifest.name;
		return `| ${name} | ${manifest.description} | ${manifest.version} | ${authors} |`;
	});

	return [header, ...rows].join('\n');
}

function generate(): void {
	const plugins = readPluginManifests();

	const readme = `# Plugins

${plugins.length} plugin${plugins.length === 1 ? '' : 's'} in this workspace.

<!-- AUTO-GENERATED: this table is built from each plugin's manifest.json. Do not edit by hand. -->

${renderTable(plugins)}

<!-- END AUTO-GENERATED -->
`;

	writeFileSync(resolve(pluginsDir, 'README.md'), readme);
}

generate();
