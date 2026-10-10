import { describe, expect, it } from 'vitest';
import {
  layerForViewport,
  SCREEN_PRESET_LIST,
  SCREEN_PRESETS,
  simulcastEncodings,
} from './screen-presets';

describe('simulcastEncodings', () => {
  it('produces quarter, half and full resolution layers, lowest first', () => {
    const encodings = simulcastEncodings(SCREEN_PRESETS['1080p60']);
    expect(encodings.map((encoding) => encoding.rid)).toEqual(['r0', 'r1', 'r2']);
    expect(encodings.map((encoding) => encoding.scaleResolutionDownBy)).toEqual([4, 2, 1]);
    expect(encodings.every((encoding) => encoding.maxFramerate === 60)).toBe(true);
    const bitrates = encodings.map((encoding) => encoding.maxBitrate ?? 0);
    expect(bitrates).toEqual([...bitrates].sort((a, b) => a - b));
  });
});

describe('SCREEN_PRESETS', () => {
  it('keeps every preset within what the media server accepts from one sender', () => {
    // TRANSPORT_BITRATE.maxIncoming in apps/media, minus headroom for the audio tracks.
    const budget = 20_000_000 - 500_000;
    for (const preset of SCREEN_PRESET_LIST) {
      expect(preset.bitrates.reduce((sum, bitrate) => sum + bitrate, 0)).toBeLessThanOrEqual(
        budget,
      );
    }
  });
});

describe('layerForViewport', () => {
  it('serves thumbnails from the lowest layer', () => {
    expect(layerForViewport(126)).toBe(0);
  });

  it('serves medium tiles from the middle layer', () => {
    expect(layerForViewport(360)).toBe(1);
  });

  it('serves large and fullscreen tiles from the top layer', () => {
    expect(layerForViewport(510)).toBe(2);
    expect(layerForViewport(1080)).toBe(2);
  });

  it('accounts for high-density displays', () => {
    expect(layerForViewport(126, 2)).toBe(1);
    expect(layerForViewport(250, 2)).toBe(2);
  });
});
