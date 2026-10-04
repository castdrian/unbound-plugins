import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type PackageManifest = {
	scripts?: Record<string, string>;
};

const pluginsRoot = resolve(import.meta.dir, '..');
const clientRoot = resolve(pluginsRoot, '..', 'unbound');
const outputRoot = join(pluginsRoot, 'dist');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'unbound-package-'));
const pluginsWorktree = join(temporaryRoot, 'plugins');
const clientWorktree = join(temporaryRoot, 'client');

function run(command: string, args: string[], cwd: string): void {
	execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function revision(root: string): string {
	return execFileSync('git', ['rev-parse', 'origin/main'], { cwd: root, encoding: 'utf8' }).trim();
}

function hasBuildScript(pluginDir: string): boolean {
	const packagePath = join(pluginDir, 'package.json');
	if (!existsSync(packagePath)) return false;

	const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as PackageManifest;
	return typeof manifest.scripts?.build === 'string';
}

function copyPlugins(): void {
	const sourceRoot = join(pluginsWorktree, 'plugins');
	const targetRoot = join(outputRoot, 'Plugins');

	for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;

		const pluginDir = join(sourceRoot, entry.name);
		if (!existsSync(join(pluginDir, 'manifest.json'))) continue;

		const source = hasBuildScript(pluginDir) ? join(pluginDir, 'dist') : pluginDir;
		cpSync(source, join(targetRoot, entry.name), { recursive: true });
	}
}

function cleanWorktrees(): void {
	for (const [root, worktree] of [
		[pluginsRoot, pluginsWorktree],
		[clientRoot, clientWorktree],
	] as const) {
		if (existsSync(worktree)) run('git', ['worktree', 'remove', '--force', worktree], root);
	}

	rmSync(temporaryRoot, { recursive: true, force: true });
}

function packageClean(): void {
	run('git', ['fetch', '--quiet', 'origin', 'main'], pluginsRoot);
	run('git', ['fetch', '--quiet', 'origin', 'main'], clientRoot);

	const pluginsRevision = revision(pluginsRoot);
	const clientRevision = revision(clientRoot);

	run('git', ['worktree', 'add', '--detach', pluginsWorktree, pluginsRevision], pluginsRoot);
	run('git', ['worktree', 'add', '--detach', clientWorktree, clientRevision], clientRoot);

	try {
		run('bun', ['install'], pluginsWorktree);
		run('bun', ['run', 'build'], pluginsWorktree);
		run('bun', ['install'], clientWorktree);
		run('bun', ['run', 'build'], join(clientWorktree, 'packages', 'client'));

		rmSync(outputRoot, { recursive: true, force: true });
		mkdirSync(join(outputRoot, 'Plugins'), { recursive: true });
		cpSync(join(clientWorktree, 'packages', 'client', 'dist'), outputRoot, { recursive: true });
		copyPlugins();
		writeFileSync(
			join(outputRoot, 'build.json'),
			`${JSON.stringify({ clientRevision, pluginsRevision }, null, '\t')}\n`,
		);
	} finally {
		cleanWorktrees();
	}
}

packageClean();
