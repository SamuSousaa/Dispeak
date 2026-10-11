import { isGlobalBinding } from '@frequencia/shared';
import { useEffect } from 'react';
import { desktop, useRefusedShortcuts } from '../desktop/desktop';
import {
  actionForBinding,
  bindingFromEvent,
  firesWhileTyping,
  GLOBAL_KEYBIND_ACTIONS,
  type KeybindAction,
  type Keybinds,
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
 * Keyboard shortcuts while in a voice channel. The bindings come from the user's settings;
 * nobody has one until they set it. Bindings that would also type a character are ignored
 * while a field has focus. Push-to-talk is the one binding that is held instead of pressed.
 *
 * In the desktop app the chords among them are also registered with the system, so they work
 * while a game has the focus. The system then keeps those keys from reaching the page, which is
 * why nothing fires twice.
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

  useEffect(() => {
    if (!active || !desktop) return;
    const bridge = desktop;
    const register = (keybinds: Keybinds) => {
      const bindings: Record<string, string> = {};
      for (const action of GLOBAL_KEYBIND_ACTIONS) {
        const binding = keybinds[action];
        if (binding && isGlobalBinding(binding)) bindings[action] = binding;
      }
      bridge.setShortcuts(bindings).then(
        ({ failed }) => useRefusedShortcuts.setState(failed, true),
        (error: unknown) => console.warn('[desktop] global shortcuts unavailable', error),
      );
    };
    register(useSettingsStore.getState().keybinds);
    const unsubscribe = useSettingsStore.subscribe((state, previous) => {
      if (state.keybinds !== previous.keybinds) register(state.keybinds);
    });
    const stop = bridge.onShortcut((action) => {
      const known = GLOBAL_KEYBIND_ACTIONS.find((candidate) => candidate === action);
      if (known) run[known]();
    });
    return () => {
      unsubscribe();
      stop();
      useRefusedShortcuts.setState([], true);
      void bridge.setShortcuts({}).catch(() => undefined);
    };
  }, [active]);
}
