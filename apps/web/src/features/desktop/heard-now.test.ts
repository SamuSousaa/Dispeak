import { describe, expect, it } from 'vitest';
import { initialVoiceState, type VoiceState } from '../voice/voice-store';
import { heardNow, SPEAKING_LEVEL } from './heard-now';

const talking: VoiceState = {
  ...initialVoiceState,
  status: 'connected',
  micLevel: SPEAKING_LEVEL + 0.1,
};

describe('heardNow', () => {
  it('is the user speaking with the microphone open', () => {
    expect(heardNow(talking, false)).toBe(true);
    expect(heardNow({ ...talking, micLevel: SPEAKING_LEVEL / 2 }, false)).toBe(false);
  });

  it('never while nobody can hear it', () => {
    expect(heardNow({ ...talking, muted: true }, false)).toBe(false);
    expect(heardNow({ ...talking, deafened: true }, false)).toBe(false);
    expect(heardNow({ ...talking, status: 'reconnecting' }, false)).toBe(false);
    expect(heardNow({ ...talking, micAvailable: false }, false)).toBe(false);
  });

  it('with push-to-talk, only while the key is held', () => {
    expect(heardNow(talking, true)).toBe(false);
    expect(heardNow({ ...talking, pttHeld: true }, true)).toBe(true);
  });
});
