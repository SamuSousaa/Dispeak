import {
  DESKTOP_CALL_ACTION,
  DESKTOP_SET_CALL_STATE,
  desktopCallStateSchema,
  type DesktopCallAction,
  type DesktopCallState,
} from '@frequencia/shared';
import { ipcMain, nativeImage, type BrowserWindow, type NativeImage } from 'electron';
import { config } from './config';
import { encodePng, rasterize, type Drawing } from './icons';
import { isAppUrl } from './navigation';

export const outsideCall: DesktopCallState = {
  channel: null,
  muted: false,
  deafened: false,
  speaking: false,
};

export interface CallControls {
  /** Called with every new state the page reports. Returns the function that stops listening. */
  subscribe(listener: (state: DesktopCallState) => void): () => void;
  current(): DesktopCallState;
  /** Asks the page to do something about the call. */
  act(action: DesktopCallAction): void;
}

/**
 * The page tells the app how the user is in a call (`setCallState`); the notification area
 * and the taskbar show it and send the user's clicks back (`onCallAction`).
 */
export function serveCallState(window: BrowserWindow): CallControls {
  const { webContents } = window;
  const listeners = new Set<(state: DesktopCallState) => void>();
  let state = outsideCall;

  const onState = (event: Electron.IpcMainEvent, payload: unknown) => {
    const frame = event.senderFrame;
    if (!frame || frame !== webContents.mainFrame || !isAppUrl(frame.url, config.appUrl)) return;
    const parsed = desktopCallStateSchema.safeParse(payload);
    if (!parsed.success) return;
    state = parsed.data;
    for (const listener of listeners) listener(state);
  };
  ipcMain.on(DESKTOP_SET_CALL_STATE, onState);
  // A reload drops the call: until the page says otherwise, there is none.
  webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    state = outsideCall;
    for (const listener of listeners) listener(state);
  });
  window.once('closed', () => ipcMain.removeListener(DESKTOP_SET_CALL_STATE, onState));

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current: () => state,
    act: (action) => {
      if (!webContents.isDestroyed()) webContents.send(DESKTOP_CALL_ACTION, { action });
    },
  };
}

/** Display scales Windows uses for small icons, and the side of the icon at each. */
const SCALES = [1, 1.25, 1.5, 2] as const;

/** A drawing as an image with a sharp version for every display scale. */
export function iconImage(drawing: Drawing, base = 16): NativeImage {
  const image = nativeImage.createEmpty();
  for (const scaleFactor of SCALES) {
    const size = Math.round(base * scaleFactor);
    const png = encodePng(rasterize(drawing, size), size);
    image.addRepresentation({
      scaleFactor,
      width: size,
      height: size,
      dataURL: `data:image/png;base64,${png.toString('base64')}`,
    });
  }
  return image;
}
