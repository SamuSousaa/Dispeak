import type { DesktopBridge } from '@frequencia/shared';
import { create } from 'zustand';

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
