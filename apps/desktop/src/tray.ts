import {
  DESKTOP_SET_CLOSE_TO_TRAY,
  desktopCloseToTraySchema,
  type DesktopCallState,
} from '@frequencia/shared';
import { app, ipcMain, Menu, Tray, type BrowserWindow, type NativeImage } from 'electron';
import { iconImage, type CallControls } from './call-state';
import { config } from './config';
import { COLORS, markDrawing } from './icons';
import { isAppUrl } from './navigation';
import { trayLook, trayTooltip, type Look } from './tray-state';

/**
 * The icon in the notification area, always there like Discord's: it shows whether the user
 * is being heard, and its menu mutes, deafens, disconnects or quits. It also lets the page
 * decide what the window's close button does: with the option on, closing hides the window
 * and the app stays here, call included. Returns the function that puts the window in front.
 */
export function serveTray(window: BrowserWindow, call: CallControls): () => void {
  const { webContents } = window;
  let closeToTray = false;
  let quitting = false;

  const reveal = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  const icons = new Map<Look, NativeImage>();
  const iconFor = (look: Look) => {
    let icon = icons.get(look);
    if (!icon) {
      icon = iconImage(
        look === 'speaking'
          ? markDrawing(COLORS.accent)
          : markDrawing(COLORS.idle, look === 'muted'),
      );
      icons.set(look, icon);
    }
    return icon;
  };

  const tray = new Tray(iconFor('idle'));
  tray.on('click', reveal);

  let shownLook: Look | null = null;
  let menuKey = '';
  const render = (state: DesktopCallState) => {
    if (tray.isDestroyed()) return;
    const look = trayLook(state);
    if (look !== shownLook) {
      shownLook = look;
      tray.setImage(iconFor(look));
    }
    tray.setToolTip(trayTooltip(state));
    // The menu only changes with the call, not with every word spoken.
    const key = `${state.channel ?? ''}|${state.muted}|${state.deafened}`;
    if (key === menuKey) return;
    menuKey = key;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir o Dispeaker', click: reveal },
        { type: 'separator' },
        {
          label: 'Mutar microfone',
          type: 'checkbox',
          checked: state.muted,
          click: () => call.act('toggle-mute'),
        },
        {
          label: 'Desligar áudio',
          type: 'checkbox',
          checked: state.deafened,
          click: () => call.act('toggle-deafen'),
        },
        ...(state.channel
          ? [{ label: `Sair de ${state.channel}`, click: () => call.act('disconnect') }]
          : []),
        { type: 'separator' },
        {
          label: 'Configurações de voz',
          click: () => {
            reveal();
            call.act('voice-settings');
          },
        },
        { type: 'separator' },
        { label: 'Sair do Dispeaker', click: () => app.quit() },
      ]),
    );
  };
  render(call.current());
  const unsubscribe = call.subscribe(render);

  ipcMain.handle(DESKTOP_SET_CLOSE_TO_TRAY, (event, payload: unknown) => {
    const frame = event.senderFrame;
    if (!frame || frame !== webContents.mainFrame || !isAppUrl(frame.url, config.appUrl)) {
      throw new Error('forbidden');
    }
    closeToTray = desktopCloseToTraySchema.parse(payload).enabled;
  });

  // Quitting from the tray menu, an update installing or the system shutting down close for real.
  const onBeforeQuit = () => {
    quitting = true;
  };
  app.on('before-quit', onBeforeQuit);
  window.on('close', (event) => {
    if (!closeToTray || quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.once('closed', () => {
    app.off('before-quit', onBeforeQuit);
    ipcMain.removeHandler(DESKTOP_SET_CLOSE_TO_TRAY);
    unsubscribe();
    tray.destroy();
  });

  return reveal;
}
