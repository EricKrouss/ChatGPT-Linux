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

function parseGithubRepoString(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const simpleMatch = trimmed.match(/^[^/]+\/[^/]+$/);
	if (simpleMatch) {
		return trimmed.replace(/\.git$/, '');
	}
	const urlMatch = trimmed.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/#]+?)(?:\.git)?(?:#.*)?$/i);
	if (urlMatch?.groups) {
		const { owner, repo } = urlMatch.groups;
		return `${owner}/${repo.replace(/\.git$/, '')}`;
	}
	const sshMatch = trimmed.match(/^git@github\.com:(?<owner>[^/]+)\/(?<repo>[^/#]+?)(?:\.git)?$/i);
	if (sshMatch?.groups) {
		const { owner, repo } = sshMatch.groups;
		return `${owner}/${repo.replace(/\.git$/, '')}`;
	}
	return null;
}

function repoFromPackage(pkg) {
	if (!pkg || typeof pkg !== 'object') return null;
	const publish = pkg.build?.publish;
	if (Array.isArray(publish)) {
		for (const entry of publish) {
			if (entry?.provider === 'github') {
				if (typeof entry.owner === 'string' && typeof entry.repo === 'string') {
					return `${entry.owner.trim()}/${entry.repo.trim()}`;
				}
				const fromUrl = parseGithubRepoString(entry.url);
				if (fromUrl) return fromUrl;
			}
		}
	}
	const repository = pkg.repository;
	if (typeof repository === 'string') {
		const parsed = parseGithubRepoString(repository);
		if (parsed) return parsed;
	} else if (repository && typeof repository === 'object') {
		const parsedRepo =
			parseGithubRepoString(repository.url) ||
			parseGithubRepoString(repository.directory) ||
			parseGithubRepoString(repository.repo);
		if (parsedRepo) return parsedRepo;
	}
	const homepageRepo = parseGithubRepoString(pkg.homepage);
	if (homepageRepo) return homepageRepo;
	return null;
}

async function loadPackageJson(appRoot) {
	const pkgPath = path.join(appRoot, 'package.json');
	return readJson(pkgPath);
}

async function resolveRepo({ appRoot, pkg }) {
	const envRepo = getRepoFromEnv();
	if (envRepo) return envRepo;
	const repoFromPkg = repoFromPackage(pkg);
	if (repoFromPkg) return repoFromPkg;
	return null;
}

async function readJson(filePath) {
	const raw = await fsp.readFile(filePath, 'utf8');
	return JSON.parse(raw);
}

export async function getCurrentVersion(appRoot) {
	const pkg = await loadPackageJson(appRoot);
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
		zipballUrl: data.zipball_url,
		assets: Array.isArray(data.assets) ? data.assets : [],
		htmlUrl: data.html_url
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

function detectPackagedInstall() {
 if (process.env.APPIMAGE) {
  return { type: 'appimage', path: process.env.APPIMAGE };
 }
 if (process.platform === 'linux') {
  const execPath = process.execPath;
  if (execPath.startsWith('/usr') || execPath.startsWith('/opt')) {
   return { type: 'system', execPath };
  }
 }
 return { type: 'unknown', execPath: process.execPath };
}

async function downloadBinary(url, destination, token) {
 const headers = { 'User-Agent': 'chatgpt-electron-updater', Accept: 'application/octet-stream' };
 if (token) headers.Authorization = `Bearer ${token}`;
 const res = await fetch(url, { headers });
 if (!res.ok) throw new Error(`Download failed ${res.status}`);
 const file = fs.createWriteStream(destination, { mode: 0o755 });
 await pipeline(res.body, file);
}

async function applyAppImageUpdate({ asset, installInfo, onStatus, token, version }) {
 if (!asset?.browser_download_url) {
  return { updated: false, reason: 'asset_missing' };
 }
 const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chatgpt-appimage-update-'));
 const tmpPath = path.join(tmpDir, asset.name || path.basename(installInfo.path));
 onStatus?.('Downloading AppImage update…');
 await downloadBinary(asset.browser_download_url, tmpPath, token);
 await fsp.chmod(tmpPath, 0o755);
 const destPath = installInfo.path;
 const backupPath = `${destPath}.bak-${Date.now()}`;
 try {
  await fsp.copyFile(destPath, backupPath);
 } catch (err) {
  onStatus?.(`Warning: could not create backup (${err.message}). Continuing.`);
 }
 onStatus?.('Applying AppImage update…');
 await fsp.copyFile(tmpPath, destPath);
 await fsp.chmod(destPath, 0o755);
 await fsp.rm(tmpPath, { force: true }).catch(() => {});
 await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
 return { updated: true, latestVersion: version, backupPath };
}

async function handlePackagedUpdate({ release, token, onStatus }) {
 const installInfo = detectPackagedInstall();
 switch (installInfo.type) {
  case 'appimage': {
   const appImageAsset = release.assets?.find(a => typeof a.name === 'string' && a.name.endsWith('.AppImage'));
   if (!appImageAsset) {
    onStatus?.('No AppImage asset found in release. Opening release page...');
    return { updated: false, reason: 'asset_not_found', openUrl: release.htmlUrl };
   }
   return await applyAppImageUpdate({ asset: appImageAsset, installInfo, onStatus, token, version: release.version });
  }
  default:
   onStatus?.('Auto-update is not supported for this install type. Opening release page...');
   return { updated: false, reason: 'packaged_manual', openUrl: release.htmlUrl };
 }
}

export async function checkForUpdates({ appRoot, onStatus, appIsPackaged = false }) {
	const pkg = await loadPackageJson(appRoot).catch(() => null);
	const repo = await resolveRepo({ appRoot, pkg });
	if (!repo) {
		onStatus?.('GitHub repo not configured. Set repository info in package.json or GITHUB_REPO=owner/name');
		return { updated: false, reason: 'no_repo' };
	}
	const token = process.env.GITHUB_TOKEN || '';
	const currentVersion = pkg?.version || '0.0.0';
	onStatus?.(`Current version ${currentVersion}`);
	const release = await getLatestRelease(repo, token);
	const { version: latestVersion, zipballUrl } = release;
	if (!latestVersion) {
		onStatus?.('Could not determine latest version');
		return { updated: false, reason: 'no_latest' };
	}
	onStatus?.(`Latest version ${latestVersion}`);
	if (!isNewerVersion(latestVersion, currentVersion)) {
		onStatus?.('Already up to date');
		return { updated: false, reason: 'up_to_date' };
	}
	if (appIsPackaged) {
		return await handlePackagedUpdate({ release, token, onStatus });
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


