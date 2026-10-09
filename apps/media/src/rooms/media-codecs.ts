import type { types } from 'mediasoup';

/**
 * Codecs offered by every router. Opus carries in-band FEC; DTX is negotiated per producer by
 * the browser. VP8 is the only video codec so simulcast behaves the same for every viewer.
 */
export const mediaCodecs: types.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: { useinbandfec: 1, usedtx: 1 },
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
];

export const AUDIO_LEVEL_OBSERVER = {
  /** How many simultaneous speakers are reported. */
  maxEntries: 8,
  /** dBov above which a producer counts as speaking (-127..0). */
  threshold: -55,
  /** Reporting interval in milliseconds. */
  interval: 200,
} as const;

export const TRANSPORT_BITRATE = {
  initialAvailableOutgoing: 1_500_000,
  maxIncoming: 8_000_000,
} as const;
