import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  DESKTOP_NATIVE_CAPTURE_ENDED,
  DESKTOP_NATIVE_CAPTURE_PROBE,
  DESKTOP_NATIVE_CAPTURE_START,
  DESKTOP_NATIVE_CAPTURE_STOP,
  desktopNativeCaptureStartSchema,
  type DesktopNativeCaptureStart,
  type IngestCodec,
} from '@frequencia/shared';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { config } from './config';
import { isAppUrl } from './navigation';
import { keepTimersFine } from './windows-scheduling';

/** PCI vendor ids, as Chromium reports the graphics cards. */
const AMD = 0x1002;
const NVIDIA = 0x10de;

/** The ffmpeg that comes with the app: beside the installed app, or in the sources. */
function findFfmpeg(): string | null {
  if (config.ffmpeg) return fs.existsSync(config.ffmpeg) ? config.ffmpeg : null;
  const candidates = [
    path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'),
    path.join(app.getAppPath(), 'vendor', 'ffmpeg', 'ffmpeg.exe'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
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

/** One key frame a second: the sender answers no requests, so that is how long a viewer waits. */
function ffmpegArguments({ ingest, codec, frameRate, bitrate }: DesktopNativeCaptureStart) {
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
    // Desktop Duplication of the main monitor; the frames never leave the graphics card.
    ...['-filter_complex', `ddagrab=output_idx=0:framerate=${frameRate}`],
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
 * encoder is known. Returns whether a capture is running.
 */
export function serveNativeCapture(window: BrowserWindow): () => boolean {
  const { webContents } = window;
  let current: ChildProcess | null = null;

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

  ipcMain.handle(DESKTOP_NATIVE_CAPTURE_START, (event, payload: unknown) => {
    assertFromApp(event);
    const options = desktopNativeCaptureStartSchema.parse(payload);
    const ffmpeg = process.platform === 'win32' ? findFfmpeg() : null;
    if (!ffmpeg) throw new Error('native capture unavailable');
    stop();

    const child = spawn(ffmpeg, ffmpegArguments(options), {
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
  return () => current !== null;
}
