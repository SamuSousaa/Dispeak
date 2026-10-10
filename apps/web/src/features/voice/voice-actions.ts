import { updateSettings, useSettingsStore } from '../settings/settings-store';
import type { ScreenPresetId } from './screen-presets';
import { fullscreenWhenShown, toggleStreamFullscreen } from './stream-fullscreen';
import { VoiceSession, type VoiceSessionOptions } from './voice-session';
import { isLive, useVoiceStore } from './voice-store';

// A browser tab is in at most one voice channel, like the rest of the app assumes.
let session: VoiceSession | null = null;

/** Joins a voice channel, leaving the current one first. */
export async function joinVoice(options: VoiceSessionOptions): Promise<void> {
  session?.dispose();
  const next = new VoiceSession(options);
  session = next;
  await next.start();
}

export function leaveVoice(): void {
  session?.dispose();
  session = null;
  // A failed session already disposed itself but left its error on screen; clear it.
  if (useVoiceStore.getState().status === 'error') {
    useVoiceStore.setState({ status: 'idle', error: null });
  }
}

export function toggleMute(): void {
  void session?.toggleMute();
}

export function toggleDeafen(): void {
  void session?.toggleDeafen();
}

export function startScreenShare(preset: ScreenPresetId): void {
  updateSettings({ sharePreset: preset });
  void session?.startScreenShare(preset);
}

/** Shortcut: stops the running share, or starts one with the quality used last time. */
export function toggleScreenShare(): void {
  if (useVoiceStore.getState().screen.status === 'off') {
    void session?.startScreenShare(useSettingsStore.getState().sharePreset);
  } else {
    void session?.stopScreenShare();
  }
}

/**
 * Shortcut: fullscreen for the stream on screen. With none on screen, starts watching whoever
 * is live and goes fullscreen as soon as the stream shows up.
 */
export function toggleWatchFullscreen(): void {
  if (toggleStreamFullscreen()) return;
  const live = Object.values(useVoiceStore.getState().peers).find(isLive);
  if (!live) return;
  fullscreenWhenShown(live.id);
  session?.watch(live.id);
}

export function stopScreenShare(): void {
  void session?.stopScreenShare();
}

/** Starts watching a participant's screen share. */
export function watchStream(peerId: string): void {
  session?.watch(peerId);
}

export function unwatchStream(peerId: string): void {
  session?.unwatch(peerId);
}

/** Tells the session how tall (CSS px) a watched stream is displayed. */
export function setStreamViewport(peerId: string, cssHeight: number): void {
  session?.setStreamViewport(peerId, cssHeight);
}
