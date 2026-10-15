import { hostForegroundSchema, type HostForeground } from '@frequencia/shared';
import { nativeHost } from './native-host';

export type ForegroundWindow = NonNullable<HostForeground>;

/**
 * The window the user is looking at, asked of the app's Windows helper. Electron only knows its
 * own windows, and the question matters at the moment a global shortcut starts a screen share:
 * the window in front is then the game. `null` when it cannot be told.
 */
export function foregroundWindow(): Promise<ForegroundWindow | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return nativeHost.request('foreground', {}, hostForegroundSchema).catch(() => null);
}
