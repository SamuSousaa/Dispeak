/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// Gives back the treble GTCRN cannot keep (`noise-suppression.ts`). The model works at 16 kHz:
// everything above 8 kHz leaves it, and the voice sounds like a phone line. Shipped as it is,
// like the other worklets: an AudioWorklet has no bundler.
//
// Input 0 is the model's output, input 1 what went into it. What the model took away is the
// delayed input minus its output; above 7 kHz that is the treble it could not pass, voice and
// noise alike. It comes back as far as the model kept the voice just below it (6 to 7.5 kHz) and
// in the middle of the voice (around 2 kHz): where the model kept the voice the treble returns,
// where it removed noise the treble stays out.
//
// Measured with a voice played into the app's chain and an Opus loopback (2026-10-16): 8-10 kHz
// went from -13 dB to +2 dB of the original; the noise left in the pauses stayed where GTCRN
// alone leaves it (hiss, keyboard, wind).

/** Samples GTCRN holds a sound back at 48 kHz: its 768-sample frames and its model (measured). */
const MODEL_DELAY = 1530;
/** The model's output is this much quieter than its input, flat across the band (-6 dB). */
const MODEL_GAIN = 0.5;
/** Odd, so the filter is symmetric and its delay a whole number of samples. */
const TAPS = 127;
const HALF = (TAPS - 1) / 2;
/** Where the returned treble starts: up to here the model's output is whole. */
const CUTOFF_HZ = 7200;
/**
 * Below this share of the voice kept (amplitude), the model was removing noise: no treble.
 * Above it the treble opens gradually, fully when the model kept everything.
 */
const KEPT_FLOOR = 0.4;
/** A key click lasts about 8 ms, a sibilant tens of them: the treble opens only for the latter. */
const ATTACK_MS = 25;
const RELEASE_MS = 20;
/** Smoothing of the band levels the model's choice is read from. */
const LEVEL_MS = 10;
/** How far above its recent level the treble may leap at once (power): 6 dB. */
const MAX_JUMP = 4;

/** Linear-phase high-pass (windowed sinc, Blackman): no phase of its own at the seam. */
function highPass() {
  const fc = CUTOFF_HZ / sampleRate;
  const taps = new Float32Array(TAPS);
  for (let i = 0; i < TAPS; i++) {
    const n = i - HALF;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const phase = (2 * Math.PI * i) / (TAPS - 1);
    taps[i] = -sinc * (0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase));
  }
  taps[HALF] += 1;
  return taps;
}

/** The mean square of a band-pass biquad's output (RBJ, constant peak gain), sample by sample. */
function bandLevel(center, q) {
  const w = (2 * Math.PI * center) / sampleRate;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const a1 = (-2 * Math.cos(w)) / a0;
  const a2 = (1 - alpha) / a0;
  const smooth = coefficient(LEVEL_MS);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let level = 0;
  return (x) => {
    const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    level = smooth * level + (1 - smooth) * y * y;
    return level;
  };
}

function coefficient(ms) {
  return Math.exp(-1 / ((ms / 1000) * sampleRate));
}

class HighbandRestore extends AudioWorkletProcessor {
  constructor() {
    super();
    this.taps = highPass();
    // The input, held back as long as the model holds it.
    this.input = new Float32Array(MODEL_DELAY + 1);
    this.inputAt = 0;
    // What the model took away, for the filter.
    this.removed = new Float32Array(2 * TAPS);
    this.removedAt = 0;
    // The model's output, held back as long as the filter holds the treble.
    this.output = new Float32Array(HALF + 1);
    this.outputAt = 0;
    this.keptHigh = bandLevel(6500, 2);
    this.offeredHigh = bandLevel(6500, 2);
    this.keptCore = bandLevel(2000, 0.7);
    this.offeredCore = bandLevel(2000, 0.7);
    this.gain = 0;
    this.attack = coefficient(ATTACK_MS);
    this.release = coefficient(RELEASE_MS);
    this.fast = coefficient(1);
    this.slow = coefficient(30);
    this.trebleFast = 0;
    this.trebleSlow = 0;
  }

  process(inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const model = inputs[0]?.[0];
    const source = inputs[1]?.[0];
    for (let i = 0; i < out.length; i++) {
      const y = model ? model[i] : 0;
      this.input[this.inputAt] = source ? source[i] : 0;
      this.inputAt = (this.inputAt + 1) % this.input.length;
      // The input as the model saw it, at the model's level.
      const x = this.input[this.inputAt] * MODEL_GAIN;

      const kept = Math.min(
        1,
        Math.sqrt(this.keptHigh(y) / (this.offeredHigh(x) + 1e-12)),
        Math.sqrt(this.keptCore(y) / (this.offeredCore(x) + 1e-12)),
      );
      const target = Math.max(0, (kept - KEPT_FLOOR) / (1 - KEPT_FLOOR)) ** 2;
      const speed = target > this.gain ? this.attack : this.release;
      this.gain = speed * this.gain + (1 - speed) * target;

      // Written twice, so the last TAPS samples always lie in one run: removed[at .. at+TAPS-1],
      // oldest first. The filter is symmetric: each tap serves the two samples it mirrors.
      const at = this.removedAt;
      const removed = this.removed;
      removed[at] = removed[at + TAPS] = x - y;
      this.removedAt = (at + 1) % TAPS;
      const first = at + 1;
      const last = at + TAPS;
      let treble = this.taps[HALF] * removed[first + HALF];
      for (let k = 0; k < HALF; k++)
        treble += this.taps[k] * (removed[first + k] + removed[last - k]);

      // A click leaps up in under a millisecond, a sibilant grows: treble far above its own
      // recent level is held down to it.
      const power = treble * treble;
      this.trebleFast = this.fast * this.trebleFast + (1 - this.fast) * power;
      this.trebleSlow = this.slow * this.trebleSlow + (1 - this.slow) * power;
      const jump = Math.min(
        1,
        Math.sqrt((MAX_JUMP * this.trebleSlow + 1e-12) / (this.trebleFast + 1e-12)),
      );

      this.output[this.outputAt] = y;
      this.outputAt = (this.outputAt + 1) % this.output.length;
      out[i] = this.output[this.outputAt] + this.gain * jump * treble;
    }
    return true;
  }
}

registerProcessor('highband-restore', HighbandRestore);
