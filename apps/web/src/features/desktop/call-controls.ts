import type { DesktopCallState } from '@frequencia/shared';
import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../settings/settings-store';
import { leaveVoice, toggleDeafen, toggleMute } from '../voice/voice-actions';
import { useVoiceStore } from '../voice/voice-store';
import { desktop } from './desktop';
import { heardNow, SPEAKING_HOLD_MS } from './heard-now';

/**
 * Keeps the app's notification area icon and taskbar buttons in step with the call, and does
 * what they ask. Outside a call they show, and change, how the next call starts.
 */
export function useDesktopCallControls(onVoiceSettings: () => void): void {
  const openSettings = useRef(onVoiceSettings);
  useEffect(() => {
    openSettings.current = onVoiceSettings;
  });

  useEffect(() => {
    const setCallState = desktop?.setCallState;
    if (!setCallState) return;
    let sent = '';
    let speaking = false;
    let holdTimer: number | undefined;

    const report = () => {
      const voice = useVoiceStore.getState();
      const settings = useSettingsStore.getState();
      const inCall = voice.status !== 'idle' && voice.status !== 'error';
      const state: DesktopCallState = {
        channel: inCall ? voice.channelName : null,
        muted: inCall ? voice.muted : settings.selfMuted || settings.selfDeafened,
        deafened: inCall ? voice.deafened : settings.selfDeafened,
        speaking,
      };
      const key = JSON.stringify(state);
      if (key === sent) return;
      sent = key;
      setCallState(state);
    };

    const update = () => {
      const heard = heardNow(
        useVoiceStore.getState(),
        useSettingsStore.getState().inputMode === 'pushToTalk',
      );
      if (heard) {
        window.clearTimeout(holdTimer);
        holdTimer = undefined;
        speaking = true;
      } else if (speaking && holdTimer === undefined) {
        holdTimer = window.setTimeout(() => {
          holdTimer = undefined;
          speaking = false;
          report();
        }, SPEAKING_HOLD_MS);
      }
      report();
    };

    update();
    const stopVoice = useVoiceStore.subscribe(update);
    const stopSettings = useSettingsStore.subscribe(update);
    const stopActions = desktop?.onCallAction?.((action) => {
      if (action === 'toggle-mute') toggleMute();
      else if (action === 'toggle-deafen') toggleDeafen();
      else if (action === 'disconnect') leaveVoice();
      else openSettings.current();
    });
    return () => {
      window.clearTimeout(holdTimer);
      stopVoice();
      stopSettings();
      stopActions?.();
    };
  }, []);
}
