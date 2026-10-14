import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import {
  DESKTOP_NATIVE_CAPTURE_CHOOSE,
  DESKTOP_NATIVE_CAPTURE_ENDED,
  DESKTOP_NATIVE_CAPTURE_PROBE,
  DESKTOP_NATIVE_CAPTURE_START,
  DESKTOP_NATIVE_CAPTURE_STATS,
  DESKTOP_NATIVE_CAPTURE_STOP,
  desktopNativeCaptureStartSchema,
  desktopNativeCaptureStatsSchema,
  type DesktopNativeCaptureChoice,
  type DesktopNativeCaptureStart,
  type IngestCodec,
} from '@frequencia/shared';
import { app, ipcMain, screen, type BrowserWindow, type DesktopCapturerSource } from 'electron';
import { z } from 'zod';
import { config } from './config';
import { findBundled } from './bundled';
import { isAppUrl } from './navigation';
import { keepTimersFine } from './windows-scheduling';

/** PCI vendor ids, as Chromium reports the graphics cards. */
const AMD = 0x1002;
const NVIDIA = 0x10de;

/** The app's own capture engine (`native/capture`, ADR 0013); ffmpeg is the fallback. */
function findEngine(): string | null {
  return findBundled('capture', 'dispeaker-capture.exe');
}

/** What the engine says on each line of its output. */
const engineLineSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    encoder: z.string(),
    width: z.number(),
    height: z.number(),
  }),
  z.object({ type: z.literal('probe'), codec: z.literal('h264'), encoder: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  desktopNativeCaptureStatsSchema.extend({ type: z.literal('stats') }),
]);

function parseEngineLine(text: string): z.infer<typeof engineLineSchema> | null {
  try {
    const result = engineLineSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

let engineProbe: Promise<boolean> | null = null;
/** What the engine said when it could not run here. */
let engineProblem: string | null = null;

/** Whether the engine runs here: a hardware H.264 encoder on the card. Asked once. */
function engineWorks(engine: string): Promise<boolean> {
  engineProbe ??= new Promise((resolve) => {
    execFile(engine, ['probe'], { windowsHide: true, timeout: 10_000 }, (error, out) => {
      const line = parseEngineLine(out.trim().split('\n').at(-1) ?? '');
      if (error || line?.type !== 'probe') {
        console.warn('[desktop] capture engine unavailable', error ?? out);
        engineProblem = (line?.type === 'error' ? line.message : (error?.message ?? out)).slice(
          0,
          500,
        );
        resolve(false);
        return;
      }
      console.warn(`[desktop] capture engine: ${line.encoder}`);
      resolve(true);
    });
  });
  return engineProbe;
}

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
/** An ffmpeg that cannot capture or encode gives up well within this. */
const STARTUP_MS = 1500;

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
/** What the helper (`native/game-audio.cs`) says about a window, in real pixels. */
const describedSchema = z.object({ covers: z.boolean(), monitor: rectSchema });
/** The monitors as Desktop Duplication numbers them: by graphics card, then by output. */
const monitorsSchema = z.array(
  rectSchema.extend({ adapter: z.number().int().min(0), output: z.number().int().min(0) }),
);
type Monitor = z.infer<typeof monitorsSchema>[number];

/** Runs the helper for an answer on its standard output; `null` when it has none. */
function askHelper(args: string[]): Promise<unknown> {
  const helper = findBundled('game-audio', 'dispeaker-game-audio.exe');
  if (!helper) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(helper, args, { windowsHide: true, timeout: 3000 }, (error, out) => {
      try {
        resolve(error ? null : JSON.parse(out));
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * The monitor the capture should grab for what the user picked: the monitor itself, or the one
 * a window covers entirely (a game in full screen). It is found by where it sits on the
 * desktop, which Electron and the graphics cards agree on. `null` for any other window, or a
 * monitor that cannot be told apart: the browser's capture takes those.
 */
async function monitorOf(source: DesktopCapturerSource): Promise<Monitor | null> {
  let rect: z.infer<typeof rectSchema> | null = null;
  if (source.id.startsWith('screen:')) {
    const displays = screen.getAllDisplays();
    const display =
      displays.find((entry) => String(entry.id) === source.display_id) ??
      (displays.length === 1 ? displays[0] : undefined);
    if (display) rect = screen.dipToScreenRect(null, display.bounds);
  } else {
    // On Windows a window source is named `window:<handle>:<n>`.
    const described = describedSchema.safeParse(
      await askHelper(['--describe', source.id.split(':')[1] ?? '']),
    );
    if (described.success && described.data.covers) rect = described.data.monitor;
  }
  if (!rect) return null;
  const monitors = monitorsSchema.safeParse(await askHelper(['--monitors']));
  if (!monitors.success) return null;
  const { x, y } = rect;
  // Scaled displays may land a pixel off.
  return (
    monitors.data.find((entry) => Math.abs(entry.x - x) <= 2 && Math.abs(entry.y - y) <= 2) ?? null
  );
}

/** One key frame a second: the sender answers no requests, so that is how long a viewer waits. */
function ffmpegArguments(
  { ingest, codec, frameRate, bitrate }: DesktopNativeCaptureStart,
  monitor: Monitor,
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
    // Desktop Duplication of one monitor, on the card it is plugged into; the frames never
    // leave that card.
    ...['-init_hw_device', `d3d11va=card:${monitor.adapter}`, '-filter_hw_device', 'card'],
    ...['-filter_complex', `ddagrab=output_idx=${monitor.output}:framerate=${frameRate}`],
    ...encoder,
    ...['-b:v', rate, '-maxrate', rate, '-g', String(frameRate)],
    // No frame bigger than two average ones. Unbounded, a key frame of a busy screen is a burst
    // of 150 packets; some never arrive, nothing sends them again, and the viewer is left with
    // a picture it cannot decode until the next key frame, which loses packets in turn.
    ...['-bufsize', String(Math.round((bitrate * 2) / frameRate))],
    ...(codec === 'av1' ? ['-enforce_hrd', '1'] : []),
    ...['-f', 'rtp', '-ssrc', String(ingest.ssrc), '-payload_type', String(ingest.payloadType)],
    ...['-srtp_out_suite', ingest.srtp.cryptoSuite, '-srtp_out_params', ingest.srtp.keyBase64],
    `srtp://${ingest.address}:${ingest.rtpPort}?rtcpport=${ingest.rtcpPort}&pkt_size=1200`,
  ];
}

/**
 * Experimental screen capture outside the browser: ffmpeg grabs a monitor, encodes it on
 * the graphics card and sends it to an ingest of the media service. Behind a game that takes
 * the whole card, the browser's own capture loses about half the frames; this one does not.
 * The page decides when to use it (a setting); here it only needs an ffmpeg and a card whose
 * encoder is known. `pick` asks the user what to share: a monitor, or a window covering one,
 * is captured here; any other window is kept for the browser's capture, which the page asks
 * next (`takeHandover`), as is a monitor whose capture does not start.
 */
export function serveNativeCapture(
  window: BrowserWindow,
  pick: () => Promise<DesktopCapturerSource | null>,
): { capturing(): boolean; takeHandover(): DesktopCapturerSource | null } {
  const { webContents } = window;
  let current: ChildProcess | null = null;
  /** What was picked for the next capture. */
  let picked: { source: DesktopCapturerSource; monitor: Monitor } | null = null;
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
    if (process.platform !== 'win32') return { codec: null };
    // The engine sends H.264, which every viewer decodes, whatever the card.
    const engine = findEngine();
    if (engine && (await engineWorks(engine))) return { codec: 'h264', engineProblem: null };
    return {
      codec: findFfmpeg() ? await pickCodec() : null,
      engineProblem: engine ? engineProblem : 'engine missing',
    };
  });

  ipcMain.handle(
    DESKTOP_NATIVE_CAPTURE_CHOOSE,
    async (event): Promise<DesktopNativeCaptureChoice> => {
      assertFromApp(event);
      handover = null;
      picked = null;
      const source = await pick();
      if (!source) return 'cancelled';
      const monitor = await monitorOf(source);
      if (!monitor) {
        handover = { source, at: Date.now() };
        return 'browser';
      }
      picked = { source, monitor };
      return 'native';
    },
  );

  ipcMain.handle(DESKTOP_NATIVE_CAPTURE_START, async (event, payload: unknown) => {
    assertFromApp(event);
    const options = desktopNativeCaptureStartSchema.parse(payload);
    stop();
    // Apps that predate the picker, and a page that did not ask: the main monitor.
    const choice = picked ?? {
      source: null,
      monitor: { adapter: 0, output: 0, x: 0, y: 0, width: 0, height: 0 },
    };
    const engine = process.platform === 'win32' ? findEngine() : null;
    if (engine && options.codec === 'h264' && (await engineWorks(engine))) {
      return startEngine(engine, options, choice);
    }
    const ffmpeg = process.platform === 'win32' ? findFfmpeg() : null;
    if (!ffmpeg) throw new Error('native capture unavailable');

    const child = spawn(ffmpeg, ffmpegArguments(options, choice.monitor), {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    current = child;
    let said = '';
    child.stderr.on('data', (chunk: Buffer) => {
      said = (said + chunk.toString()).slice(-2000);
      console.warn(`[desktop] ffmpeg: ${chunk.toString().trim()}`);
    });
    // A capture that does not start says so to the page, which shares through the browser
    // instead; the picked monitor waits for it there.
    const started = new Promise<void>((resolve, reject) => {
      const failed = () => {
        clearTimeout(timer);
        if (current === child) current = null;
        if (choice.source) handover = { source: choice.source, at: Date.now() };
        reject(new Error(`native capture did not start: ${said.trim().slice(-300)}`));
      };
      const timer = setTimeout(() => {
        child.off('exit', failed);
        child.off('error', failed);
        resolve();
      }, STARTUP_MS);
      child.once('exit', failed);
      child.once('error', failed);
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
    return started;
  });

  /**
   * Runs the engine on the picked monitor. It is ready when it says so; anything it says
   * before that is why it could not start, and the page then shares through the browser.
   */
  function startEngine(
    engine: string,
    { ingest, frameRate, bitrate, width, height }: DesktopNativeCaptureStart,
    choice: { source: DesktopCapturerSource | null; monitor: Monitor },
  ): Promise<void> {
    const child = spawn(
      engine,
      [
        'stream',
        ...['--adapter', String(choice.monitor.adapter), '--output', String(choice.monitor.output)],
        ...['--fps', String(frameRate), '--bitrate', String(bitrate)],
        ...['--width', String(width ?? 1920), '--height', String(height ?? 1080)],
        ...['--address', ingest.address, '--pt', String(ingest.payloadType)],
        ...['--rtp-port', String(ingest.rtpPort), '--rtcp-port', String(ingest.rtcpPort)],
        ...['--ssrc', String(ingest.ssrc)],
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    current = child;
    // The keys go through stdin, never on a command line other programs can read: ours, then
    // the server's. Closing stdin is how the engine is told to stop, so it stays open.
    child.stdin.write(
      `${ingest.srtp.keyBase64}\n${ingest.srtp.serverKeyBase64 ?? ingest.srtp.keyBase64}\n`,
    );
    child.stderr.on('data', (chunk: Buffer) => {
      console.warn(`[desktop] capture engine: ${chunk.toString().trim()}`);
    });
    const lines = readline.createInterface({ input: child.stdout });

    const started = new Promise<void>((resolve, reject) => {
      let settled = false;
      const failed = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (current === child) current = null;
        child.kill();
        if (choice.source) handover = { source: choice.source, at: Date.now() };
        reject(new Error(`capture engine did not start: ${reason}`));
      };
      const timer = setTimeout(() => failed('no answer'), 8000);
      lines.on('line', (text) => {
        const line = parseEngineLine(text);
        if (line?.type === 'ready' && !settled) {
          settled = true;
          clearTimeout(timer);
          console.warn(
            `[desktop] capture engine sending ${line.width}x${line.height} with ${line.encoder}`,
          );
          resolve();
        } else if (line?.type === 'error') {
          console.error(`[desktop] capture engine: ${line.message}`);
          failed(line.message);
        } else if (line?.type === 'stats' && !webContents.isDestroyed()) {
          const { type: _type, ...stats } = line;
          webContents.send(DESKTOP_NATIVE_CAPTURE_STATS, stats);
        }
      });
      child.once('exit', (code) => failed(`exited with ${code}`));
      child.once('error', (error) => failed(error.message));
    });
    child.on('exit', () => {
      if (current !== child) return;
      current = null;
      if (!webContents.isDestroyed()) webContents.send(DESKTOP_NATIVE_CAPTURE_ENDED);
    });
    // A process without a window, behind a game: it opts out of throttling itself, and gets
    // the same treatment the app's own processes get.
    if (child.pid !== undefined) void keepTimersFine([child.pid]).catch(() => undefined);
    return started;
  }

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
