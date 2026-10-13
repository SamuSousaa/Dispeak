import type { IngestCodec } from '@frequencia/shared';
import type { types } from 'mediasoup';

/**
 * Codecs offered by every router. Opus carries in-band FEC; DTX is negotiated per producer by
 * the browser. VP8 is what every browser can send and receive, and what cameras use. H.264
 * High is there for screen shares: it is the profile graphics cards encode, which takes a
 * 1440p60 stream off the sender's CPU. The sender picks it only when its hardware does the work.
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
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '640032',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
  // Constrained Baseline, for the graphics cards whose encoder the browser exposes in that
  // profile only.
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e032',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
  // Only the desktop app's native capture sends it: the graphics cards that encode AV1 take the
  // captured picture as it is, without a copy through system memory. Last, so no browser picks
  // it on its own.
  { kind: 'video', mimeType: 'video/AV1', clockRate: 90000 },
];

/**
 * What a native capture is told to send. One fixed payload type is enough: an ingest carries a
 * single stream on a transport of its own. No RTCP feedback, because the sender does not answer
 * any: a lost packet is not repeated and a new viewer waits for the next periodic key frame.
 */
export const INGEST = {
  payloadType: 96,
  srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
  /** Bytes of an AES_CM_128 master key and its salt. */
  srtpKeyLength: 30,
  codecs: {
    av1: { mimeType: 'video/AV1', clockRate: 90000, parameters: {} },
    h264: {
      mimeType: 'video/H264',
      clockRate: 90000,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '640032',
        'level-asymmetry-allowed': 1,
      },
    },
  },
} as const satisfies {
  payloadType: number;
  srtpCryptoSuite: types.SrtpCryptoSuite;
  srtpKeyLength: number;
  codecs: Record<IngestCodec, Omit<types.RtpCodecParameters, 'payloadType'>>;
};

export const AUDIO_LEVEL_OBSERVER = {
  /** How many simultaneous speakers are reported. */
  maxEntries: 8,
  /** dBov above which a producer counts as speaking (-127..0). */
  threshold: -55,
  /** Reporting interval in milliseconds. */
  interval: 200,
} as const;

export const TRANSPORT_BITRATE = {
  // Where the estimate of a viewer's connection starts: enough for the middle layer of a
  // stream right away, instead of a blurry first few seconds.
  initialAvailableOutgoing: 3_000_000,
  // Room for the three simulcast layers of the heaviest screen share preset, a camera and audio.
  maxIncoming: 40_000_000,
} as const;
