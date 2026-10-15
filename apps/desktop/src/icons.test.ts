import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { COLORS, encodePng, markDrawing, microphoneDrawing, rasterize } from './icons';
import { trayLook, trayTooltip } from './tray-state';

const alphaAt = (pixels: Uint8Array, size: number, x: number, y: number) =>
  pixels[(y * size + x) * 4 + 3] ?? 0;

describe('icons', () => {
  it('draws on a transparent square: corners empty, the line painted in its colour', () => {
    const size = 32;
    const pixels = rasterize(markDrawing(COLORS.accent), size);
    expect(alphaAt(pixels, size, 0, 0)).toBe(0);
    expect(alphaAt(pixels, size, size - 1, size - 1)).toBe(0);
    // The flat start of the line, on the left at mid height.
    const i = (16 * size + 3) * 4;
    expect(pixels[i + 3]).toBe(255);
    expect([pixels[i], pixels[i + 1], pixels[i + 2]]).toEqual([0xcc, 0xf2, 0x00]);
  });

  it('crosses the mark out in red when muted', () => {
    const size = 32;
    const plain = rasterize(markDrawing(COLORS.idle), size);
    const muted = rasterize(markDrawing(COLORS.idle, true), size);
    const red = (pixels: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if ((pixels[i] ?? 0) > 200 && (pixels[i + 1] ?? 0) < 120) count++;
      }
      return count;
    };
    expect(red(plain)).toBe(0);
    expect(red(muted)).toBeGreaterThan(20);
  });

  it('writes a PNG that decodes back to the same pixels', () => {
    const size = 16;
    const pixels = rasterize(microphoneDrawing(false), size);
    const png = encodePng(pixels, size);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(size);
    const idatAt = png.indexOf('IDAT');
    const length = png.readUInt32BE(idatAt - 4);
    const rows = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + length));
    const row = 5;
    const stride = size * 4 + 1;
    expect(rows[row * stride]).toBe(0);
    expect(rows.subarray(row * stride + 1, (row + 1) * stride)).toEqual(
      Buffer.from(pixels.subarray(row * size * 4, (row + 1) * size * 4)),
    );
  });
});

describe('tray state', () => {
  const call = { channel: '01. GERAL', muted: false, deafened: false, speaking: false };

  it('lights only while the user is heard in a call', () => {
    expect(trayLook(call)).toBe('idle');
    expect(trayLook({ ...call, speaking: true })).toBe('speaking');
    expect(trayLook({ ...call, channel: null, speaking: true })).toBe('idle');
  });

  it('shows the microphone off, in a call or not', () => {
    expect(trayLook({ ...call, muted: true, speaking: true })).toBe('muted');
    expect(trayLook({ ...call, channel: null, deafened: true })).toBe('muted');
  });

  it('says where the user is and what is off', () => {
    expect(trayTooltip({ ...call, muted: true })).toBe(
      'Dispeaker · Em 01. GERAL · Microfone desligado',
    );
    expect(trayTooltip({ ...call, channel: null })).toBe('Dispeaker');
  });
});
