import { useEffect } from 'react';
import { toggleDeafen, toggleMute } from './voice-actions';
import { useVoiceStore } from './voice-store';

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/**
 * Keyboard shortcuts while in a voice channel:
 *   M / Ctrl+Shift+M  toggle mute
 *   D / Ctrl+Shift+D  toggle deafen
 * The single-key variants are ignored while typing in a field.
 */
export function useVoiceShortcuts(): void {
  const active = useVoiceStore(
    (state) => state.status === 'connected' || state.status === 'reconnecting',
  );

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'm' && key !== 'd') return;

      const chord = event.ctrlKey && event.shiftKey;
      const plain = !event.ctrlKey && !event.shiftKey && !isTyping(event.target);
      if (!chord && !plain) return;

      event.preventDefault();
      if (key === 'm') toggleMute();
      else toggleDeafen();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);
}
