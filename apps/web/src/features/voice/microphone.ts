import type { NoiseSuppressionMode, Settings } from '../settings/settings-store';
import { denoiseTrack, type DenoiseModel } from './noise-suppression';

export type MicrophoneSettings = Pick<
  Settings,
  | 'inputDeviceId'
  | 'noiseSuppression'
  | 'echoCancellation'
  | 'autoGainControl'
  | 'noiseGate'
  | 'noiseGateThreshold'
>;

export interface Microphone {
  /** The track to publish: the capture itself, or its denoised version. */
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
 * the next best thing: the other model, then the browser's own filter. Throws only when no
 * microphone can be opened at all.
 */
export async function openMicrophone(settings: MicrophoneSettings): Promise<Microphone> {
  const source = await capture(settings);
  if (!isNeural(settings.noiseSuppression)) {
    return {
      track: source,
      noiseSuppression: settings.noiseSuppression,
      close: () => source.stop(),
    };
  }

  const gateThresholdDb = settings.noiseGate ? settings.noiseGateThreshold : null;
  const attempts: DenoiseModel[] =
    settings.noiseSuppression === 'gtcrn' ? ['gtcrn', 'rnnoise'] : ['rnnoise'];
  for (const model of attempts) {
    try {
      const denoised = await denoiseTrack(source, { model, gateThresholdDb });
      return {
        track: denoised.track,
        noiseSuppression: model,
        close: () => {
          denoised.close();
          source.stop();
        },
      };
    } catch (error) {
      console.warn(`[voice] ${model} unavailable`, error);
    }
  }
  await source.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
  return { track: source, noiseSuppression: 'browser', close: () => source.stop() };
}
