import type { DesktopCallState } from '@frequencia/shared';
import { nativeTheme, type BrowserWindow, type ThumbarButton } from 'electron';
import { z } from 'zod';
import { iconImage, type CallControls } from './call-state';
import { COLORS, hangUpDrawing, headphonesDrawing, microphoneDrawing } from './icons';
import { nativeHost } from './native-host';

/** Long enough for Windows to have made the window's taskbar button after it shows. */
const AFTER_SHOW_MS = 400;

/**
 * Buttons under the window's thumbnail on the taskbar, as Discord has: the microphone, the
 * sound and, in a call, hanging up. Windows only.
 *
 * Electron adds the buttons the first time they are set and only updates them afterwards, even
 * when that first time failed because the window had no taskbar button yet; and hiding the
 * window (in the notification area) makes Windows drop the button and the buttons with it. So
 * they are set only once the window shows and, when it shows again after being hidden, the
 * app's Windows helper sends it the "taskbar created" message, which makes Electron add them
 * again from scratch. Sent while the buttons exist, it would break their updates instead.
 */
export function serveThumbar(window: BrowserWindow, call: CallControls): void {
  if (process.platform !== 'win32') return;
  let shown = '';
  let ready = false;
  /** The window was hidden: its taskbar button, made again, has no buttons. */
  let wasHidden = false;

  const apply = (state: DesktopCallState, force = false) => {
    if (window.isDestroyed() || !ready) return;
    const fg = nativeTheme.shouldUseDarkColors ? COLORS.fg : COLORS.fgOnLight;
    const key = `${state.channel !== null}|${state.muted}|${state.deafened}|${fg}`;
    if (key === shown && !force) return;
    shown = key;
    // Like Discord: the microphone and the sound are always there (outside a call they set how
    // the next one starts); hanging up works only in one. Always three buttons, the last one
    // greyed out rather than hidden: Windows does not bring back a button that started hidden.
    const inCall = state.channel !== null;
    const buttons: ThumbarButton[] = [
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
        // An explicit ['enabled'] makes Electron's update fail: no flags at all means enabled.
        ...(inCall ? {} : { flags: ['disabled'] }),
        click: () => call.act('disconnect'),
      },
    ];
    if (!window.setThumbarButtons(buttons)) {
      console.warn('[thumbar] Windows refused the taskbar buttons');
    }
  };

  const unsubscribe = call.subscribe((state) => apply(state));
  const onTheme = () => apply(call.current());
  nativeTheme.on('updated', onTheme);
  const onShow = () => {
    setTimeout(() => {
      if (window.isDestroyed()) return;
      ready = true;
      if (!wasHidden) {
        apply(call.current(), true);
        return;
      }
      wasHidden = false;
      // Electron adds the buttons again on this message, then takes updates as before.
      const handle = Number(window.getNativeWindowHandle().readBigInt64LE());
      void nativeHost
        .request('announceTaskbar', { handle }, z.object({ done: z.boolean() }))
        .catch(() => undefined)
        .finally(() => setTimeout(() => apply(call.current(), true), AFTER_SHOW_MS));
    }, AFTER_SHOW_MS);
  };
  const onHide = () => {
    ready = false;
    wasHidden = true;
  };
  window.on('show', onShow);
  window.on('hide', onHide);
  window.once('closed', () => {
    unsubscribe();
    nativeTheme.off('updated', onTheme);
  });
}
