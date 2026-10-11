import { z } from 'zod';

/**
 * What the desktop app (Electron) and the web page it shows say to each other. The page is the
 * same one a browser gets; `window.dispeakerDesktop` exists only inside the app.
 */

/** Page → app: the shortcuts that should work while another program has the focus. */
export const DESKTOP_SET_SHORTCUTS = 'desktop:set-shortcuts';
/** App → page: one of those shortcuts was pressed. */
export const DESKTOP_SHORTCUT = 'desktop:shortcut';

/** Action name → binding, in the page's own notation (`Ctrl+Shift+M`, `F9`). */
export const desktopShortcutsSchema = z
  .record(z.string().min(1).max(32), z.string().min(1).max(48))
  .refine((bindings) => Object.keys(bindings).length <= 16, 'too many shortcuts');
export type DesktopShortcuts = z.infer<typeof desktopShortcutsSchema>;

/** Actions whose shortcut the system refused (taken by another program, or not a valid key). */
export const desktopShortcutsResultSchema = z.object({ failed: z.array(z.string()) });
export type DesktopShortcutsResult = z.infer<typeof desktopShortcutsResultSchema>;

export const desktopShortcutEventSchema = z.object({ action: z.string().min(1).max(32) });

/** `window.dispeakerDesktop`, as exposed by the app's preload script. */
export interface DesktopBridge {
  version: string;
  /** Replaces the registered shortcuts; an empty object removes them all. */
  setShortcuts(bindings: DesktopShortcuts): Promise<DesktopShortcutsResult>;
  /** Returns the function that stops listening. */
  onShortcut(listener: (action: string) => void): () => void;
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
