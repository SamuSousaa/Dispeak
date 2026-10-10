import {
  GtcrnWorkletNode,
  loadGtcrn,
  loadRnnoise,
  NoiseGateWorkletNode,
  RnnoiseWorkletNode,
} from '@sapphi-red/web-noise-suppressor';
import gtcrnWasmUrl from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
// The worklets are self-contained modules, so they are shipped as they are. Bundling them as
// workers (`?worker&url`) rewrites `import.meta.url` to `self.location`, and an AudioWorklet has
// no `self`: the production build then failed to register the processor.
import gtcrnWorkletUrl from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import noiseGateWorkletUrl from '@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';

/** Both models run at this rate. */
const SAMPLE_RATE = 48_000;
const RESUME_TIMEOUT_MS = 1500;
/** How long the gate stays open after the voice drops below the threshold. */
const GATE_HOLD_MS = 180;
/** The gate closes a little below where it opens, so it does not flutter at the edge. */
const GATE_HYSTERESIS_DB = 6;

/** The neural models that can clean the microphone. */
export type DenoiseModel = 'rnnoise' | 'gtcrn';

export interface DenoiseOptions {
  model: DenoiseModel;
  /**
   * Level (dB) the cleaned signal must reach for anything to be sent, or `null` for no gate.
   * What a model lets through between words (a key press, a click) is quiet: the gate drops it.
   */
  gateThresholdDb: number | null;
}

export interface DenoisedTrack {
  track: MediaStreamTrack;
  close: () => void;
}

const binaries = new Map<DenoiseModel, Promise<ArrayBuffer>>();

function loadModel(model: DenoiseModel): Promise<ArrayBuffer> {
  let binary = binaries.get(model);
  if (!binary) {
    binary = (
      model === 'gtcrn'
        ? loadGtcrn({ url: gtcrnWasmUrl })
        : loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl })
    ).catch((error: unknown) => {
      binaries.delete(model);
      throw error;
    });
    binaries.set(model, binary);
  }
  return binary;
}

/**
 * Runs a microphone track through a neural denoiser in an AudioWorklet, optionally followed by
 * a gate, and returns the cleaned track. The source track stays owned by the caller. Throws
 * when the browser cannot run the pipeline (no AudioWorklet, no 48 kHz context, audio
 * blocked); the caller falls back.
 */
export async function denoiseTrack(
  source: MediaStreamTrack,
  { model, gateThresholdDb }: DenoiseOptions,
): Promise<DenoisedTrack> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  try {
    const [binary] = await Promise.all([
      loadModel(model),
      context.audioWorklet.addModule(model === 'gtcrn' ? gtcrnWorkletUrl : rnnoiseWorkletUrl),
      gateThresholdDb === null ? null : context.audioWorklet.addModule(noiseGateWorkletUrl),
    ]);
    // A context created outside a user gesture can start suspended and never produce audio.
    await Promise.race([
      context.resume(),
      new Promise((resolve) => window.setTimeout(resolve, RESUME_TIMEOUT_MS)),
    ]);
    if (context.state !== 'running') throw new Error(`audio context is ${context.state}`);

    const input = context.createMediaStreamSource(new MediaStream([source]));
    const denoiser =
      model === 'gtcrn'
        ? new GtcrnWorkletNode(context, { maxChannels: 1, wasmBinary: binary })
        : new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: binary });
    const gate =
      gateThresholdDb === null
        ? null
        : new NoiseGateWorkletNode(context, {
            openThreshold: gateThresholdDb,
            closeThreshold: gateThresholdDb - GATE_HYSTERESIS_DB,
            holdMs: GATE_HOLD_MS,
            maxChannels: 1,
          });
    const output = context.createMediaStreamDestination();
    if (gate) input.connect(denoiser).connect(gate).connect(output);
    else input.connect(denoiser).connect(output);
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
        denoiser.disconnect();
        denoiser.destroy();
        gate?.disconnect();
        track.stop();
        context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    context.close().catch(() => undefined);
    throw error;
  }
}
