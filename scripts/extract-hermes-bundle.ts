import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HBC_MAGIC = 0x1f1903c103bc1fc6n;
const require = createRequire(import.meta.url);

export type BundleInspection = {
	format: 'hermes-bytecode' | 'javascript' | 'unknown';
	bytecodeVersion: number | null;
	size: number;
	sha256: string;
};

export type ExtractedBundle = BundleInspection & {
	sourcePath: string;
	bundlePath: string;
	outputDirectory: string;
	disassemblyPath: string | null;
	disassemblyError: string | null;
};

export type ExtractBundleOptions = {
	disassemble?: boolean;
};

export function inspectBundle(value: Uint8Array): BundleInspection {
	const bytes = Buffer.from(value);
	const isHermes = bytes.length >= 12 && bytes.readBigUInt64LE(0) === HBC_MAGIC;
	const looksLikeJavaScript = /^\s*(?:["']use strict["'];|(?:var|let|const|function|globalThis|import|export)\b)/.test(bytes.toString('utf8', 0, Math.min(bytes.length, 256)));

	return {
		format: isHermes ? 'hermes-bytecode' : looksLikeJavaScript ? 'javascript' : 'unknown',
		bytecodeVersion: isHermes ? bytes.readUInt32LE(8) : null,
		size: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex'),
	};
}

function bundleScore(path: string): number {
	const normalized = path.toLowerCase();
	const name = basename(normalized);
	let score = 0;

	if (name === 'main.jsbundle') score += 100;
	if (name === 'index.ios.bundle') score += 90;
	if (name === 'index.jsbundle') score += 80;
	if (name === 'unbound.bundle') score += 70;
	if (name.endsWith('.jsbundle')) score += 50;
	if (name.endsWith('.bundle')) score += 30;
	if (normalized.includes('/frameworks/')) score -= 1000;
	if (normalized.includes('/pluginkit/')) score -= 1000;

	return score;
}

function findBundleFiles(root: string): string[] {
	const files: string[] = [];

	function visit(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (['.bundle', '.jsbundle', '.js'].includes(extname(entry.name).toLowerCase())) files.push(path);
		}
	}

	visit(root);
	return files;
}

function findHermesc(): string | null {
	const configured = process.env.HERMESC_PATH;
	if (configured && existsSync(configured)) return configured;

	try {
		const path = execFileSync('which', ['hermesc'], { encoding: 'utf8' }).trim();
		if (path) return path;
	} catch { }

	try {
		const packagePath = require.resolve('hermes-compiler/package.json');
		const packageRoot = dirname(packagePath);
		const platformDirectory = process.platform === 'darwin' ? 'osx-bin' : process.platform === 'win32' ? 'win64-bin' : 'linux64-bin';
		const binary = join(packageRoot, 'hermesc', platformDirectory, process.platform === 'win32' ? 'hermesc.exe' : 'hermesc');
		return existsSync(binary) ? binary : null;
	} catch {
		const bunStore = resolve(import.meta.dir, '..', 'node_modules', '.bun');
		if (!existsSync(bunStore)) return null;

		const platformDirectory = process.platform === 'darwin' ? 'osx-bin' : process.platform === 'win32' ? 'win64-bin' : 'linux64-bin';
		const binaryName = process.platform === 'win32' ? 'hermesc.exe' : 'hermesc';
		for (const entry of readdirSync(bunStore, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith('hermes-compiler@')) continue;
			const binary = join(bunStore, entry.name, 'node_modules', 'hermes-compiler', 'hermesc', platformDirectory, binaryName);
			if (existsSync(binary)) return binary;
		}

		return null;
	}
}

export function extractHermesBundle(ipaPath: string, outputDirectory: string, options: ExtractBundleOptions = {}): ExtractedBundle {
	const source = resolve(ipaPath);
	const output = resolve(outputDirectory);
	if (!existsSync(source)) throw new Error(`IPA does not exist: ${source}`);

	const temporaryDirectory = mkdtempSync(join(tmpdir(), 'discord-bundle-'));
	try {
		execFileSync('unzip', ['-q', '-o', source, '-d', temporaryDirectory], { stdio: 'ignore' });
		const candidates = findBundleFiles(temporaryDirectory).sort((left, right) => {
			const scoreDifference = bundleScore(right) - bundleScore(left);
			return scoreDifference || statSync(right).size - statSync(left).size;
		});
		const selected = candidates[0];
		if (!selected) throw new Error('No JavaScript or Hermes bundle was found in the IPA.');

		const bytes = readFileSync(selected);
		const inspection = inspectBundle(bytes);
		mkdirSync(output, { recursive: true });
		const bundlePath = join(output, inspection.format === 'hermes-bytecode' ? 'discord.bundle' : 'discord.js');
		writeFileSync(bundlePath, bytes);

		let disassemblyPath: string | null = null;
		let disassemblyError: string | null = null;
		if (inspection.format === 'hermes-bytecode' && options.disassemble) {
			const hermesc = findHermesc();
			if (!hermesc) {
				disassemblyError = 'No hermesc binary was found.';
			} else {
				const candidatePath = join(output, 'discord.bytecode.txt');
				try {
					const disassembly = execFileSync(hermesc, ['-dump-bytecode', bundlePath], {
						encoding: 'utf8',
						maxBuffer: 256 * 1024 * 1024,
						stdio: ['ignore', 'pipe', 'pipe'],
					});
					writeFileSync(candidatePath, disassembly);
					disassemblyPath = candidatePath;
				} catch (error) {
					const details = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : String(error);
					disassemblyError = details.trim().slice(0, 500) || 'hermesc could not read this bytecode.';
				}
			}
		}

		const result: ExtractedBundle = {
			...inspection,
			sourcePath: relative(temporaryDirectory, selected),
			bundlePath,
			outputDirectory: output,
			disassemblyPath,
			disassemblyError,
		};
		writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`);
		return result;
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

function getArgument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
	const ipa = getArgument('--ipa');
	const output = getArgument('--output');
	if (process.argv.includes('--help')) {
		console.log('Usage: bun scripts/extract-hermes-bundle.ts --ipa Discord.ipa --output .artifacts/discord-bundle [--disassemble]');
		return;
	}
	if (!ipa || !output) throw new Error('Both --ipa and --output are required.');

	console.log(JSON.stringify(extractHermesBundle(ipa, output, { disassemble: process.argv.includes('--disassemble') }), null, 2));
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
