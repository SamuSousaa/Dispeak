import path from 'node:path';
import { DESKTOP_SHARE_ACTION } from '@frequencia/shared';
import { app, BrowserWindow, session, shell } from 'electron';
import { config } from './config';
import { showDiagnostics } from './diagnostics';
import { isAppUrl, isExternalLink } from './navigation';
import { applyBackgroundSwitches, keepProcessesResponsive } from './performance';
import { pickSource } from './picker/picker';
import { noteShareShortcut, takeShortcutShare } from './share-target';
import { serveShortcuts } from './shortcuts';
import { serveUpdates } from './updater';

/** What the web app may ask the operating system for. Everything else is refused. */
const PERMISSIONS = new Set([
  'media',
  'display-capture',
  'notifications',
  'fullscreen',
  'clipboard-sanitized-write',
  'speaker-selection',
]);

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 480,
    show: false,
    backgroundColor: '#0a0a0a',
    title: 'Dispeaker',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      additionalArguments: [`--dispeaker-version=${app.getVersion()}`],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The call goes on while a game covers the window.
      backgroundThrottling: false,
    },
  });
  window.removeMenu();
  window.once('ready-to-show', () => window.show());

  const { webContents } = window;
  // The window shows the app and nothing else; other links go to the default browser.
  webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url, config.appUrl)) return;
    event.preventDefault();
    if (isExternalLink(url)) void shell.openExternal(url);
  });
  // Without a menu there are no accelerators: reload and the developer tools by hand.
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const reload = input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r');
    if (reload) {
      event.preventDefault();
      if (input.shift || input.control) webContents.reloadIgnoringCache();
      else webContents.reload();
    } else if (input.key === 'F12') {
      event.preventDefault();
      webContents.toggleDevTools();
    } else if (input.control && input.shift && input.key.toLowerCase() === 'd') {
      event.preventDefault();
      void showDiagnostics(window);
    }
  });

  serveShortcuts(window, (action) => {
    if (action === DESKTOP_SHARE_ACTION) noteShareShortcut();
  });
  serveUpdates(window);
  if (config.devtools) webContents.openDevTools({ mode: 'detach' });
  void window.loadURL(config.appUrl.href);
  return window;
}

function configureSession(): void {
  const { defaultSession } = session;
  const fromApp = (url: string | undefined) => url !== undefined && isAppUrl(url, config.appUrl);

  defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(fromApp(webContents.getURL()) && PERMISSIONS.has(permission));
  });
  defaultSession.setPermissionCheckHandler(
    (_webContents, permission, origin) => fromApp(origin) && PERMISSIONS.has(permission),
  );

  // `getDisplayMedia` in the page ends up here: the game in front when the shortcut asked,
  // our picker otherwise, then the system's audio with it.
  defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const window = mainWindow;
    if (!window || !fromApp(request.securityOrigin)) {
      callback({});
      return;
    }
    const choose = async () => {
      const shortcut = await takeShortcutShare();
      return shortcut?.source ?? pickSource(window, { detached: shortcut !== null });
    };
    void choose().then(
      (source) => {
        if (!source) callback({});
        else callback({ video: source, ...(request.audioRequested ? { audio: 'loopback' } : {}) });
      },
      (error: unknown) => {
        console.error('[desktop] screen picker failed', error);
        callback({});
      },
    );
  });
}

applyBackgroundSwitches();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => app.quit());

  void app.whenReady().then(() => {
    configureSession();
    mainWindow = createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    keepProcessesResponsive();
  });
}
