import type { DesktopCallState } from '@frequencia/shared';
import { nativeTheme, type BrowserWindow, type ThumbarButton } from 'electron';
import { iconImage, type CallControls } from './call-state';
import { COLORS, hangUpDrawing, headphonesDrawing, microphoneDrawing } from './icons';

/**
 * Buttons under the window's thumbnail on the taskbar, as Discord has: the microphone, the
 * sound and hanging up, only while in a call. Windows only.
 */
export function serveThumbar(window: BrowserWindow, call: CallControls): void {
  if (process.platform !== 'win32') return;
  let shown = '';

  const apply = (state: DesktopCallState, force = false) => {
    if (window.isDestroyed()) return;
    const fg = nativeTheme.shouldUseDarkColors ? COLORS.fg : COLORS.fgOnLight;
    const key = `${state.channel !== null}|${state.muted}|${state.deafened}|${fg}`;
    if (key === shown && !force) return;
    shown = key;
    const buttons: ThumbarButton[] =
      state.channel === null
        ? []
        : [
            {
              tooltip: state.muted ? 'Ligar microfone' : 'Mutar microfone',
              icon: iconImage(microphoneDrawing(state.muted, fg)),
              click: () => call.act('toggle-mute'),
            },
            {
              tooltip: state.deafened ? 'Ligar áudio' : 'Desligar áudio',
              icon: iconImage(headphonesDrawing(state.deafened, fg)),
              click: () => call.act('toggle-deafen'),
            },
            {
              tooltip: 'Desconectar',
              icon: iconImage(hangUpDrawing()),
              click: () => call.act('disconnect'),
            },
          ];
    window.setThumbarButtons(buttons);
  };

  const unsubscribe = call.subscribe((state) => apply(state));
  const onTheme = () => apply(call.current());
  nativeTheme.on('updated', onTheme);
  // Hiding the window (in the notification area) loses its taskbar button and the buttons
  // with it; they are put back when it shows again.
  const onShow = () => apply(call.current(), true);
  window.on('show', onShow);
  window.once('closed', () => {
    unsubscribe();
    nativeTheme.off('updated', onTheme);
  });
}
