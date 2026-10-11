import {
  DESKTOP_SET_SHORTCUTS,
  DESKTOP_SHORTCUT,
  desktopShortcutsSchema,
  isGlobalBinding,
  type DesktopShortcutsResult,
} from '@frequencia/shared';
import { globalShortcut, ipcMain, type BrowserWindow } from 'electron';
import { config } from './config';
import { isAppUrl } from './navigation';

/** Keys whose name in the page's notation differs from Electron's accelerators. */
const KEY_NAMES: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
};
const NAMED_KEYS = new Set([
  'Space',
  'Tab',
  'Enter',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Up',
  'Down',
  'Left',
  'Right',
  'Esc',
]);
const MODIFIERS: Record<string, string> = { Ctrl: 'Control', Alt: 'Alt', Shift: 'Shift' };

/**
 * The Electron accelerator for a binding written by the page (`Ctrl+Shift+M`), or `null` when
 * it cannot be a global shortcut: an unknown key, or one that would swallow ordinary typing.
 */
export function toAccelerator(binding: string): string | null {
  if (!isGlobalBinding(binding)) return null;
  const parts = binding.split('+');
  const rawKey = parts.pop() ?? '';
  const key = KEY_NAMES[rawKey] ?? rawKey;
  const known = /^[A-Z0-9]$/.test(key) || /^F([1-9]|1\d|2[0-4])$/.test(key) || NAMED_KEYS.has(key);
  if (!known) return null;
  const modifiers = parts.map((part) => MODIFIERS[part]);
  if (modifiers.some((modifier) => modifier === undefined)) return null;
  return [...modifiers, key].join('+');
}

/**
 * Lets the page register shortcuts that work while a game has the focus, and tells it when
 * one is pressed. Only the app's own page, in the main frame of `window`, is listened to.
 */
export function serveShortcuts(window: BrowserWindow): void {
  const { webContents } = window;
  const clear = () => globalShortcut.unregisterAll();

  ipcMain.handle(DESKTOP_SET_SHORTCUTS, (event, payload: unknown): DesktopShortcutsResult => {
    const frame = event.senderFrame;
    if (!frame || frame !== webContents.mainFrame || !isAppUrl(frame.url, config.appUrl)) {
      throw new Error('forbidden');
    }
    const bindings = desktopShortcutsSchema.parse(payload);
    clear();
    const failed: string[] = [];
    for (const [action, binding] of Object.entries(bindings)) {
      const accelerator = toAccelerator(binding);
      const registered =
        accelerator !== null &&
        globalShortcut.register(accelerator, () => {
          if (!webContents.isDestroyed()) webContents.send(DESKTOP_SHORTCUT, { action });
        });
      if (!registered) failed.push(action);
    }
    return { failed };
  });

  // A page that reloads or leaves registers again; nothing may outlive the page that asked.
  webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) clear();
  });
  window.once('closed', () => {
    clear();
    ipcMain.removeHandler(DESKTOP_SET_SHORTCUTS);
  });
}
