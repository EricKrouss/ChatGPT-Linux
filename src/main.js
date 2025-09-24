import { app, BrowserWindow, shell, session, Menu, nativeTheme, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkForUpdates } from './updater.js';

const CHATGPT_URL = 'https://chat.openai.com/';
const CHATGPT_ALT_URL = 'https://chatgpt.com/';
const AUTH_URL = 'https://auth.openai.com/';
const PLATFORM_URL = 'https://platform.openai.com/';
const APPLE_AUTH_URLS = [
	'https://appleid.apple.com/',
	'https://idmsa.apple.com/',
	'https://appleid.cdn-apple.com/'
];
const GOOGLE_AUTH_URLS = [
	'https://accounts.google.com/',
	'https://ssl.gstatic.com/',
	'https://clients6.google.com/',
	'https://apis.google.com/',
	'https://*.googleusercontent.com/'
];
const MS_AUTH_URLS = [
	'https://login.microsoftonline.com/',
	'https://login.live.com/',
	'https://aadcdn.msftauth.net/',
	'https://aadcdn.msauth.net/',
	'https://*.microsoftonline.com/'
];
const GITHUB_AUTH_URLS = [
	'https://github.com/login',
	'https://github.com/session',
	'https://github.com/sessions',
	'https://api.github.com/',
	'https://githubusercontent.com/',
	'https://avatars.githubusercontent.com/'
];
const ALLOWED_INTERNAL_URL_PREFIXES = [
	CHATGPT_URL,
	CHATGPT_ALT_URL,
	AUTH_URL,
	PLATFORM_URL,
	...APPLE_AUTH_URLS,
	...GOOGLE_AUTH_URLS,
	...MS_AUTH_URLS,
	...GITHUB_AUTH_URLS
];
const SESSION_PARTITION = 'persist:chatgpt';
const CHROME_LINUX_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
	'Chrome/127.0.0.0 Safari/537.36';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRELOAD_PATH = path.join(__dirname, 'preload.js');

/**
 * Create the main application window.
 */
function createMainWindow() {
	const ses = session.fromPartition(SESSION_PARTITION);
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 900,
		minHeight: 600,
		title: 'ChatGPT',
		backgroundColor: '#1f1f1f',
		webPreferences: {
			preload: PRELOAD_PATH,
			contextIsolation: true,
			nodeIntegration: false,
			spellcheck: true,
			defaultEncoding: 'utf-8',
			webviewTag: false,
			sandbox: true,
			partition: SESSION_PARTITION,
			nativeWindowOpen: true
		}
	});

	// Use a mainstream Chrome user agent to avoid auth/session quirks
	win.webContents.setUserAgent(CHROME_LINUX_UA);

	// Basic safe navigation policy
	const filter = { urls: ['*://*/*'] };
	ses.webRequest.onBeforeRequest(filter, (details, callback) => {
		const { url } = details;
		if (url.startsWith('file:')) {
			return callback({ cancel: true });
		}
		callback({ cancel: false });
	});

	// Open external links in the default browser
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (ALLOWED_INTERNAL_URL_PREFIXES.some(prefix => url.startsWith(prefix))) {
			return {
				action: 'allow',
				overrideBrowserWindowOptions: {
					parent: win,
					modal: true,
					width: 520,
					height: 640,
					alwaysOnTop: true,
					useContentSize: true,
					center: true,
					darkTheme: false,
					webPreferences: {
						preload: PRELOAD_PATH,
						partition: SESSION_PARTITION,
						contextIsolation: true,
						nodeIntegration: false,
						sandbox: true,
						nativeWindowOpen: true
					}
				}
			};
		}
		shell.openExternal(url);
		return { action: 'deny' };
	});

	win.webContents.on('will-navigate', (event, url) => {
		if (!ALLOWED_INTERNAL_URL_PREFIXES.some(prefix => url.startsWith(prefix))) {
			event.preventDefault();
			shell.openExternal(url);
		}
	});

	win.webContents.on('will-redirect', (event, url) => {
		if (!ALLOWED_INTERNAL_URL_PREFIXES.some(prefix => url.startsWith(prefix))) {
			event.preventDefault();
			shell.openExternal(url);
		}
	});

// For Apple auth windows, emulate prefers-color-scheme: light per-window (no app-wide override)
win.webContents.on('did-create-window', (child, details) => {
	child.webContents.setUserAgent(CHROME_LINUX_UA);
	const createdUrl = details?.url || '';
	const applyAppleLightScheme = (target) => {
		try {
			if (!target.debugger.isAttached()) {
				target.debugger.attach('1.3');
			}
			target.debugger.sendCommand('Emulation.setEmulatedMedia', {
				features: [{ name: 'prefers-color-scheme', value: 'light' }]
			});
		} catch {}
	};
	if (APPLE_AUTH_URLS.some(prefix => createdUrl.startsWith(prefix))) {
		applyAppleLightScheme(child.webContents);
		const inject = () => {
			child.webContents.insertCSS(
				`:root{color-scheme: light !important}` +
				`@media (prefers-color-scheme: dark){:root{color-scheme: light !important}}`
			);
		};
		child.webContents.once('dom-ready', inject);
		child.webContents.once('did-finish-load', inject);
	}
	child.webContents.on('did-start-navigation', (_ev, navUrl) => {
		if (APPLE_AUTH_URLS.some(prefix => navUrl.startsWith(prefix))) {
			applyAppleLightScheme(child.webContents);
		}
	});
});

	// Close auth modal when redirected back to ChatGPT domain
	app.on('web-contents-created', (_e, contents) => {
		contents.on('did-navigate', (_ev, navUrl) => {
			if (navUrl.startsWith(CHATGPT_URL) || navUrl.startsWith(CHATGPT_ALT_URL)) {
				const childWindow = BrowserWindow.fromWebContents(contents);
				if (childWindow && childWindow !== win && childWindow.getParentWindow() === win) {
					childWindow.close();
					win.loadURL(navUrl);
				}
			}
		});
	});

	// Minimal application menu with copy/paste for Linux
	const isMac = process.platform === 'darwin';
	const template = [
		...(isMac ? [{ role: 'appMenu' }] : []),
		{ role: 'fileMenu' },
		{ role: 'editMenu' },
		{ role: 'viewMenu' },
		{
			label: 'Help',
			submenu: [
				{
					label: 'Check for Updates…',
					click: async () => {
						const appRoot = app.getAppPath();
						const lines = [];
						const onStatus = (m) => lines.push(m);
						try {
							const result = await checkForUpdates({ appRoot, onStatus });
							if (result.updated) {
								lines.push(`Updated to ${result.latestVersion}. Please restart.`);
							} else {
								lines.push(`No update applied (${result.reason}).`);
							}
						} catch (e) {
							lines.push(`Error: ${e.message}`);
						}
						dialog.showMessageBox({
							type: 'info',
							title: 'Updater',
							message: 'Update Check',
							detail: lines.join('\n')
						});
					}
				}
			]
		},
		{ role: 'windowMenu' }
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));

	win.loadURL(CHATGPT_URL);
	return win;
}

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on('second-instance', () => {
		const all = BrowserWindow.getAllWindows();
		if (all.length) {
			const win = all[0];
			if (win.isMinimized()) win.restore();
			win.focus();
		}
	});
}

app.whenReady().then(() => {
	// Respect the OS color scheme for correct provider theming
	nativeTheme.themeSource = 'system';
	// Ensure all new WebContents (child windows, popups) use our UA
	app.on('web-contents-created', (_event, contents) => {
		contents.setUserAgent(CHROME_LINUX_UA);
	});
	createMainWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createMainWindow();
		}
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});


