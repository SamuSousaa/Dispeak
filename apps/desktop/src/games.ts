import {
  DESKTOP_GAMES,
  DESKTOP_RUNNING_WINDOWS,
  DESKTOP_SHARE_WINDOW,
  DESKTOP_WATCH_GAMES,
  desktopShareWindowSchema,
  desktopWatchGamesSchema,
  hostGamesSchema,
  hostWindowsSchema,
  type DesktopGame,
  type RunningGame,
} from '@frequencia/shared';
import {
  app,
  desktopCapturer,
  ipcMain,
  type BrowserWindow,
  type DesktopCapturerSource,
} from 'electron';
import { config } from './config';
import { isAppUrl } from './navigation';
import { nativeHost } from './native-host';

/** A share asked for a given window starts this soon after, or it was something else. */
const SHARE_WINDOW_MS = 10_000;

let latest: RunningGame[] = [];
let added: string[] = [];
let pendingWindow: { handle: number; at: number } | null = null;
const icons = new Map<string, string | null>();

/** The program's icon as a data URL, asked of Windows once per program. */
export async function iconOf(path: string): Promise<string | null> {
  if (icons.has(path)) return icons.get(path) ?? null;
  const icon = await app
    .getFileIcon(path, { size: 'normal' })
    .then((image) => (image.isEmpty() ? null : image.toDataURL()))
    .catch(() => null);
  icons.set(path, icon);
  return icon;
}

/** The games running now: the ones last reported while watching, or asked for right away. */
export async function runningGames(): Promise<RunningGame[]> {
  if (nativeHost.available && latest.length === 0) {
    latest = await nativeHost.request('games', { added }, hostGamesSchema).catch(() => []);
  }
  return latest;
}

/** The window source of a game, as the screen capture names it (`window:<handle>:<n>`). */
export async function windowSource(handle: number): Promise<DesktopCapturerSource | null> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  return sources.find((source) => source.id.startsWith(`window:${handle}:`)) ?? null;
}

/** The window the page asked the next share to capture, used once. */
export async function takeShareWindow(): Promise<DesktopCapturerSource | null> {
  const pending = pendingWindow;
  pendingWindow = null;
  if (!pending || Date.now() - pending.at > SHARE_WINDOW_MS) return null;
  return windowSource(pending.handle);
}

/**
 * Tells the page which games are running, Discord-like, and lets it start a share of one of
 * them without the picker.
 */
export function serveGames(window: BrowserWindow): void {
  if (!nativeHost.available) return;
  const { webContents } = window;
  const fromApp = (event: Electron.IpcMainInvokeEvent) => {
    const frame = event.senderFrame;
    if (!frame || frame !== webContents.mainFrame || !isAppUrl(frame.url, config.appUrl)) {
      throw new Error('forbidden');
    }
  };

  const stopListening = nativeHost.on('games', hostGamesSchema, (games) => {
    latest = games;
    void Promise.all(
      games.map(async (game): Promise<DesktopGame> => ({ ...game, icon: await iconOf(game.path) })),
    ).then((withIcons) => {
      if (!webContents.isDestroyed()) webContents.send(DESKTOP_GAMES, withIcons);
    });
  });

  ipcMain.handle(DESKTOP_WATCH_GAMES, (event, payload: unknown) => {
    fromApp(event);
    const request = desktopWatchGamesSchema.parse(payload);
    added = request.added;
    latest = [];
    return nativeHost.watch('watchGames', request.on ? { on: true, added } : null);
  });
  ipcMain.handle(DESKTOP_SHARE_WINDOW, (event, payload: unknown) => {
    fromApp(event);
    pendingWindow = {
      handle: desktopShareWindowSchema.parse(payload).windowHandle,
      at: Date.now(),
    };
  });
  ipcMain.handle(DESKTOP_RUNNING_WINDOWS, async (event) => {
    fromApp(event);
    return nativeHost.request('windows', {}, hostWindowsSchema);
  });
  webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) void nativeHost.watch('watchGames', null);
  });
  window.once('closed', () => {
    stopListening();
    void nativeHost.watch('watchGames', null);
    for (const channel of [DESKTOP_WATCH_GAMES, DESKTOP_SHARE_WINDOW, DESKTOP_RUNNING_WINDOWS]) {
      ipcMain.removeHandler(channel);
    }
  });
}
