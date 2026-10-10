import { useEffect } from 'react';
import {
  actionForBinding,
  bindingFromEvent,
  firesWhileTyping,
  type KeybindAction,
} from '../settings/keybinds';
import { useSettingsStore } from '../settings/settings-store';
import {
  leaveVoice,
  toggleCamera,
  toggleDeafen,
  toggleMute,
  toggleScreenShare,
  toggleWatchFullscreen,
} from './voice-actions';
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

const run: Record<KeybindAction, () => void> = {
  mute: toggleMute,
  deafen: toggleDeafen,
  fullscreen: toggleWatchFullscreen,
  share: toggleScreenShare,
  camera: toggleCamera,
  leave: leaveVoice,
};

/**
 * Keyboard shortcuts while in a voice channel. The bindings come from the user's settings
 * (defaults: M mutes, D deafens, F toggles fullscreen on a stream). Bindings that would
 * also type a character are ignored while a field has focus.
 */
export function useVoiceShortcuts(): void {
  const active = useVoiceStore(
    (state) => state.status === 'connected' || state.status === 'reconnecting',
  );

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const binding = bindingFromEvent(event);
      if (!binding) return;
      const action = actionForBinding(useSettingsStore.getState().keybinds, binding);
      if (!action) return;
      if (isTyping(event.target) && !firesWhileTyping(binding)) return;

      event.preventDefault();
      run[action]();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);
}
