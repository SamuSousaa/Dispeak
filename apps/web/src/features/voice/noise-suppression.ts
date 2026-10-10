import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?worker&url';

/** RNNoise only works at this rate. */
const SAMPLE_RATE = 48_000;
const RESUME_TIMEOUT_MS = 1500;

export interface DenoisedTrack {
  track: MediaStreamTrack;
  close: () => void;
}

let wasmBinary: Promise<ArrayBuffer> | null = null;

function loadWasm(): Promise<ArrayBuffer> {
  wasmBinary ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch(
    (error: unknown) => {
      wasmBinary = null;
      throw error;
    },
  );
  return wasmBinary;
}

/**
 * Runs a microphone track through RNNoise in an AudioWorklet and returns the cleaned track.
 * The source track stays owned by the caller. Throws when the browser cannot run the
 * pipeline (no AudioWorklet, no 48 kHz context, audio blocked); the caller falls back.
 */
export async function denoiseTrack(source: MediaStreamTrack): Promise<DenoisedTrack> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  try {
    const [binary] = await Promise.all([
      loadWasm(),
      context.audioWorklet.addModule(rnnoiseWorkletUrl),
    ]);
    // A context created outside a user gesture can start suspended and never produce audio.
    await Promise.race([
      context.resume(),
      new Promise((resolve) => window.setTimeout(resolve, RESUME_TIMEOUT_MS)),
    ]);
    if (context.state !== 'running') throw new Error(`audio context is ${context.state}`);

    const input = context.createMediaStreamSource(new MediaStream([source]));
    const rnnoise = new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: binary });
    const output = context.createMediaStreamDestination();
    input.connect(rnnoise).connect(output);
    const [track] = output.stream.getAudioTracks();
    if (!track) throw new Error('audio graph produced no track');

    // Mobile browsers suspend the context on interruptions (a phone call, another app).
    const onStateChange = () => {
      if (context.state !== 'running' && context.state !== 'closed') {
        context.resume().catch(() => undefined);
      }
    };
    context.addEventListener('statechange', onStateChange);

    return {
      track,
      close: () => {
        context.removeEventListener('statechange', onStateChange);
        input.disconnect();
        rnnoise.disconnect();
        rnnoise.destroy();
        track.stop();
        context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    context.close().catch(() => undefined);
    throw error;
  }
}
