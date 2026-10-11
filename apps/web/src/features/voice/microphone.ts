import type { NoiseSuppressionMode, Settings } from '../settings/settings-store';
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
  | 'noiseGate'
  | 'noiseGateThreshold'
  | 'voiceLeveler'
  | 'micGain'
>;

export interface Microphone {
  /** The track to publish: the capture itself, or its processed version. */
  track: MediaStreamTrack;
  /** What is actually cleaning the audio, which can differ from what was asked for. */
  noiseSuppression: NoiseSuppressionMode;
  close: () => void;
}

const isMissingDevice = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === 'OverconstrainedError' || error.name === 'NotFoundError');

const isNeural = (mode: NoiseSuppressionMode): mode is DenoiseModel =>
  mode === 'gtcrn' || mode === 'rnnoise';

async function capture(settings: MicrophoneSettings): Promise<MediaStreamTrack> {
  const constraints = (deviceId: string | null): MediaStreamConstraints => ({
    audio: {
      echoCancellation: settings.echoCancellation,
      autoGainControl: settings.autoGainControl,
      // A neural model replaces the browser's suppressor; running both distorts the voice.
      noiseSuppression: settings.noiseSuppression === 'browser',
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
    gateThresholdDb: settings.noiseGate ? settings.noiseGateThreshold : null,
    leveler: settings.voiceLeveler,
    gain: settings.micGain,
  });
  const raw = (noiseSuppression: NoiseSuppressionMode): Microphone => ({
    track: source,
    noiseSuppression,
    close: () => source.stop(),
  });

  const attempts: Array<DenoiseModel | null> = isNeural(wanted)
    ? wanted === 'gtcrn'
      ? ['gtcrn', 'rnnoise', null]
      : ['rnnoise', null]
    : [null];
  let browserFilter = wanted === 'browser';
  for (const model of attempts) {
    if (model === null && isNeural(wanted)) {
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
  return raw(browserFilter ? 'browser' : 'off');
}
