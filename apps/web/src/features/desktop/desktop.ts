import type { DesktopBridge, IngestCodec } from '@frequencia/shared';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useSettingsStore } from '../settings/settings-store';

declare global {
  interface Window {
    /** Present only inside the desktop app, put there by its preload script. */
    dispeakerDesktop?: DesktopBridge;
  }
}

/** The desktop app this page runs in, or `null` in a browser. */
export const desktop: DesktopBridge | null =
  typeof window === 'undefined' ? null : (window.dispeakerDesktop ?? null);

/** Actions whose global shortcut the system refused, as last reported by the app. */
export const useRefusedShortcuts = create<string[]>(() => []);

/** Whether this app can stay in the notification area when its window is closed. */
export const canCloseToTray = Boolean(desktop?.setCloseToTray);

/**
 * The codec this machine's native capture would send: `null` when it has none, `undefined`
 * while the app is still being asked.
 */
export function useNativeCaptureCodec(): IngestCodec | null | undefined {
  const [codec, setCodec] = useState<IngestCodec | null | undefined>(
    desktop?.nativeCapture ? undefined : null,
  );
  useEffect(() => {
    let current = true;
    desktop?.nativeCapture?.probe().then(
      (answer) => current && setCodec(answer),
      () => current && setCodec(null),
    );
    return () => {
      current = false;
    };
  }, []);
  return codec;
}

/** Tells the app what its close button should do, now and whenever the setting changes. */
export function useCloseToTray(): void {
  const enabled = useSettingsStore((state) => state.closeToTray);
  useEffect(() => {
    desktop
      ?.setCloseToTray?.(enabled)
      .catch((error: unknown) => console.warn('[desktop] close to tray unavailable', error));
  }, [enabled]);
}
