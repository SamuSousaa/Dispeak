import type { types } from 'mediasoup-client';

interface Picture {
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
}

const named = (codec: types.RtpCodecCapability, mimeType: string) =>
  codec.mimeType.toLowerCase() === mimeType;

const profileOf = (codec: types.RtpCodecCapability) =>
  String(codec.parameters?.['profile-level-id'] ?? '').toLowerCase();

/** Main, High, Constrained Baseline; anything else last. */
const PROFILE_ORDER = ['4d', '64', '42'];
const preference = (profile: string) => {
  const index = PROFILE_ORDER.indexOf(profile.slice(0, 2));
  return index < 0 ? PROFILE_ORDER.length : index;
};

/** Whether this machine encodes that H.264 profile at that size on its graphics hardware. */
async function encodesInHardware(
  profile: string,
  { width, height, frameRate, bitrate }: Picture,
): Promise<boolean> {
  try {
    const info = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: {
        // Level 5.2, whatever the router advertises: the question is about the profile.
        contentType: `video/H264;profile-level-id=${profile.slice(0, 4)}34;packetization-mode=1`,
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
 * picture then costs the CPU next to nothing, and the browser has no reason to shrink it. Which
 * profile the hardware takes depends on the vendor, so each one the router offers is tried: Main
 * first, which every viewer decodes (without a graphics card's decoder a browser offers no High),
 * then High, then Constrained Baseline. In software H.264 is the worse choice, so everything else
 * stays on VP8.
 */
export async function pickScreenCodec(
  codecs: types.RtpCodecCapability[] | undefined,
  picture: Picture,
): Promise<types.RtpCodecCapability | undefined> {
  const h264 = (codecs ?? [])
    .filter((codec) => named(codec, 'video/h264') && profileOf(codec).length === 6)
    .sort((a, b) => preference(profileOf(a)) - preference(profileOf(b)));
  for (const codec of h264) {
    if (await encodesInHardware(profileOf(codec), picture)) return codec;
  }
  return codecs?.find((codec) => named(codec, 'video/vp8'));
}
