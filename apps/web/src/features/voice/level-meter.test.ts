import { describe, expect, it } from 'vitest';
import { levelOf } from './level-meter';

const sine = (amplitude: number) =>
  Float32Array.from({ length: 1024 }, (_, index) => amplitude * Math.sin(index / 5));

describe('levelOf', () => {
  it('is zero for silence and full for a loud signal', () => {
    expect(levelOf(new Float32Array(1024))).toBe(0);
    expect(levelOf(sine(1))).toBe(1);
  });

  it('grows with the signal, on a decibel scale', () => {
    const quiet = levelOf(sine(0.005));
    const speech = levelOf(sine(0.05));
    const loud = levelOf(sine(0.3));
    expect(quiet).toBeGreaterThan(0);
    expect(speech).toBeGreaterThan(quiet);
    expect(loud).toBeGreaterThan(speech);
    // Ten times the amplitude is 20 dB, a fixed step of the scale wherever it starts.
    expect(speech - quiet).toBeCloseTo(20 / 48, 1);
  });

  it('ignores what is below the floor', () => {
    expect(levelOf(sine(0.0002))).toBe(0);
  });
});
