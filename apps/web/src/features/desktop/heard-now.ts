import type { VoiceState } from '../voice/voice-store';

/** Level (0 to 1, about -53 dB) above which what goes out counts as a voice. */
export const SPEAKING_LEVEL = 0.15;
/** How long the icon stays lit after the voice stops: the gaps between words do not count. */
export const SPEAKING_HOLD_MS = 400;

/** Whether the others hear the user right now. Only the user's own microphone counts. */
export function heardNow(voice: VoiceState, pushToTalk: boolean): boolean {
  return (
    voice.status === 'connected' &&
    voice.micAvailable &&
    !voice.muted &&
    !voice.deafened &&
    (!pushToTalk || voice.pttHeld) &&
    voice.micLevel >= SPEAKING_LEVEL
  );
}
