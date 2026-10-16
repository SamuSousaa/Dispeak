import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  DESKTOP_GAME_AUDIO_DATA,
  DESKTOP_GAME_AUDIO_START,
  DESKTOP_GAME_AUDIO_STOP,
  type DesktopGameAudioSource,
} from '@frequencia/shared';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { findBundled } from './bundled';
import { config } from './config';
import { isAppUrl } from './navigation';

/** How long the helper gets to say which program it captures. */
const START_TIMEOUT_MS = 6000;
/** Stereo, 16 bits: a piece handed to the page never splits a frame. */
const FRAME_BYTES = 4;

/** The first line the helper writes: the program it found, or that it mixes several. */
const startedSchema = z.union([
  z.object({ processId: z.number().int().positive(), name: z.string() }),
  z.object({ mix: z.literal(true) }),
]);

/**
 * The sound of a share without the voice chats: the app's Windows helper, run as
 * `dispeaker-host audio` (`native/host/src/audio.rs`), asks Windows for the audio of process
 * trees and writes it out as PCM, which goes to the page piece by piece. It is the program of the window picked for the
 * share (`pickedWindow`) or, for a whole screen, the one covering a monitor; without one,
 * everything that plays except voice chats (Discord, this app). On a Windows too old for it,
 * the page shares the system's sound.
 */
export function serveGameAudio(window: BrowserWindow, pickedWindow: () => string | null): void {
  const { webContents } = window;
  let current: ChildProcessWithoutNullStreams | null = null;

  const assertFromApp = (event: Electron.IpcMainInvokeEvent) => {
    const frame = event.senderFrame;
    if (!frame || frame !== webContents.mainFrame || !isAppUrl(frame.url, config.appUrl)) {
      throw new Error('forbidden');
    }
  };

  const stop = () => {
    const child = current;
    current = null;
    child?.kill();
  };

  const start = (helper: string): Promise<DesktopGameAudioSource> => {
    const handle = pickedWindow();
    const own = [process.pid, ...app.getAppMetrics().map((metric) => metric.pid)];
    const child = spawn(
      helper,
      [
        'audio',
        ...(handle ? ['--window', handle] : ['--covering']),
        ...['--or-mix', '--exclude', own.join(',')],
      ],
      { windowsHide: true },
    );
    current = child;

    let rest: Buffer = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => {
      if (current !== child || webContents.isDestroyed()) return;
      const data = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk;
      const whole = data.length - (data.length % FRAME_BYTES);
      rest = data.subarray(whole);
      if (whole > 0) webContents.send(DESKTOP_GAME_AUDIO_DATA, data.subarray(0, whole));
    });

    return new Promise((resolve) => {
      let said = '';
      const answer = (source: DesktopGameAudioSource) => {
        clearTimeout(timer);
        if (!source && current === child) stop();
        resolve(source);
      };
      const timer = setTimeout(() => answer(null), START_TIMEOUT_MS);
      child.stderr.on('data', (chunk: Buffer) => {
        said += chunk.toString();
        const end = said.indexOf('\n');
        if (end < 0) return;
        try {
          const started = startedSchema.safeParse(JSON.parse(said.slice(0, end)));
          if (!started.success) console.warn(`[desktop] game audio: ${said.trim()}`);
          if (!started.success) answer(null);
          else answer({ name: 'name' in started.data ? started.data.name.slice(0, 200) : null });
        } catch {
          answer(null);
        }
      });
      child.once('error', (error) => {
        console.error('[desktop] game audio helper did not start', error);
        answer(null);
      });
      // Before its first line: no program to capture. After it: the program was closed.
      child.once('exit', () => {
        if (current === child) current = null;
        answer(null);
      });
    });
  };

  ipcMain.handle(DESKTOP_GAME_AUDIO_START, (event) => {
    assertFromApp(event);
    stop();
    const helper = process.platform === 'win32' ? findBundled('host', 'dispeaker-host.exe') : null;
    return helper ? start(helper) : null;
  });

  ipcMain.handle(DESKTOP_GAME_AUDIO_STOP, (event) => {
    assertFromApp(event);
    stop();
  });

  webContents.on('did-start-navigation', (details) => {
    // A reloaded page knows nothing about the capture it left running.
    if (details.isMainFrame && !details.isSameDocument) stop();
  });
  app.on('will-quit', stop);
}
