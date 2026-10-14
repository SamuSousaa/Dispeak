import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import {
  DESKTOP_NATIVE_CAPTURE_CHOOSE,
  DESKTOP_NATIVE_CAPTURE_ENDED,
  DESKTOP_NATIVE_CAPTURE_PROBE,
  DESKTOP_NATIVE_CAPTURE_START,
  DESKTOP_NATIVE_CAPTURE_STOP,
  desktopNativeCaptureStartSchema,
  type DesktopNativeCaptureChoice,
  type DesktopNativeCaptureStart,
  type IngestCodec,
} from '@frequencia/shared';
import {
  app,
  desktopCapturer,
  ipcMain,
  screen,
  type BrowserWindow,
  type DesktopCapturerSource,
} from 'electron';
import { z } from 'zod';
import { config } from './config';
import { findBundled } from './bundled';
import { isAppUrl } from './navigation';
import { keepTimersFine } from './windows-scheduling';

/** PCI vendor ids, as Chromium reports the graphics cards. */
const AMD = 0x1002;
const NVIDIA = 0x10de;

function findFfmpeg(): string | null {
  if (config.ffmpeg) return fs.existsSync(config.ffmpeg) ? config.ffmpeg : null;
  return findBundled('ffmpeg', 'ffmpeg.exe');
}

/**
 * What the card in use encodes straight from the captured surface, without a copy through
 * system memory: AV1 on AMD (its H.264 encoder refuses that surface), H.264 on NVIDIA.
 */
async function pickCodec(): Promise<IngestCodec | null> {
  const info = (await app.getGPUInfo('basic')) as {
    gpuDevice?: Array<{ active: boolean; vendorId: number }>;
  };
  const devices = info.gpuDevice ?? [];
  const vendor = (devices.find((device) => device.active) ?? devices[0])?.vendorId;
  if (vendor === AMD) return 'av1';
  if (vendor === NVIDIA) return 'h264';
  return null;
}

/** A choice waits this long for the page to ask the browser's capture for it. */
const HANDOVER_MS = 10_000;

/** What the helper says about a window (`native/game-audio.cs`, `--describe`), in real pixels. */
const describedSchema = z.object({
  covers: z.boolean(),
  monitor: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});

/** On Windows a screen source is named `screen:<index>:<n>`, a window `window:<handle>:<n>`. */
const screenIndex = (source: DesktopCapturerSource): number | null => {
  const index = Number(source.id.split(':')[1]);
  return source.id.startsWith('screen:') && Number.isInteger(index) ? index : null;
};

/**
 * The monitor the capture should grab for what the user picked, as the index the screen
 * sources carry: the monitor itself, or the one a window covers entirely (a game in full
 * screen). `null` for any other window: the capture takes whole monitors only.
 */
async function monitorOf(source: DesktopCapturerSource): Promise<number | null> {
  const picked = screenIndex(source);
  if (picked !== null) return picked;
  const helper = findBundled('game-audio', 'dispeaker-game-audio.exe');
  const handle = source.id.split(':')[1];
  if (!helper || !handle) return null;
  const described = await new Promise<z.infer<typeof describedSchema> | null>((resolve) => {
    execFile(helper, ['--describe', handle], { windowsHide: true, timeout: 3000 }, (error, out) => {
      try {
        resolve(error ? null : describedSchema.parse(JSON.parse(out)));
      } catch {
        resolve(null);
      }
    });
  });
  if (!described?.covers) return null;
  const display = screen.getDisplayMatching(screen.screenToDipRect(null, described.monitor));
  const screens = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const match = screens.find((entry) => entry.display_id === String(display.id));
  // With a single monitor there is nothing to match.
  return match ? screenIndex(match) : screens.length === 1 ? 0 : null;
}

/** One key frame a second: the sender answers no requests, so that is how long a viewer waits. */
function ffmpegArguments(
  { ingest, codec, frameRate, bitrate }: DesktopNativeCaptureStart,
  monitor: number,
) {
  const rate = String(bitrate);
  const encoder =
    codec === 'av1'
      ? [
          ...['-c:v', 'av1_amf', '-usage', 'lowlatency', '-quality', 'speed'],
          // ffmpeg still marks its AV1 over RTP as experimental.
          ...['-rc', 'cbr', '-strict', 'experimental'],
        ]
      : [
          ...['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-profile:v', 'high'],
          // The parameter sets go with every key frame: a viewer may arrive at any of them.
          ...['-rc', 'cbr', '-bf', '0', '-bsf:v', 'dump_extra=freq=keyframe'],
        ];
  return [
    ...['-hide_banner', '-loglevel', 'error'],
    // Desktop Duplication of one monitor; the frames never leave the graphics card.
    ...['-filter_complex', `ddagrab=output_idx=${monitor}:framerate=${frameRate}`],
    ...encoder,
    ...['-b:v', rate, '-maxrate', rate, '-g', String(frameRate)],
    ...['-f', 'rtp', '-ssrc', String(ingest.ssrc), '-payload_type', String(ingest.payloadType)],
    ...['-srtp_out_suite', ingest.srtp.cryptoSuite, '-srtp_out_params', ingest.srtp.keyBase64],
    `srtp://${ingest.address}:${ingest.rtpPort}?rtcpport=${ingest.rtcpPort}&pkt_size=1200`,
  ];
}

/**
 * Experimental screen capture outside the browser: ffmpeg grabs the main monitor, encodes it on
 * the graphics card and sends it to an ingest of the media service. Behind a game that takes
 * the whole card, the browser's own capture loses about half the frames; this one does not.
 * The page decides when to use it (a setting); here it only needs an ffmpeg and a card whose
 * encoder is known. `pick` asks the user what to share: a monitor, or a window covering one,
 * is captured here; any other window is kept for the browser's capture, which the page asks
 * next (`takeHandover`).
 */
export function serveNativeCapture(
  window: BrowserWindow,
  pick: () => Promise<DesktopCapturerSource | null>,
): { capturing(): boolean; takeHandover(): DesktopCapturerSource | null } {
  const { webContents } = window;
  let current: ChildProcess | null = null;
  /** The monitor picked for the next capture. */
  let monitor = 0;
  let handover: { source: DesktopCapturerSource; at: number } | null = null;

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

  ipcMain.handle(DESKTOP_NATIVE_CAPTURE_PROBE, async (event) => {
    assertFromApp(event);
    const available = process.platform === 'win32' && findFfmpeg();
    return { codec: available ? await pickCodec() : null };
  });

  ipcMain.handle(
    DESKTOP_NATIVE_CAPTURE_CHOOSE,
    async (event): Promise<DesktopNativeCaptureChoice> => {
      assertFromApp(event);
      handover = null;
      const source = await pick();
      if (!source) return 'cancelled';
      const picked = await monitorOf(source);
      if (picked === null) {
        handover = { source, at: Date.now() };
        return 'browser';
      }
      monitor = picked;
      return 'native';
    },
  );

  ipcMain.handle(DESKTOP_NATIVE_CAPTURE_START, (event, payload: unknown) => {
    assertFromApp(event);
    const options = desktopNativeCaptureStartSchema.parse(payload);
    const ffmpeg = process.platform === 'win32' ? findFfmpeg() : null;
    if (!ffmpeg) throw new Error('native capture unavailable');
    stop();

    const child = spawn(ffmpeg, ffmpegArguments(options, monitor), {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    current = child;
    child.stderr.on('data', (chunk: Buffer) => {
      console.warn(`[desktop] ffmpeg: ${chunk.toString().trim()}`);
    });
    const ended = () => {
      // Stopped on purpose, or replaced by a newer capture: nothing to report.
      if (current !== child) return;
      current = null;
      if (!webContents.isDestroyed()) webContents.send(DESKTOP_NATIVE_CAPTURE_ENDED);
    };
    child.on('exit', ended);
    child.on('error', (error) => {
      console.error('[desktop] ffmpeg did not start', error);
      ended();
    });
    // A process without a window, behind a game: the same treatment the app's own get.
    if (child.pid !== undefined) void keepTimersFine([child.pid]).catch(() => undefined);
  });

  ipcMain.handle(DESKTOP_NATIVE_CAPTURE_STOP, (event) => {
    assertFromApp(event);
    stop();
  });

  webContents.on('did-start-navigation', (details) => {
    // A reloaded page knows nothing about the capture it left running.
    if (details.isMainFrame && !details.isSameDocument) stop();
  });
  app.on('will-quit', stop);
  return {
    capturing: () => current !== null,
    takeHandover: () => {
      const waiting = handover;
      handover = null;
      return waiting && Date.now() - waiting.at < HANDOVER_MS ? waiting.source : null;
    },
  };
}
