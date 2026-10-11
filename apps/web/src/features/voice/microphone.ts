import type { Settings } from '../settings/settings-store';
import {
  needsProcessing,
  processMicrophone,
  type DenoiseModel,
  type MicrophoneProcessing,
} from './noise-suppression';

export type MicrophoneSettings = Pick<
  Settings,
  | 'inputDeviceId'
  | 'noiseSuppression'
  | 'echoCancellation'
  | 'autoGainControl'
  | 'voiceLeveler'
  | 'micGain'
>;

/**
 * What is cleaning the microphone: one of the neural models, the filter built into the browser
 * (when no model can run), or nothing.
 */
export type NoiseEngine = DenoiseModel | 'browser' | 'off';

export interface Microphone {
  /** The track to publish: the capture itself, or its processed version. */
  track: MediaStreamTrack;
  /** What is actually cleaning the audio, which can differ from what was asked for. */
  noiseSuppression: NoiseEngine;
  close: () => void;
}

/**
 * Level (dB) the cleaned voice must reach to be sent. What a model lets through between words
 * (a key press, a click) is quieter than this.
 */
const GATE_THRESHOLD_DB = -50;

/** With the suppression on: the strongest model first, then what can stand in for it. */
const MODELS: DenoiseModel[] = ['gtcrn', 'rnnoise'];

const isMissingDevice = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === 'OverconstrainedError' || error.name === 'NotFoundError');

async function capture(settings: MicrophoneSettings): Promise<MediaStreamTrack> {
  const constraints = (deviceId: string | null): MediaStreamConstraints => ({
    audio: {
      echoCancellation: settings.echoCancellation,
      autoGainControl: settings.autoGainControl,
      // A neural model does the cleaning; running the browser's filter too distorts the voice.
      noiseSuppression: false,
      // One clean channel at the rate the codec works in, instead of whatever the device offers.
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48_000 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  });

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints(settings.inputDeviceId));
  } catch (error) {
    // The chosen device may have been unplugged since it was saved.
    if (!settings.inputDeviceId || !isMissingDevice(error)) throw error;
    stream = await navigator.mediaDevices.getUserMedia(constraints(null));
  }
  const [track] = stream.getAudioTracks();
  if (!track) throw new Error('capture returned no audio track');
  return track;
}

/**
 * Opens the microphone with the user's settings. A neural model that cannot run gives way to
 * the next best thing: the other model, then the browser's own filter; without the audio graph
 * the capture goes out as it is. Throws only when no microphone can be opened at all.
 */
export async function openMicrophone(settings: MicrophoneSettings): Promise<Microphone> {
  const source = await capture(settings);
  const wanted = settings.noiseSuppression;
  const chain = (model: DenoiseModel | null): MicrophoneProcessing => ({
    model,
    gateThresholdDb: GATE_THRESHOLD_DB,
    leveler: settings.voiceLeveler,
    gain: settings.micGain,
  });

  let browserFilter = false;
  for (const model of wanted ? [...MODELS, null] : [null]) {
    if (model === null && wanted) {
      // No model could run: the browser's filter is better than nothing.
      await source.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
      browserFilter = true;
    }
    const processing = chain(model);
    if (!needsProcessing(processing)) break;
    try {
      const processed = await processMicrophone(source, processing);
      return {
        track: processed.track,
        noiseSuppression: model ?? (browserFilter ? 'browser' : 'off'),
        close: () => {
          processed.close();
          source.stop();
        },
      };
    } catch (error) {
      console.warn(`[voice] microphone chain unavailable (${model ?? 'no model'})`, error);
    }
  }
  return {
    track: source,
    noiseSuppression: browserFilter ? 'browser' : 'off',
    close: () => source.stop(),
  };
}
