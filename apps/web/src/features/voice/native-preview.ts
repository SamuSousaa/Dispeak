import type { DesktopNativeCapturePreview } from '@frequencia/shared';

/** Chromium's track made from frames written to it ("breakout box"); not in the DOM types yet. */
interface TrackGenerator extends MediaStreamTrack {
  readonly writable: WritableStream<VideoFrame>;
}
type TrackGeneratorConstructor = new (init: { kind: 'video' }) => TrackGenerator;

export interface NativePreview {
  /** What the stream tiles show, like the browser capture's own stream. */
  stream: MediaStream;
  push(picture: DesktopNativeCapturePreview): void;
  stop(): void;
}

/**
 * The streamer's own preview of a native capture, as an ordinary video track: the app hands
 * over small BGRA pictures and they become frames of the track. `null` where the browser cannot
 * make such a track.
 */
export function createNativePreview(): NativePreview | null {
  const Generator = (globalThis as { MediaStreamTrackGenerator?: TrackGeneratorConstructor })
    .MediaStreamTrackGenerator;
  if (!Generator || typeof VideoFrame === 'undefined') return null;
  const track = new Generator({ kind: 'video' });
  const writer = track.writable.getWriter();
  let busy = false;
  let stopped = false;
  return {
    stream: new MediaStream([track]),
    push: ({ width, height, data }) => {
      // A picture still being written means the page is behind: skip this one.
      if (stopped || busy) return;
      busy = true;
      const frame = new VideoFrame(data, {
        format: 'BGRA',
        codedWidth: width,
        codedHeight: height,
        timestamp: Math.round(performance.now() * 1000),
      });
      writer
        .write(frame)
        .catch(() => undefined)
        .finally(() => {
          frame.close();
          busy = false;
        });
    },
    stop: () => {
      stopped = true;
      void writer.close().catch(() => undefined);
      track.stop();
    },
  };
}
