import path from 'node:path';
import { BrowserWindow, desktopCapturer, type DesktopCapturerSource } from 'electron';
import { PICKER_CHOOSE, PICKER_SOURCES, type PickerSource } from './protocol';

const here = import.meta.dirname;

/**
 * Asks the user what to capture, in a window of our own: Electron has no screen picker.
 * Resolves with `null` when the user cancels or closes it. `detached` shows it on its own,
 * above whatever is in front, instead of bringing the app's window forward with it: for a
 * share started by a shortcut while another program has the focus.
 */
export async function pickSource(
  parent: BrowserWindow,
  { detached = false }: { detached?: boolean } = {},
): Promise<DesktopCapturerSource | null> {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 400, height: 225 },
  });
  // The picker itself and windows without a picture (minimised ones) are not worth offering.
  const offered = sources.filter(
    (source) => source.id.startsWith('screen:') || !source.thumbnail.isEmpty(),
  );
  const listed: PickerSource[] = offered.map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: source.thumbnail.toDataURL(),
  }));

  const window = new BrowserWindow({
    ...(detached ? { alwaysOnTop: true, center: true } : { parent, modal: true }),
    width: 760,
    height: 560,
    minimizable: false,
    maximizable: false,
    show: false,
    backgroundColor: '#0a0a0a',
    title: 'Transmitir',
    webPreferences: {
      preload: path.join(here, 'picker-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.removeMenu();

  return new Promise((resolve) => {
    let chosen: DesktopCapturerSource | null = null;
    // Scoped to this window's page: no other page can list or pick sources.
    window.webContents.ipc.handle(PICKER_SOURCES, () => listed);
    window.webContents.ipc.on(PICKER_CHOOSE, (_event, id: unknown) => {
      chosen = offered.find((source) => source.id === id) ?? null;
      window.close();
    });
    window.once('closed', () => resolve(chosen));
    window.once('ready-to-show', () => window.show());
    void window.loadFile(path.join(here, '..', 'static', 'picker.html'));
  });
}
