import { SIMULCAST_LAYERS } from '@frequencia/shared';

export type ScreenPresetId = '720p30' | '1080p30' | '1080p60';

export interface ScreenPreset {
  id: ScreenPresetId;
  label: string;
  hint: string;
  width: number;
  height: number;
  frameRate: number;
  /** `detail` keeps text sharp under pressure, `motion` keeps the frame rate. */
  contentHint: 'detail' | 'motion';
  /** Max bitrate per simulcast layer, lowest resolution first. */
  bitrates: [number, number, number];
}

export const SCREEN_PRESETS: Record<ScreenPresetId, ScreenPreset> = {
  '720p30': {
    id: '720p30',
    label: '720P30',
    hint: 'Leve — documentos e navegação',
    width: 1280,
    height: 720,
    frameRate: 30,
    contentHint: 'detail',
    bitrates: [150_000, 500_000, 1_800_000],
  },
  '1080p30': {
    id: '1080p30',
    label: '1080P30',
    hint: 'Nítido — código e texto pequeno',
    width: 1920,
    height: 1080,
    frameRate: 30,
    contentHint: 'detail',
    bitrates: [250_000, 900_000, 3_000_000],
  },
  '1080p60': {
    id: '1080p60',
    label: '1080P60',
    hint: 'Fluido — jogos e vídeo',
    width: 1920,
    height: 1080,
    frameRate: 60,
    contentHint: 'motion',
    bitrates: [400_000, 1_400_000, 5_000_000],
  },
};

export const SCREEN_PRESET_LIST = Object.values(SCREEN_PRESETS);

/** Three simulcast encodings: quarter, half and full resolution. */
export function simulcastEncodings(preset: ScreenPreset): RTCRtpEncodingParameters[] {
  return preset.bitrates.map((maxBitrate, index) => ({
    rid: `r${index}`,
    scaleResolutionDownBy: 2 ** (SIMULCAST_LAYERS - 1 - index),
    maxBitrate,
    maxFramerate: preset.frameRate,
  }));
}

/**
 * Simulcast layer worth receiving for a video shown `cssHeight` CSS pixels tall: the smallest
 * one that still covers the tile's physical pixels. The thresholds follow the lowest preset
 * (layers of 180, 360 and 720 lines), so higher presets err on the side of sharpness.
 */
export function layerForViewport(cssHeight: number, devicePixelRatio = 1): number {
  const pixels = cssHeight * devicePixelRatio;
  if (pixels <= 200) return 0;
  if (pixels <= 400) return 1;
  return 2;
}
