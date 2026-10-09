import type { ScreenPresetId } from './screen-presets';
import { VoiceSession, type VoiceSessionOptions } from './voice-session';
import { useVoiceStore } from './voice-store';

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
  void session?.startScreenShare(preset);
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
