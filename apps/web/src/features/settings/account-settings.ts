import {
  applyUserSettingsPatch,
  defaultUserSettings,
  PERSON_DEFAULTS,
  personPreferences,
  userSettingsSchema,
  type PersonPreferences,
  type UserSettings,
  type UserSettingsPatch,
} from '@frequencia/shared';
import { create } from 'zustand';
import { toast } from '../../components/Toast';
import { api } from '../../lib/http';

/**
 * Preferences of the account, the same on every device: how loud each person and each
 * person's stream sounds, among others. The gateway delivers them (READY, then
 * USER_SETTINGS_UPDATE); a change shows at once and reaches the server shortly after, several
 * quick changes (a slider being dragged) in a single request.
 */
export const useAccountSettings = create<UserSettings>(() => defaultUserSettings);

/** Wait after the last change before sending, so a dragged slider is one request. */
const SEND_DELAY_MS = 400;

/** The last settings the server confirmed. */
let confirmed: UserSettings = defaultUserSettings;
/** Sent and not yet answered. */
let inFlight: UserSettingsPatch | null = null;
/** Not sent yet. */
let pending: UserSettingsPatch | null = null;
let timer: number | null = null;

function show(): void {
  let next = confirmed;
  if (inFlight) next = applyUserSettingsPatch(next, inFlight);
  if (pending) next = applyUserSettingsPatch(next, pending);
  useAccountSettings.setState(next, true);
}

/** Two changes as one: the later one wins, field by field. */
export function mergePatches(a: UserSettingsPatch, b: UserSettingsPatch): UserSettingsPatch {
  const merged: UserSettingsPatch = { ...a, ...b };
  if (a.people || b.people) {
    const people: NonNullable<UserSettingsPatch['people']> = { ...a.people };
    for (const [userId, change] of Object.entries(b.people ?? {})) {
      const before = people[userId];
      people[userId] = change === null || !before ? change : { ...before, ...change };
    }
    merged.people = people;
  }
  return merged;
}

async function send(): Promise<void> {
  timer = null;
  if (inFlight || !pending) return;
  inFlight = pending;
  pending = null;
  try {
    confirmed = await api('PATCH', '/users/@me/settings', {
      body: inFlight,
      schema: userSettingsSchema,
    });
  } catch {
    toast('Não foi possível salvar a preferência. Tente de novo.');
  } finally {
    inFlight = null;
    show();
    if (pending) void send();
  }
}

export function changeAccountSettings(patch: UserSettingsPatch): void {
  pending = pending ? mergePatches(pending, patch) : patch;
  show();
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => void send(), SEND_DELAY_MS);
}

/** What the server says the settings are now; changes not yet confirmed stay on top. */
export function receiveAccountSettings(settings: UserSettings): void {
  confirmed = settings;
  show();
  migrateDeviceSettings();
}

/** Signing out: nothing of this account stays in memory. */
export function resetAccountSettings(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  confirmed = defaultUserSettings;
  inFlight = null;
  pending = null;
  useAccountSettings.setState(defaultUserSettings, true);
}

export function changePerson(userId: string, change: PersonPreferences): void {
  changeAccountSettings({ people: { [userId]: change } });
}

/** How this user hears someone, every field filled in. */
export function usePerson(userId: string): Required<PersonPreferences> {
  const stored = useAccountSettings((settings) => settings.people[userId]);
  return { ...PERSON_DEFAULTS, ...stored };
}

export const getPerson = (userId: string): Required<PersonPreferences> =>
  personPreferences(useAccountSettings.getState(), userId);

/**
 * Up to version 6 of the device settings, the volume of each person and the chat previews
 * were kept on the device. `settings-store` leaves them here when it migrates; the first
 * session of the account takes them over, without replacing what the account already has.
 */
export const DEVICE_LEGACY_KEY = 'frequencia.account-migration';

function migrateDeviceSettings(): void {
  let raw: string | null;
  try {
    raw = localStorage.getItem(DEVICE_LEGACY_KEY);
    localStorage.removeItem(DEVICE_LEGACY_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let legacy: { userVolumes?: Record<string, unknown>; showEmbeds?: unknown };
  try {
    legacy = JSON.parse(raw) as typeof legacy;
  } catch {
    return;
  }
  const patch: UserSettingsPatch = {};
  const people: NonNullable<UserSettingsPatch['people']> = {};
  for (const [userId, volume] of Object.entries(legacy.userVolumes ?? {})) {
    if (typeof volume !== 'number' || confirmed.people[userId]?.voiceVolume !== undefined) continue;
    // Volume 0 was how a person was silenced: now it is a mute that remembers the volume.
    people[userId] = volume <= 0 ? { voiceMuted: true } : { voiceVolume: Math.min(1, volume) };
  }
  if (Object.keys(people).length > 0) patch.people = people;
  if (legacy.showEmbeds === false && confirmed.showEmbeds) patch.showEmbeds = false;
  if (Object.keys(patch).length > 0) changeAccountSettings(patch);
}
