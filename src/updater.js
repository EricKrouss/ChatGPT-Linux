import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';

// Use require for CommonJS packages under ESM
const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const semver = require('semver');

/**
 * Minimal GitHub updater for a source-run Electron app.
 * - Checks GitHub Releases latest tag
 * - If newer than package.json version, downloads zipball and overlays files
 * - Excludes node_modules and common build outputs
 */

const DEFAULT_EXCLUDES = new Set([
	'node_modules',
	'.git',
	'dist',
	'out',
	'.DS_Store'
]);

function getRepoFromEnv() {
	const envRepo = process.env.GITHUB_REPO || '';
	if (!envRepo.includes('/')) return null;
	return envRepo.trim(); // "owner/name"
}

async function readJson(filePath) {
	const raw = await fsp.readFile(filePath, 'utf8');
	return JSON.parse(raw);
}

export async function getCurrentVersion(appRoot) {
	const pkgPath = path.join(appRoot, 'package.json');
	const pkg = await readJson(pkgPath);
	return pkg.version || '0.0.0';
}

export async function getLatestRelease(repo, token) {
	const url = `https://api.github.com/repos/${repo}/releases/latest`;
	const headers = { 'User-Agent': 'chatgpt-electron-updater' };
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(url, { headers });
	if (!res.ok) throw new Error(`GitHub API error ${res.status}`);
	const data = await res.json();
	const tag = data.tag_name || data.name;
	return {
		version: tag?.replace(/^v/, '') || null,
		zipballUrl: data.zipball_url
	};
}

export function isNewerVersion(latest, current) {
	try {
		return semver.gt(semver.coerce(latest), semver.coerce(current));
	} catch {
		return latest !== current;
	}
}

async function downloadZipToTemp(zipUrl, token) {
	const headers = { 'User-Agent': 'chatgpt-electron-updater' };
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(zipUrl, { headers });
	if (!res.ok) throw new Error(`Download failed ${res.status}`);
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chatgpt-electron-update-'));
	const zipPath = path.join(tmpDir, 'update.zip');
	const file = fs.createWriteStream(zipPath);
	await pipeline(res.body, file);
	return { tmpDir, zipPath };
}

async function extractZipToDir(zipPath, targetDir) {
	const zip = new AdmZip(zipPath);
	zip.extractAllTo(targetDir, true);
	// The GitHub zipball contains a single top-level folder like repo-<sha>
	const entries = await fsp.readdir(targetDir, { withFileTypes: true });
	const top = entries.find(e => e.isDirectory());
	return top ? path.join(targetDir, top.name) : targetDir;
}

async function copyRecursive(srcDir, dstDir) {
	const entries = await fsp.readdir(srcDir, { withFileTypes: true });
	for (const entry of entries) {
		if (DEFAULT_EXCLUDES.has(entry.name)) continue;
		const srcPath = path.join(srcDir, entry.name);
		const dstPath = path.join(dstDir, entry.name);
		if (entry.isDirectory()) {
			await fsp.mkdir(dstPath, { recursive: true });
			await copyRecursive(srcPath, dstPath);
		} else if (entry.isFile()) {
			await fsp.mkdir(path.dirname(dstPath), { recursive: true });
			await fsp.copyFile(srcPath, dstPath);
		}
	}
}

export async function checkForUpdates({ appRoot, onStatus }) {
	const repo = getRepoFromEnv();
	if (!repo) {
		onStatus?.('GitHub repo not configured. Set GITHUB_REPO=owner/name');
		return { updated: false, reason: 'no_repo' };
	}
	const token = process.env.GITHUB_TOKEN || '';
	const currentVersion = await getCurrentVersion(appRoot);
	onStatus?.(`Current version ${currentVersion}`);
	const { version: latestVersion, zipballUrl } = await getLatestRelease(repo, token);
	if (!latestVersion) {
		onStatus?.('Could not determine latest version');
		return { updated: false, reason: 'no_latest' };
	}
	onStatus?.(`Latest version ${latestVersion}`);
	if (!isNewerVersion(latestVersion, currentVersion)) {
		onStatus?.('Already up to date');
		return { updated: false, reason: 'up_to_date' };
	}
	// Download and apply
	onStatus?.('Downloading update…');
	const { tmpDir, zipPath } = await downloadZipToTemp(zipballUrl, token);
	const extractRoot = await extractZipToDir(zipPath, tmpDir);
	onStatus?.('Applying update…');
	await copyRecursive(extractRoot, appRoot);
	onStatus?.('Update applied');
	return { updated: true, latestVersion };
}


