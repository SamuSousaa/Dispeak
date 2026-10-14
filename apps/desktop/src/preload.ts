import {
  DESKTOP_GAME_AUDIO_DATA,
  DESKTOP_GAME_AUDIO_START,
  DESKTOP_GAME_AUDIO_STOP,
  DESKTOP_GET_UPDATE,
  DESKTOP_INSTALL_UPDATE,
  DESKTOP_NATIVE_CAPTURE_CHOOSE,
  DESKTOP_NATIVE_CAPTURE_ENDED,
  DESKTOP_NATIVE_CAPTURE_PROBE,
  DESKTOP_NATIVE_CAPTURE_START,
  DESKTOP_NATIVE_CAPTURE_STOP,
  DESKTOP_SET_CLOSE_TO_TRAY,
  DESKTOP_SET_SHORTCUTS,
  DESKTOP_SHORTCUT,
  DESKTOP_UPDATE_READY,
  desktopGameAudioSchema,
  desktopNativeCaptureChoiceSchema,
  desktopNativeCaptureProbeSchema,
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
  setCloseToTray: (enabled) =>
    ipcRenderer.invoke(DESKTOP_SET_CLOSE_TO_TRAY, { enabled }) as Promise<void>,
  nativeCapture: {
    probe: async () =>
      desktopNativeCaptureProbeSchema.parse(await ipcRenderer.invoke(DESKTOP_NATIVE_CAPTURE_PROBE))
        .codec,
    choose: async () =>
      desktopNativeCaptureChoiceSchema.parse(
        await ipcRenderer.invoke(DESKTOP_NATIVE_CAPTURE_CHOOSE),
      ),
    start: (options) => ipcRenderer.invoke(DESKTOP_NATIVE_CAPTURE_START, options) as Promise<void>,
    stop: () => ipcRenderer.invoke(DESKTOP_NATIVE_CAPTURE_STOP) as Promise<void>,
    onEnded: (listener) => {
      const handler = () => listener();
      ipcRenderer.on(DESKTOP_NATIVE_CAPTURE_ENDED, handler);
      return () => ipcRenderer.removeListener(DESKTOP_NATIVE_CAPTURE_ENDED, handler);
    },
  },
  gameAudio: {
    start: async () =>
      desktopGameAudioSchema.parse(await ipcRenderer.invoke(DESKTOP_GAME_AUDIO_START)),
    stop: () => ipcRenderer.invoke(DESKTOP_GAME_AUDIO_STOP) as Promise<void>,
    onData: (listener) => {
      const handler = (_event: unknown, payload: unknown) => {
        if (payload instanceof Uint8Array) listener(payload);
      };
      ipcRenderer.on(DESKTOP_GAME_AUDIO_DATA, handler);
      return () => ipcRenderer.removeListener(DESKTOP_GAME_AUDIO_DATA, handler);
    },
  },
};

contextBridge.exposeInMainWorld('dispeakerDesktop', bridge);
