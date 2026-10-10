import type { NoiseSuppressionMode, Settings } from '../settings/settings-store';
import { denoiseTrack } from './noise-suppression';

export type MicrophoneSettings = Pick<
  Settings,
  'inputDeviceId' | 'noiseSuppression' | 'echoCancellation' | 'autoGainControl'
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

async function capture(settings: MicrophoneSettings): Promise<MediaStreamTrack> {
  const constraints = (deviceId: string | null): MediaStreamConstraints => ({
    audio: {
      echoCancellation: settings.echoCancellation,
      autoGainControl: settings.autoGainControl,
      // RNNoise replaces the browser's suppressor; running both distorts the voice.
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

/** Opens the microphone with the user's settings. Throws when no microphone can be opened. */
export async function openMicrophone(settings: MicrophoneSettings): Promise<Microphone> {
  const source = await capture(settings);
  if (settings.noiseSuppression !== 'rnnoise') {
    return {
      track: source,
      noiseSuppression: settings.noiseSuppression,
      close: () => source.stop(),
    };
  }

  try {
    const denoised = await denoiseTrack(source);
    return {
      track: denoised.track,
      noiseSuppression: 'rnnoise',
      close: () => {
        denoised.close();
        source.stop();
      },
    };
  } catch (error) {
    console.warn('[voice] RNNoise unavailable, using the browser noise suppression', error);
    await source.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
    return { track: source, noiseSuppression: 'browser', close: () => source.stop() };
  }
}
