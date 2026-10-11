import { app, desktopCapturer, type DesktopCapturerSource } from 'electron';
import { foregroundWindow, type ForegroundWindow } from './foreground-window';

/** A share that follows the shortcut later than this was started some other way. */
const SHORTCUT_WINDOW_MS = 10_000;

let noted: { at: number; front: Promise<ForegroundWindow | null> } | null = null;

/**
 * Remembers which window was in front when the share shortcut was pressed. It has to be asked
 * right then: by the time the page asks for the screen, focus may have moved.
 */
export function noteShareShortcut(): void {
  noted = { at: Date.now(), front: foregroundWindow() };
}

export interface ShortcutShare {
  /** The game to capture, when one was in front: no picker is shown then. */
  source: DesktopCapturerSource | null;
}

/**
 * How to serve a request for the screen: `null` when it did not come from the shortcut.
 * Otherwise the window that was in front, if it covered its whole screen and is not ours —
 * a game, in practice. Each press of the shortcut is used once.
 */
export async function takeShortcutShare(): Promise<ShortcutShare | null> {
  const current = noted;
  noted = null;
  if (!current || Date.now() - current.at > SHORTCUT_WINDOW_MS) return null;
  const front = await current.front;
  if (!front?.coversScreen) return { source: null };
  const own = new Set([process.pid, ...app.getAppMetrics().map((metric) => metric.pid)]);
  if (own.has(front.processId)) return { source: null };
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  // On Windows a window source is named `window:<handle>:<n>`.
  const prefix = `window:${front.handle}:`;
  return { source: sources.find((source) => source.id.startsWith(prefix)) ?? null };
}
