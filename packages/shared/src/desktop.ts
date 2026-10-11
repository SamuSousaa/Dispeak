import { z } from 'zod';

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
