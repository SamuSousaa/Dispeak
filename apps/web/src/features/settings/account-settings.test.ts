import { describe, expect, it } from 'vitest';
import { mergePatches } from './account-settings';

const ANA = '00000000-0000-4000-8000-000000000001';
const BIA = '00000000-0000-4000-8000-000000000002';

describe('mergePatches', () => {
  it('sends a dragged slider and a mute as one change', () => {
    const merged = mergePatches(
      { people: { [ANA]: { streamVolume: 0.3 } } },
      { people: { [ANA]: { streamVolume: 0.6, streamMuted: false } } },
    );
    expect(merged).toEqual({ people: { [ANA]: { streamVolume: 0.6, streamMuted: false } } });
  });

  it('keeps changes about different people and other fields', () => {
    const merged = mergePatches(
      { people: { [ANA]: { voiceMuted: true } }, showEmbeds: false },
      { people: { [BIA]: { voiceVolume: 0.5 } } },
    );
    expect(merged).toEqual({
      people: { [ANA]: { voiceMuted: true }, [BIA]: { voiceVolume: 0.5 } },
      showEmbeds: false,
    });
  });

  it('lets a later forget win over an earlier change', () => {
    const merged = mergePatches(
      { people: { [ANA]: { voiceMuted: true } } },
      { people: { [ANA]: null } },
    );
    expect(merged).toEqual({ people: { [ANA]: null } });
  });
});
