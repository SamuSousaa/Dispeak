/** Capture and encoding of the webcam: 720p30, published as simulcast like a screen share. */
export const CAMERA = {
  width: 1280,
  height: 720,
  frameRate: 30,
  /** Max bitrate per simulcast layer, lowest resolution first. */
  bitrates: [120_000, 400_000, 1_200_000] as [number, number, number],
};

const isMissingDevice = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === 'OverconstrainedError' || error.name === 'NotFoundError');

/** Opens the chosen camera, or the front/default one. Throws when none can be opened. */
export async function openCamera(deviceId: string | null): Promise<MediaStream> {
  const constraints = (id: string | null): MediaStreamConstraints => ({
    video: {
      width: { ideal: CAMERA.width },
      height: { ideal: CAMERA.height },
      frameRate: { ideal: CAMERA.frameRate },
      ...(id ? { deviceId: { exact: id } } : { facingMode: 'user' }),
    },
  });
  try {
    return await navigator.mediaDevices.getUserMedia(constraints(deviceId));
  } catch (error) {
    // The chosen device may have been unplugged since it was saved.
    if (!deviceId || !isMissingDevice(error)) throw error;
    return navigator.mediaDevices.getUserMedia(constraints(null));
  }
}
