import { SIMULCAST_LAYERS } from '@frequencia/shared';

export const SCREEN_PRESET_IDS = [
  '720p30',
  '1080p30',
  '1080p60',
  '1440p60',
  'source',
  'film',
] as const;
export type ScreenPresetId = (typeof SCREEN_PRESET_IDS)[number];

export interface ScreenPreset {
  id: ScreenPresetId;
  label: string;
  hint: string;
  /** Upper bound of the capture; a smaller screen is sent at its own size. */
  width: number;
  height: number;
  frameRate: number;
  /** `detail` keeps text sharp under pressure, `motion` keeps the frame rate. */
  contentHint: 'detail' | 'motion';
  /**
   * Max bitrate per simulcast layer, lowest resolution first. A single value publishes one
   * encoding only: every viewer gets the full picture, whatever the size of their tile. The
   * 60 fps presets do that because the extra layers cost frames: measured on an AMD card, its
   * H.264 encoder took 15 + 9 + 6 ms a frame for the three, about 30 fps, against 50 for one.
   */
  bitrates: number[];
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
    bitrates: [150_000, 500_000, 2_500_000],
  },
  '1080p30': {
    id: '1080p30',
    label: '1080P30',
    hint: 'Nítido — código e texto pequeno',
    width: 1920,
    height: 1080,
    frameRate: 30,
    contentHint: 'detail',
    bitrates: [250_000, 900_000, 4_000_000],
  },
  '1080p60': {
    id: '1080p60',
    label: '1080P60',
    hint: 'Fluido — jogos e vídeo',
    width: 1920,
    height: 1080,
    frameRate: 60,
    contentHint: 'motion',
    bitrates: [8_000_000],
  },
  '1440p60': {
    id: '1440p60',
    label: '1440P60',
    hint: 'Monitor 2K — pede PC e internet bons',
    width: 2560,
    height: 1440,
    frameRate: 60,
    contentHint: 'motion',
    bitrates: [14_000_000],
  },
  source: {
    id: 'source',
    label: 'ORIGINAL',
    hint: 'Resolução da sua tela (até 4K), 60 fps',
    width: 3840,
    height: 2160,
    frameRate: 60,
    contentHint: 'motion',
    bitrates: [20_000_000],
  },
  film: {
    id: 'film',
    label: 'FILME',
    hint: 'Máxima fidelidade para filmes e séries — até 1440p, 30 fps',
    width: 2560,
    height: 1440,
    // Films run at 24 to 30 frames: the bits of the other 30 go into each picture instead.
    frameRate: 30,
    contentHint: 'motion',
    bitrates: [18_000_000],
  },
};

export const SCREEN_PRESET_LIST = Object.values(SCREEN_PRESETS);

/** One encoding per bitrate of the preset: for three, quarter, half and full resolution. */
export function simulcastEncodings(
  preset: Pick<ScreenPreset, 'bitrates' | 'frameRate'>,
): RTCRtpEncodingParameters[] {
  const [only] = preset.bitrates;
  if (preset.bitrates.length === 1 && only !== undefined) {
    return [{ maxBitrate: only, maxFramerate: preset.frameRate }];
  }
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
