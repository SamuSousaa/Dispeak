import type { types } from 'mediasoup-client';

interface Picture {
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
}

const named = (codec: types.RtpCodecCapability, mimeType: string) =>
  codec.mimeType.toLowerCase() === mimeType;

/** Whether this machine encodes H.264 High at that size on its graphics hardware. */
async function encodesH264InHardware({
  width,
  height,
  frameRate,
  bitrate,
}: Picture): Promise<boolean> {
  try {
    const info = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: {
        contentType: 'video/H264;profile-level-id=640034;packetization-mode=1',
        width,
        height,
        framerate: frameRate,
        bitrate,
      },
    });
    return info.supported && info.powerEfficient;
  } catch {
    // Browsers that cannot answer encode in software, like before.
    return false;
  }
}

/**
 * The codec a screen share goes out in. H.264 when the graphics card encodes it: a large, fast
 * picture then costs the CPU next to nothing, and the browser has no reason to shrink it. In
 * software H.264 is the worse choice, so everything else stays on VP8.
 */
export async function pickScreenCodec(
  codecs: types.RtpCodecCapability[] | undefined,
  picture: Picture,
): Promise<types.RtpCodecCapability | undefined> {
  const vp8 = codecs?.find((codec) => named(codec, 'video/vp8'));
  const h264 = codecs?.find(
    (codec) =>
      named(codec, 'video/h264') &&
      String(codec.parameters?.['profile-level-id'] ?? '').startsWith('64'),
  );
  if (h264 && (await encodesH264InHardware(picture))) return h264;
  return vp8;
}
