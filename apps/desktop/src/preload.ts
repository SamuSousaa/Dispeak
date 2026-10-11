import {
  DESKTOP_GET_UPDATE,
  DESKTOP_INSTALL_UPDATE,
  DESKTOP_SET_SHORTCUTS,
  DESKTOP_SHORTCUT,
  DESKTOP_UPDATE_READY,
  desktopShortcutEventSchema,
  desktopUpdateSchema,
  type DesktopBridge,
  type DesktopShortcutsResult,
  type DesktopUpdate,
} from '@frequencia/shared';
import { contextBridge, ipcRenderer } from 'electron';

/** The main process passes the app version as an argument: a sandboxed preload cannot ask. */
const VERSION_ARGUMENT = '--dispeaker-version=';
const version =
  process.argv
    .find((argument) => argument.startsWith(VERSION_ARGUMENT))
    ?.slice(VERSION_ARGUMENT.length) ?? '';

const bridge: DesktopBridge = {
  version,
  setShortcuts: (bindings) =>
    ipcRenderer.invoke(DESKTOP_SET_SHORTCUTS, bindings) as Promise<DesktopShortcutsResult>,
  onShortcut: (listener) => {
    const handler = (_event: unknown, payload: unknown) => {
      const parsed = desktopShortcutEventSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data.action);
    };
    ipcRenderer.on(DESKTOP_SHORTCUT, handler);
    return () => ipcRenderer.removeListener(DESKTOP_SHORTCUT, handler);
  },
  getUpdate: () => ipcRenderer.invoke(DESKTOP_GET_UPDATE) as Promise<DesktopUpdate>,
  onUpdateReady: (listener) => {
    const handler = (_event: unknown, payload: unknown) => {
      const parsed = desktopUpdateSchema.safeParse(payload);
      if (parsed.success && parsed.data.version) listener(parsed.data.version);
    };
    ipcRenderer.on(DESKTOP_UPDATE_READY, handler);
    return () => ipcRenderer.removeListener(DESKTOP_UPDATE_READY, handler);
  },
  installUpdate: () => ipcRenderer.invoke(DESKTOP_INSTALL_UPDATE) as Promise<void>,
};

contextBridge.exposeInMainWorld('dispeakerDesktop', bridge);
