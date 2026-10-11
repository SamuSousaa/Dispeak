import {
  DESKTOP_SET_SHORTCUTS,
  DESKTOP_SHORTCUT,
  desktopShortcutEventSchema,
  type DesktopBridge,
  type DesktopShortcutsResult,
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
};

contextBridge.exposeInMainWorld('dispeakerDesktop', bridge);
