import { z } from 'zod';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SOUND_EVENTS, type SoundEvent } from '../sounds/sound-events';
import { SCREEN_PRESET_IDS } from '../voice/screen-presets';
import {
  assignKeybind,
  DEFAULT_KEYBINDS,
  KEYBIND_ACTIONS,
  type KeybindAction,
  type Keybinds,
} from './keybinds';

/**
 * `browser` is the suppression built into the browser; `gtcrn` (the newer, stronger model) and
 * `rnnoise` run a neural network
 * (RNNoise, WebAssembly) on the microphone before it is sent.
 */
export const NOISE_SUPPRESSION_MODES = ['off', 'browser', 'rnnoise', 'gtcrn'] as const;
export type NoiseSuppressionMode = (typeof NOISE_SUPPRESSION_MODES)[number];

/** `voice` keeps the microphone open; `pushToTalk` opens it only while a key is held. */
export const INPUT_MODES = ['voice', 'pushToTalk'] as const;
export type InputMode = (typeof INPUT_MODES)[number];

const perSound = <T extends z.ZodType>(schema: T) =>
  Object.fromEntries(SOUND_EVENTS.map((event) => [event, schema])) as Record<SoundEvent, T>;

const settingsSchema = z.object({
  /** `null` follows the system default device. */
  inputDeviceId: z.string().nullable(),
  outputDeviceId: z.string().nullable(),
  cameraDeviceId: z.string().nullable(),
  noiseSuppression: z.enum(NOISE_SUPPRESSION_MODES),
  echoCancellation: z.boolean(),
  autoGainControl: z.boolean(),
  /** After a neural model, drop what is too quiet to be a voice (key presses between words). */
  noiseGate: z.boolean(),
  /** Level, in dB, the cleaned microphone must reach for the gate to open. */
  noiseGateThreshold: z.number().min(-80).max(-20),
  /** Evens out the voice and raises it, so nobody has to turn the speakers all the way up. */
  voiceLeveler: z.boolean(),
  /** Volume of the user's own microphone, as the others hear it (1 = as captured). */
  micGain: z.number().min(0.5).max(2),
  inputMode: z.enum(INPUT_MODES),
  /** How loud each person sounds to this user, by user id (0 to 1); absent means full volume. */
  userVolumes: z.record(z.string(), z.number().min(0).max(1)),
  /** Show pictures and previews of links posted in the chat. */
  showEmbeds: z.boolean(),
  /** System notification when someone mentions the user while the tab is in the background. */
  desktopNotifications: z.boolean(),
  /** Last quality picked for a screen share; the share shortcut starts with it. */
  sharePreset: z.enum(SCREEN_PRESET_IDS),
  /** Notification sounds: joining, leaving, a stream starting or ending. */
  soundsEnabled: z.boolean(),
  soundVolume: z.number().min(0).max(1),
  soundEvents: z.object(perSound(z.boolean())),
  /** Name of the user's own file for an event; the file itself lives in IndexedDB. */
  customSounds: z.object(perSound(z.string().nullable())),
  keybinds: z.object(
    Object.fromEntries(KEYBIND_ACTIONS.map((action) => [action, z.string().nullable()])) as Record<
      KeybindAction,
      z.ZodNullable<z.ZodString>
    >,
  ),
});

export type Settings = z.infer<typeof settingsSchema>;

// Stored data may predate a shortcut or a sound that exists now: those groups are read
// key by key and completed with the defaults.
const storedSchema = settingsSchema
  .extend({
    keybinds: settingsSchema.shape.keybinds.partial(),
    soundEvents: settingsSchema.shape.soundEvents.partial(),
    customSounds: settingsSchema.shape.customSounds.partial(),
  })
  .partial();

export const defaultSettings: Settings = {
  inputDeviceId: null,
  outputDeviceId: null,
  cameraDeviceId: null,
  noiseSuppression: 'rnnoise',
  echoCancellation: true,
  autoGainControl: true,
  noiseGate: true,
  noiseGateThreshold: -50,
  voiceLeveler: true,
  micGain: 1,
  inputMode: 'voice',
  userVolumes: {},
  showEmbeds: true,
  desktopNotifications: false,
  sharePreset: '1080p30',
  soundsEnabled: true,
  soundVolume: 0.5,
  soundEvents: {
    join: true,
    leave: true,
    streamStart: true,
    streamStop: true,
    watchStart: true,
    watchStop: true,
  },
  customSounds: {
    join: null,
    leave: null,
    streamStart: null,
    streamStop: null,
    watchStart: null,
    watchStop: null,
  },
  keybinds: DEFAULT_KEYBINDS,
};

/** Per-device preferences, kept in localStorage. */
export const useSettingsStore = create<Settings>()(
  persist(() => defaultSettings, {
    name: 'frequencia.settings',
    version: 2,
    // Version 1 made GTCRN the default for a few days. It dulls the voice (see
    // `noise-suppression.ts`), so it is now something the user picks, not where they start.
    migrate: (persisted, version) => {
      const stored = persisted as { noiseSuppression?: unknown } | null;
      if (version < 2 && stored?.noiseSuppression === 'gtcrn') {
        return { ...stored, noiseSuppression: 'rnnoise' };
      }
      return persisted;
    },
    // Stored data may be stale or hand-edited: keep only what still validates. Shortcuts are
    // merged one by one, so an action added later starts with its default.
    merge: (persisted, current) => {
      const parsed = storedSchema.safeParse(persisted);
      if (!parsed.success) return current;
      return {
        ...current,
        ...parsed.data,
        keybinds: { ...current.keybinds, ...parsed.data.keybinds },
        soundEvents: { ...current.soundEvents, ...parsed.data.soundEvents },
        customSounds: { ...current.customSounds, ...parsed.data.customSounds },
      };
    },
  }),
);

export function updateSettings(patch: Partial<Omit<Settings, 'keybinds'>>): void {
  useSettingsStore.setState(patch);
}

/** Volume of one person for this user only; full volume forgets the entry. */
export function setUserVolume(userId: string, volume: number): void {
  useSettingsStore.setState((state) => {
    const { [userId]: _previous, ...others } = state.userVolumes;
    return { userVolumes: volume >= 1 ? others : { ...others, [userId]: Math.max(0, volume) } };
  });
}

export const useUserVolume = (userId: string): number =>
  useSettingsStore((state) => state.userVolumes[userId] ?? 1);

export function setKeybind(action: KeybindAction, binding: string | null): void {
  useSettingsStore.setState((state) => ({
    keybinds: assignKeybind(state.keybinds, action, binding),
  }));
}

export function resetKeybinds(): void {
  useSettingsStore.setState({ keybinds: DEFAULT_KEYBINDS });
}

export const useKeybind = (action: KeybindAction): Keybinds[KeybindAction] =>
  useSettingsStore((state) => state.keybinds[action]);
