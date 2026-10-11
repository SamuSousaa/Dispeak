import {
  DESKTOP_GET_UPDATE,
  DESKTOP_INSTALL_UPDATE,
  DESKTOP_UPDATE_READY,
  type DesktopUpdate,
} from '@frequencia/shared';
import { app, ipcMain, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { config } from './config';
import { isAppUrl } from './navigation';

// electron-updater is CommonJS: its named exports are only reachable through the default one.
const { autoUpdater } = electronUpdater;

/** First look shortly after the start, so it does not compete with the window loading. */
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 3 * 60 * 60 * 1000;

/**
 * Keeps the app up to date from our own server: `latest.yml` and the installers sit under
 * `config.updateUrl`. A newer version downloads in the background and installs when the app
 * closes; the page is told, so it can offer to restart right away.
 */
export function serveUpdates(window: BrowserWindow): void {
  const { webContents } = window;
  let ready: string | null = null;

  const fromApp = (event: Electron.IpcMainInvokeEvent) => {
    const frame = event.senderFrame;
    return Boolean(frame && frame === webContents.mainFrame && isAppUrl(frame.url, config.appUrl));
  };
  ipcMain.handle(DESKTOP_GET_UPDATE, (event): DesktopUpdate => {
    if (!fromApp(event)) throw new Error('forbidden');
    return { version: ready };
  });
  ipcMain.handle(DESKTOP_INSTALL_UPDATE, (event) => {
    if (!fromApp(event)) throw new Error('forbidden');
    // Silent install, then the app opens again.
    if (ready) autoUpdater.quitAndInstall(true, true);
  });
  window.once('closed', () => {
    ipcMain.removeHandler(DESKTOP_GET_UPDATE);
    ipcMain.removeHandler(DESKTOP_INSTALL_UPDATE);
  });

  // Running from the source tree there is nothing installed to update.
  if (!app.isPackaged) return;

  autoUpdater.setFeedURL({ provider: 'generic', url: config.updateUrl });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    ready = info.version;
    console.warn(`[desktop] update ${info.version} downloaded`);
    if (!webContents.isDestroyed()) {
      webContents.send(DESKTOP_UPDATE_READY, { version: info.version } satisfies DesktopUpdate);
    }
  });
  autoUpdater.on('error', (error) => {
    // Offline, or the server is down: the next check tries again.
    console.warn('[desktop] update check failed', error.message);
  });

  const check = () => {
    if (ready) return;
    void autoUpdater.checkForUpdates().catch(() => undefined);
  };
  setTimeout(check, FIRST_CHECK_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();
}
