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
  setPushToTalk,
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

const run: Record<Exclude<KeybindAction, 'pushToTalk'>, () => void> = {
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
 * also type a character are ignored while a field has focus. Push-to-talk is the one binding
 * that is held instead of pressed.
 */
export function useVoiceShortcuts(): void {
  const active = useVoiceStore(
    (state) => state.status === 'connected' || state.status === 'reconnecting',
  );

  useEffect(() => {
    if (!active) return;
    /** Physical key holding the microphone open, so its release is recognised whatever else changed. */
    let talkingCode: string | null = null;
    const release = () => {
      if (talkingCode === null) return;
      talkingCode = null;
      setPushToTalk(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const binding = bindingFromEvent(event);
      if (!binding) return;
      const action = actionForBinding(useSettingsStore.getState().keybinds, binding);
      if (!action) return;
      if (isTyping(event.target) && !firesWhileTyping(binding)) return;

      if (action === 'pushToTalk') {
        if (useSettingsStore.getState().inputMode !== 'pushToTalk') return;
        event.preventDefault();
        if (!event.repeat) {
          talkingCode = event.code;
          setPushToTalk(true);
        }
        return;
      }
      if (event.repeat) return;
      event.preventDefault();
      run[action]();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === talkingCode) release();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    // A key released while another window has focus never reports back.
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      release();
    };
  }, [active]);
}
