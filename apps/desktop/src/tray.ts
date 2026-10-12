import path from 'node:path';
import { DESKTOP_SET_CLOSE_TO_TRAY, desktopCloseToTraySchema } from '@frequencia/shared';
import { app, ipcMain, Menu, nativeImage, Tray, type BrowserWindow } from 'electron';
import { config } from './config';
import { isAppUrl } from './navigation';

/**
 * Lets the page decide what the window's close button does. With the option on, closing hides
 * the window and the app stays in the notification area, call included; the icon there brings
 * it back or quits for real. Returns the function that puts the window in front again.
 */
export function serveCloseToTray(window: BrowserWindow): () => void {
  const { webContents } = window;
  let enabled = false;
  let quitting = false;
  let tray: Tray | null = null;

  const reveal = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  const setTray = (wanted: boolean) => {
    if (!wanted) {
      tray?.destroy();
      tray = null;
      return;
    }
    if (tray) return;
    const icon = nativeImage
      .createFromPath(path.join(import.meta.dirname, '..', 'build', 'icon.png'))
      .resize({ width: 32, height: 32, quality: 'best' });
    tray = new Tray(icon);
    tray.setToolTip('Dispeaker');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir o Dispeaker', click: reveal },
        { type: 'separator' },
        { label: 'Sair', click: () => app.quit() },
      ]),
    );
    tray.on('click', reveal);
  };

  ipcMain.handle(DESKTOP_SET_CLOSE_TO_TRAY, (event, payload: unknown) => {
    const frame = event.senderFrame;
    if (!frame || frame !== webContents.mainFrame || !isAppUrl(frame.url, config.appUrl)) {
      throw new Error('forbidden');
    }
    enabled = desktopCloseToTraySchema.parse(payload).enabled;
    setTray(enabled);
  });

  // Quitting from the tray menu, an update installing or the system shutting down close for real.
  const onBeforeQuit = () => {
    quitting = true;
  };
  app.on('before-quit', onBeforeQuit);
  window.on('close', (event) => {
    if (!enabled || quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.once('closed', () => {
    app.off('before-quit', onBeforeQuit);
    ipcMain.removeHandler(DESKTOP_SET_CLOSE_TO_TRAY);
    setTray(false);
  });

  return reveal;
}
