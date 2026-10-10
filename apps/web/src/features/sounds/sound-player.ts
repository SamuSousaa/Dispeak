import { updateSettings, useSettingsStore } from '../settings/settings-store';
import { useVoiceStore } from '../voice/voice-store';
import { soundEventsFor, type SoundEvent } from './sound-events';
import { toneWav } from './tones';

/** Custom sounds are short notification clips, not songs. */
export const CUSTOM_SOUND_MAX_BYTES = 2 * 1024 * 1024;

const DATABASE = 'frequencia';
const STORE = 'sounds';

// --- custom files, kept in IndexedDB (localStorage is too small for audio) --------------------

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB unavailable'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(database.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
    });
  } finally {
    database.close();
  }
}

// --- playback ---------------------------------------------------------------------------------

/** Object URLs by event; `custom` entries are `null` once known to be missing. */
const defaults = new Map<SoundEvent, string>();
const custom = new Map<SoundEvent, string | null>();

function defaultUrl(event: SoundEvent): string {
  let url = defaults.get(event);
  if (!url) {
    url = URL.createObjectURL(toneWav(event));
    defaults.set(event, url);
  }
  return url;
}

async function customUrl(event: SoundEvent): Promise<string | null> {
  if (!useSettingsStore.getState().customSounds[event]) return null;
  const cached = custom.get(event);
  if (cached !== undefined) return cached;
  const file = await withStore<unknown>('readonly', (store) => store.get(event)).catch(() => null);
  const url = file instanceof Blob ? URL.createObjectURL(file) : null;
  custom.set(event, url);
  return url;
}

function forget(event: SoundEvent): void {
  const url = custom.get(event);
  if (url) URL.revokeObjectURL(url);
  custom.delete(event);
}

/** Plays the sound of an event: the user's own file when there is one, else the built-in. */
export async function playSound(event: SoundEvent): Promise<void> {
  const { soundVolume, outputDeviceId } = useSettingsStore.getState();
  const audio = new Audio((await customUrl(event)) ?? defaultUrl(event));
  audio.volume = soundVolume;
  if (outputDeviceId && typeof audio.setSinkId === 'function') {
    await audio.setSinkId(outputDeviceId).catch(() => undefined);
  }
  // Browsers may refuse playback before the first interaction with the page.
  await audio.play().catch(() => undefined);
}

/** Uses a file from the user's computer as the sound of an event, on this device only. */
export async function setCustomSound(event: SoundEvent, file: File): Promise<void> {
  await withStore('readwrite', (store) => store.put(file, event));
  forget(event);
  updateSettings({
    customSounds: { ...useSettingsStore.getState().customSounds, [event]: file.name },
  });
}

/** Back to the built-in sound. */
export async function clearCustomSound(event: SoundEvent): Promise<void> {
  await withStore('readwrite', (store) => store.delete(event)).catch(() => undefined);
  forget(event);
  updateSettings({ customSounds: { ...useSettingsStore.getState().customSounds, [event]: null } });
}

/** Plays the notification sounds as the voice state changes. Returns the way to stop. */
export function startVoiceSounds(): () => void {
  return useVoiceStore.subscribe((next, previous) => {
    const settings = useSettingsStore.getState();
    // Deafened means no sound at all; leaving resets that flag, so the leave sound still plays.
    if (!settings.soundsEnabled || next.deafened) return;
    for (const event of soundEventsFor(previous, next)) {
      if (settings.soundEvents[event]) void playSound(event);
    }
  });
}
