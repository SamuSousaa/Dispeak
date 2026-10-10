import { z } from 'zod';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SCREEN_PRESET_IDS } from '../voice/screen-presets';
import {
  assignKeybind,
  DEFAULT_KEYBINDS,
  KEYBIND_ACTIONS,
  type KeybindAction,
  type Keybinds,
} from './keybinds';

/**
 * `browser` is the suppression built into the browser; `rnnoise` runs a neural network
 * (RNNoise, WebAssembly) on the microphone before it is sent.
 */
export const NOISE_SUPPRESSION_MODES = ['off', 'browser', 'rnnoise'] as const;
export type NoiseSuppressionMode = (typeof NOISE_SUPPRESSION_MODES)[number];

const settingsSchema = z.object({
  /** `null` follows the system default device. */
  inputDeviceId: z.string().nullable(),
  outputDeviceId: z.string().nullable(),
  cameraDeviceId: z.string().nullable(),
  noiseSuppression: z.enum(NOISE_SUPPRESSION_MODES),
  echoCancellation: z.boolean(),
  autoGainControl: z.boolean(),
  /** Last quality picked for a screen share; the share shortcut starts with it. */
  sharePreset: z.enum(SCREEN_PRESET_IDS),
  keybinds: z.object(
    Object.fromEntries(KEYBIND_ACTIONS.map((action) => [action, z.string().nullable()])) as Record<
      KeybindAction,
      z.ZodNullable<z.ZodString>
    >,
  ),
});

export type Settings = z.infer<typeof settingsSchema>;

const storedSchema = settingsSchema
  .extend({ keybinds: settingsSchema.shape.keybinds.partial() })
  .partial();

export const defaultSettings: Settings = {
  inputDeviceId: null,
  outputDeviceId: null,
  cameraDeviceId: null,
  noiseSuppression: 'rnnoise',
  echoCancellation: true,
  autoGainControl: true,
  sharePreset: '1080p30',
  keybinds: DEFAULT_KEYBINDS,
};

/** Per-device preferences, kept in localStorage. */
export const useSettingsStore = create<Settings>()(
  persist(() => defaultSettings, {
    name: 'frequencia.settings',
    version: 1,
    // Stored data may be stale or hand-edited: keep only what still validates. Shortcuts are
    // merged one by one, so an action added later starts with its default.
    merge: (persisted, current) => {
      const parsed = storedSchema.safeParse(persisted);
      if (!parsed.success) return current;
      return {
        ...current,
        ...parsed.data,
        keybinds: { ...current.keybinds, ...parsed.data.keybinds },
      };
    },
  }),
);

export function updateSettings(patch: Partial<Omit<Settings, 'keybinds'>>): void {
  useSettingsStore.setState(patch);
}

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
