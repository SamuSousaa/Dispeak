/* global AudioWorkletProcessor, registerProcessor */
// Plays the pieces of sound the desktop app hands to the page (`game-audio.ts`): 48 kHz stereo
// signed 16-bit PCM, interleaved, arriving in bursts and only while the program plays
// something. Shipped as it is, like the other worklets: an AudioWorklet has no bundler.

/** Held back before playing (again), so a late piece does not become a gap: 30 ms. */
const START_FRAMES = 1440;
/** Above this the page fell behind (a busy main thread): the oldest sound is dropped. */
const MAX_FRAMES = 12000;

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    /** Pieces waiting to be played, oldest first. */
    this.pieces = [];
    /** Samples of the first piece already played. */
    this.offset = 0;
    this.frames = 0;
    this.playing = false;
    this.port.onmessage = (event) => {
      const piece = new Int16Array(event.data);
      this.pieces.push(piece);
      this.frames += piece.length / 2;
      while (this.frames > MAX_FRAMES && this.pieces.length > 1) {
        const dropped = this.pieces.shift();
        this.frames -= (dropped.length - this.offset) / 2;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    if (!left || !right) return true;
    if (!this.playing && this.frames >= START_FRAMES) this.playing = true;
    if (!this.playing) return true;
    for (let frame = 0; frame < left.length; frame++) {
      const piece = this.pieces[0];
      if (!piece) {
        // Ran dry: the program went quiet, or a piece is late. Silence until there is enough.
        this.playing = false;
        break;
      }
      left[frame] = piece[this.offset] / 32768;
      right[frame] = piece[this.offset + 1] / 32768;
      this.offset += 2;
      this.frames -= 1;
      if (this.offset >= piece.length) {
        this.pieces.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
