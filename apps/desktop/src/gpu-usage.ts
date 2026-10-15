import {
  DESKTOP_GPU_USAGE,
  DESKTOP_WATCH_GPU_USAGE,
  desktopWatchGpuUsageSchema,
  hostGpuSchema,
  type DesktopGpuUsage,
} from '@frequencia/shared';
import { ipcMain, type BrowserWindow } from 'electron';
import { config } from './config';
import { foldEngines } from './gpu-engines';
import { isAppUrl } from './navigation';
import { nativeHost } from './native-host';

/**
 * How busy the graphics card is, engine by engine, for the app (with the capture engine and
 * any other program it started) and for the whole machine. The "GPU" column of the Task
 * Manager is the busiest engine; a stream mostly loads the video engines, a game the 3D one,
 * and only this split says which of the two a heavy stream competes with.
 *
 * The app's Windows helper reads the performance counters every two seconds, only while the
 * page asks (a stream shared or watched).
 */
export function serveGpuUsage(window: BrowserWindow): void {
  if (process.platform !== 'win32') return;
  const { webContents } = window;

  const stopListening = nativeHost.on('gpu', hostGpuSchema, (tables) => {
    if (webContents.isDestroyed()) return;
    const usage: DesktopGpuUsage = { app: foldEngines(tables.app), all: foldEngines(tables.all) };
    webContents.send(DESKTOP_GPU_USAGE, usage);
  });
  const watch = (on: boolean) =>
    nativeHost
      .watch('watchGpu', on ? { on: true, root: process.pid } : null)
      .catch((error: unknown) => console.warn('[gpu] could not measure', error));

  ipcMain.handle(DESKTOP_WATCH_GPU_USAGE, (event, payload: unknown) => {
    const frame = event.senderFrame;
    if (!frame || frame !== webContents.mainFrame || !isAppUrl(frame.url, config.appUrl)) {
      throw new Error('forbidden');
    }
    void watch(desktopWatchGpuUsageSchema.parse(payload).on);
  });
  // A reload forgets what it asked for.
  webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) void watch(false);
  });
  window.once('closed', () => {
    stopListening();
    void watch(false);
    ipcMain.removeHandler(DESKTOP_WATCH_GPU_USAGE);
  });
}
