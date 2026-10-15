import { describe, expect, it } from 'vitest';
import {
  applyUserSettingsPatch,
  defaultUserSettings,
  personPreferences,
  userSettingsPatchSchema,
} from './user-settings';

const ANA = '00000000-0000-4000-8000-000000000001';
const BIA = '00000000-0000-4000-8000-000000000002';

describe('user settings', () => {
  it('merges the fields of a person one by one', () => {
    const muted = applyUserSettingsPatch(defaultUserSettings, {
      people: { [ANA]: { streamMuted: true } },
    });
    const both = applyUserSettingsPatch(muted, { people: { [ANA]: { streamVolume: 0.5 } } });
    expect(both.people[ANA]).toEqual({ streamMuted: true, streamVolume: 0.5 });
  });

  it('keeps other people and other fields as they were', () => {
    const start = applyUserSettingsPatch(defaultUserSettings, {
      people: { [ANA]: { voiceVolume: 0.2 }, [BIA]: { voiceMuted: true } },
      showEmbeds: false,
    });
    const next = applyUserSettingsPatch(start, { people: { [BIA]: { voiceMuted: false } } });
    expect(next).toEqual({
      people: { [ANA]: { voiceVolume: 0.2 } },
      showEmbeds: false,
      privateProfile: false,
    });
  });

  it('leaves no entry for a person back to the defaults, or forgotten with null', () => {
    const start = applyUserSettingsPatch(defaultUserSettings, {
      people: { [ANA]: { voiceVolume: 0.2 }, [BIA]: { streamMuted: true } },
    });
    const next = applyUserSettingsPatch(start, {
      people: { [ANA]: { voiceVolume: 1 }, [BIA]: null },
    });
    expect(next.people).toEqual({});
  });

  it('fills in the defaults for anyone', () => {
    expect(personPreferences(defaultUserSettings, ANA)).toEqual({
      voiceVolume: 1,
      voiceMuted: false,
      streamVolume: 1,
      streamMuted: false,
    });
  });

  it('rejects volumes out of range and ids that are not ids', () => {
    expect(
      userSettingsPatchSchema.safeParse({ people: { [ANA]: { voiceVolume: 1.5 } } }).success,
    ).toBe(false);
    expect(
      userSettingsPatchSchema.safeParse({ people: { ana: { voiceMuted: true } } }).success,
    ).toBe(false);
  });
});
