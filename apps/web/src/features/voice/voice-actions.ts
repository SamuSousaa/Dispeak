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

/** Push-to-talk: opens the microphone while the key is held. */
export function setPushToTalk(held: boolean): void {
  session?.setPushToTalk(held);
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

export function toggleCamera(): void {
  if (useVoiceStore.getState().camera.status === 'off') void session?.startCamera();
  else void session?.stopCamera();
}

/** Tells the session how tall (CSS px) a participant's camera is displayed. */
export function setCameraViewport(peerId: string, cssHeight: number): void {
  session?.setCameraViewport(peerId, cssHeight);
}

/** Someone the user asked to watch before their stream could be reached (still joining). */
let pendingWatch: { userId: string; until: number } | null = null;

function watchPending(): void {
  if (!pendingWatch) return;
  if (Date.now() > pendingWatch.until) {
    pendingWatch = null;
    return;
  }
  const state = useVoiceStore.getState();
  if (state.status !== 'connected') return;
  const peer = Object.values(state.peers).find(
    (entry) => entry.userId === pendingWatch?.userId && isLive(entry),
  );
  if (!peer) return;
  pendingWatch = null;
  if (!state.watching[peer.id]) session?.watch(peer.id);
}
useVoiceStore.subscribe(watchPending);

/**
 * Watches the stream of a user, by user id. Works right after asking to join their channel:
 * the request waits a few seconds for the connection and for the stream to show up.
 */
export function watchUser(userId: string): void {
  pendingWatch = { userId, until: Date.now() + 15_000 };
  watchPending();
}

/** Starts watching a participant's screen share. */
export function watchStream(peerId: string): void {
  session?.watch(peerId);
}

export function unwatchStream(peerId: string): void {
  session?.unwatch(peerId);
}

/** Stops waiting for a person's stream to come back after it ended. */
export function unwatchUser(userId: string): void {
  session?.unwatchUser(userId);
}

/** Tells the session how tall (CSS px) a watched stream is displayed. */
export function setStreamViewport(peerId: string, cssHeight: number): void {
  session?.setStreamViewport(peerId, cssHeight);
}
