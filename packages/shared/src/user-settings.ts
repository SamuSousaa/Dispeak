import { z } from 'zod';
import { idSchema } from './api';

/**
 * Preferences that belong to the account, not to a device: they follow the user to every
 * computer and phone. What depends on the device (microphone, speakers, the app's capture)
 * stays in that device's own storage.
 */

const volumeSchema = z.number().min(0).max(1);

const exeSchema = z.string().trim().toLowerCase().min(1).max(260);
export const gameChoicesSchema = z.object({
  added: z.array(exeSchema).max(200),
  hidden: z.array(exeSchema).max(200),
});
export type GameChoices = z.infer<typeof gameChoicesSchema>;

/**
 * How this user hears another person. Only what differs from the default is stored: full
 * volume and not muted. Muting keeps the volume, so unmuting brings back the one chosen.
 */
export const personPreferencesSchema = z.object({
  voiceVolume: volumeSchema.optional(),
  voiceMuted: z.boolean().optional(),
  /** The sound of the person's screen share, apart from their voice. */
  streamVolume: volumeSchema.optional(),
  streamMuted: z.boolean().optional(),
});
export type PersonPreferences = z.infer<typeof personPreferencesSchema>;

/** People one account keeps preferences about; far above any real use. */
export const PEOPLE_PREFERENCES_MAX = 2000;

export const userSettingsSchema = z.object({
  /** By user id. */
  people: z.record(idSchema, personPreferencesSchema),
  /** Show pictures and previews of links posted in the chat. */
  showEmbeds: z.boolean(),
  /** Only friends may start a private conversation; otherwise anyone sharing a server can. */
  privateProfile: z.boolean(),
  /** Others see the game the desktop app sees running ("JOGANDO ELDEN RING"). */
  shareActivity: z.boolean(),
  /**
   * Corrections to the desktop app's game detection, by program file name (lowercase):
   * programs that are games though nothing says so, and programs taken for games that are not.
   */
  games: gameChoicesSchema,
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export const defaultUserSettings: UserSettings = {
  people: {},
  showEmbeds: true,
  privateProfile: false,
  shareActivity: true,
  games: { added: [], hidden: [] },
};

/**
 * A change to the settings. Fields left out stay as they are; in `people`, a person's fields
 * are merged one by one and `null` forgets everything about that person.
 */
export const userSettingsPatchSchema = z
  .object({
    people: z
      .record(idSchema, personPreferencesSchema.nullable())
      .refine((people) => Object.keys(people).length <= PEOPLE_PREFERENCES_MAX),
    showEmbeds: z.boolean(),
    privateProfile: z.boolean(),
    shareActivity: z.boolean(),
    /** Replaces both lists. */
    games: gameChoicesSchema,
  })
  .partial();
export type UserSettingsPatch = z.infer<typeof userSettingsPatchSchema>;

export const PERSON_DEFAULTS: Required<PersonPreferences> = {
  voiceVolume: 1,
  voiceMuted: false,
  streamVolume: 1,
  streamMuted: false,
};

/** Drops what equals the default, so a person back to normal leaves no entry behind. */
function trimPerson(person: PersonPreferences): PersonPreferences | null {
  const kept = Object.fromEntries(
    Object.entries(person).filter(
      ([key, value]) =>
        value !== undefined && value !== PERSON_DEFAULTS[key as keyof PersonPreferences],
    ),
  ) as PersonPreferences;
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * The settings after a patch. Shared by the server, which stores the result, and the client,
 * which shows it before the server has answered: both arrive at the same thing.
 */
export function applyUserSettingsPatch(
  settings: UserSettings,
  patch: UserSettingsPatch,
): UserSettings {
  const people = { ...settings.people };
  for (const [userId, change] of Object.entries(patch.people ?? {})) {
    const merged = change === null ? null : trimPerson({ ...people[userId], ...change });
    if (merged) people[userId] = merged;
    else delete people[userId];
  }
  return {
    people,
    showEmbeds: patch.showEmbeds ?? settings.showEmbeds,
    privateProfile: patch.privateProfile ?? settings.privateProfile,
    shareActivity: patch.shareActivity ?? settings.shareActivity,
    games: patch.games ?? settings.games,
  };
}

/** A person's preferences with every field filled in. */
export function personPreferences(
  settings: UserSettings,
  userId: string,
): Required<PersonPreferences> {
  return { ...PERSON_DEFAULTS, ...settings.people[userId] };
}
