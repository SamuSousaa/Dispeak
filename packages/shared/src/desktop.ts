import { z } from 'zod';
import { ingestCodecSchema, voiceIngestSchema, type IngestCodec } from './signaling/voice';

/**
 * What the desktop app (Electron) and the web page it shows say to each other. The page is the
 * same one a browser gets; `window.dispeakerDesktop` exists only inside the app.
 */

/** Page → app: the shortcuts that should work while another program has the focus. */
export const DESKTOP_SET_SHORTCUTS = 'desktop:set-shortcuts';
/** App → page: one of those shortcuts was pressed. */
export const DESKTOP_SHORTCUT = 'desktop:shortcut';

/** Page → app: is a downloaded update waiting? */
export const DESKTOP_GET_UPDATE = 'desktop:get-update';
/** App → page: an update finished downloading and installs on the next start. */
export const DESKTOP_UPDATE_READY = 'desktop:update-ready';
/** Page → app: restart now and install it. */
export const DESKTOP_INSTALL_UPDATE = 'desktop:install-update';

/** Page → app: whether the window's close button hides the app in the notification area. */
export const DESKTOP_SET_CLOSE_TO_TRAY = 'desktop:set-close-to-tray';

/** Page → app: the codec this machine's native capture would send, if it has one. */
export const DESKTOP_NATIVE_CAPTURE_PROBE = 'desktop:native-capture-probe';
/** Page → app: ask the user what to share and say which capture it is for. */
export const DESKTOP_NATIVE_CAPTURE_CHOOSE = 'desktop:native-capture-choose';
/** Page → app: capture the screen and send it to this ingest, replacing a running capture. */
export const DESKTOP_NATIVE_CAPTURE_START = 'desktop:native-capture-start';
/** Page → app: stop the running capture. */
export const DESKTOP_NATIVE_CAPTURE_STOP = 'desktop:native-capture-stop';
/** App → page: the capture stopped on its own. */
export const DESKTOP_NATIVE_CAPTURE_ENDED = 'desktop:native-capture-ended';

/** Page → app: capture the sound of the program being shared, if one can be told apart. */
export const DESKTOP_GAME_AUDIO_START = 'desktop:game-audio-start';
/** Page → app: stop that capture. */
export const DESKTOP_GAME_AUDIO_STOP = 'desktop:game-audio-stop';
/** App → page: a piece of that sound, 48 kHz stereo signed 16-bit PCM. */
export const DESKTOP_GAME_AUDIO_DATA = 'desktop:game-audio-data';

/**
 * The action that starts or stops a screen share. The app treats it apart: pressed with a game
 * in front, the share captures that game without asking what to share.
 */
export const DESKTOP_SHARE_ACTION = 'share';

/** Action name → binding, in the page's own notation (`Ctrl+Shift+M`, `F9`). */
export const desktopShortcutsSchema = z
  .record(z.string().min(1).max(32), z.string().min(1).max(48))
  .refine((bindings) => Object.keys(bindings).length <= 16, 'too many shortcuts');
export type DesktopShortcuts = z.infer<typeof desktopShortcutsSchema>;

/** Actions whose shortcut the system refused (taken by another program, or not a valid key). */
export const desktopShortcutsResultSchema = z.object({ failed: z.array(z.string()) });
export type DesktopShortcutsResult = z.infer<typeof desktopShortcutsResultSchema>;

export const desktopShortcutEventSchema = z.object({ action: z.string().min(1).max(32) });

/** The version waiting to be installed, or `null` when the app is up to date. */
export const desktopUpdateSchema = z.object({ version: z.string().min(1).max(32).nullable() });
export type DesktopUpdate = z.infer<typeof desktopUpdateSchema>;

export const desktopCloseToTraySchema = z.object({ enabled: z.boolean() });

export const desktopNativeCaptureProbeSchema = z.object({ codec: ingestCodecSchema.nullable() });

/**
 * What the user picked for a share: something the app captures itself (`native`: a monitor,
 * or a window that covers one), something only the browser's capture can show (`browser`: any
 * other window; the app hands it over without asking again), or nothing.
 */
export const desktopNativeCaptureChoiceSchema = z.enum(['native', 'browser', 'cancelled']);
export type DesktopNativeCaptureChoice = z.infer<typeof desktopNativeCaptureChoiceSchema>;

export const desktopNativeCaptureStartSchema = z.object({
  ingest: voiceIngestSchema,
  codec: ingestCodecSchema,
  frameRate: z.number().int().min(1).max(120),
  /** Bits per second. */
  bitrate: z.number().int().min(100_000).max(50_000_000),
});
export type DesktopNativeCaptureStart = z.infer<typeof desktopNativeCaptureStartSchema>;

/**
 * The app capturing and encoding the screen on the graphics card, outside the browser, and
 * sending it to an ingest of the media service. Experimental: a whole monitor, video only.
 */
export interface DesktopNativeCapture {
  /** The codec this machine would send, or `null` when it cannot capture natively. */
  probe(): Promise<IngestCodec | null>;
  /**
   * Shows the app's picker; `start` then captures what was picked. Absent in apps older than
   * 0.9.0, which capture the main monitor without asking.
   */
  choose?(): Promise<DesktopNativeCaptureChoice>;
  start(options: DesktopNativeCaptureStart): Promise<void>;
  stop(): Promise<void>;
  /** Called when the capture stops on its own. Returns the function that stops listening. */
  onEnded(listener: () => void): () => void;
}

/**
 * What is being captured: one program (`name`), or everything that plays except voice chats
 * (`name: null`). `null` when the app cannot capture sound itself.
 */
export const desktopGameAudioSchema = z.object({ name: z.string().max(200).nullable() }).nullable();
export type DesktopGameAudioSource = z.infer<typeof desktopGameAudioSchema>;

/**
 * The sound of a share without voice chats: the program of the window picked for it or, when a
 * whole screen is shared, the program covering one (a game, in practice); failing that,
 * everything that plays except voice chats (Discord, this app).
 */
export interface DesktopGameAudio {
  /** Starts the capture, replacing a running one. `null`: share the system's sound instead. */
  start(): Promise<DesktopGameAudioSource>;
  stop(): Promise<void>;
  /** Pieces of 48 kHz stereo signed 16-bit PCM. Returns the function that stops listening. */
  onData(listener: (pcm: Uint8Array) => void): () => void;
}

/** `window.dispeakerDesktop`, as exposed by the app's preload script. */
export interface DesktopBridge {
  version: string;
  /** Replaces the registered shortcuts; an empty object removes them all. */
  setShortcuts(bindings: DesktopShortcuts): Promise<DesktopShortcutsResult>;
  /** Returns the function that stops listening. */
  onShortcut(listener: (action: string) => void): () => void;
  /** The update that is already downloaded, if any. */
  getUpdate(): Promise<DesktopUpdate>;
  /** Called when an update finishes downloading. Returns the function that stops listening. */
  onUpdateReady(listener: (version: string) => void): () => void;
  /** Closes the app, installs the downloaded update and opens it again. */
  installUpdate(): Promise<void>;
  /**
   * Whether closing the window keeps the app running in the notification area instead of
   * quitting. Absent in apps older than 0.6.0.
   */
  setCloseToTray?(enabled: boolean): Promise<void>;
  /** Absent in apps older than 0.7.0; its `probe` answers `null` where the experiment is off. */
  nativeCapture?: DesktopNativeCapture;
  /** Absent in apps older than 0.8.0; the mix without voice chats needs 0.10.0. */
  gameAudio?: DesktopGameAudio;
}

/**
 * Whether a binding may be registered system-wide. A global shortcut takes its key away from
 * every other program, so a bare letter would stop being typed anywhere: only chords with Ctrl
 * or Alt and the function keys qualify.
 */
export function isGlobalBinding(binding: string): boolean {
  const parts = binding.split('+');
  const key = parts.at(-1) ?? '';
  return parts.includes('Ctrl') || parts.includes('Alt') || /^F([1-9]|1\d|2[0-4])$/.test(key);
}
