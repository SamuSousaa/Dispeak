import { desktop } from '../desktop/desktop';
import playerWorkletUrl from './pcm-player.worklet.js?url';

/** The sound of one program, as a track ready to be published with a screen share. */
export interface GameAudio {
  track: MediaStreamTrack;
  /** What the program calls itself; `null` for everything except voice chats. */
  name: string | null;
  stop(): void;
}

/**
 * Asks the desktop app for the sound of the share without voice chats: the shared program
 * alone, or everything except Discord and this app. The app sends PCM, a worklet plays it into
 * a track. `null` when the app cannot (a browser, an old app or an old Windows): the caller
 * shares the system's sound instead.
 */
export async function startGameAudio(): Promise<GameAudio | null> {
  const bridge = desktop?.gameAudio;
  if (!bridge) return null;
  const context = new AudioContext({ sampleRate: 48_000 });
  let unsubscribe: (() => void) | null = null;
  const release = () => {
    unsubscribe?.();
    void bridge.stop().catch(() => undefined);
    void context.close().catch(() => undefined);
  };
  try {
    await context.audioWorklet.addModule(playerWorkletUrl);
    const player = new AudioWorkletNode(context, 'pcm-player', {
      numberOfInputs: 0,
      outputChannelCount: [2],
    });
    const destination = context.createMediaStreamDestination();
    player.connect(destination);
    // Listening before asking: the sound starts as soon as the app finds the program.
    unsubscribe = bridge.onData((pcm) => {
      // A copy of its own, so the worklet can take it over without another one.
      const { buffer } = pcm.slice();
      player.port.postMessage(buffer, [buffer]);
    });
    const source = await bridge.start();
    const [track] = destination.stream.getAudioTracks();
    if (!source || !track) {
      release();
      return null;
    }
    await context.resume();
    return {
      track,
      name: source.name,
      stop: () => {
        track.stop();
        release();
      },
    };
  } catch (error) {
    console.warn('[voice] the sound of the shared program is unavailable', error);
    release();
    return null;
  }
}
