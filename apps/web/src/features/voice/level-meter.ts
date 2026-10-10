/** Quietest and loudest levels (dB) the meter maps onto 0..1. */
const FLOOR_DB = -60;
const CEILING_DB = -12;
const INTERVAL_MS = 80;

/** Turns a block of samples into a 0..1 level on a decibel scale. */
export function levelOf(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  if (rms === 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)));
}

/**
 * Reports how loud a track is, a dozen times a second, until the returned function is called.
 * It listens to the very track that is sent to the others, so what the meter shows is what
 * they get: silence while a noise gate is closed, movement when the voice goes through.
 */
export function meterTrack(track: MediaStreamTrack, onLevel: (level: number) => void): () => void {
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    return () => undefined;
  }
  const source = context.createMediaStreamSource(new MediaStream([track]));
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  context.resume().catch(() => undefined);

  let last = -1;
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    // Rounded, so a steady level does not make listeners re-render for nothing.
    const level = Math.round(levelOf(samples) * 20) / 20;
    if (level !== last) {
      last = level;
      onLevel(level);
    }
  }, INTERVAL_MS);

  return () => {
    window.clearInterval(timer);
    source.disconnect();
    context.close().catch(() => undefined);
  };
}
