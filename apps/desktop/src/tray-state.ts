import type { DesktopCallState } from '@frequencia/shared';

export type Look = 'idle' | 'speaking' | 'muted';

/**
 * What the icon says: lit while the others can hear the user, crossed out while the
 * microphone (or the sound) is off, grey otherwise. Only the user's own voice counts.
 */
export function trayLook(state: DesktopCallState): Look {
  if (state.muted || state.deafened) return 'muted';
  return state.speaking && state.channel !== null ? 'speaking' : 'idle';
}

export function trayTooltip(state: DesktopCallState): string {
  const parts = ['Dispeaker'];
  if (state.channel) parts.push(`Em ${state.channel}`);
  if (state.deafened) parts.push('Áudio desligado');
  else if (state.muted) parts.push('Microfone desligado');
  return parts.join(' · ');
}
