import { useEffect, useRef, type MouseEvent } from 'react';

/** Longer than a double click takes, so the second click can still call the first one off. */
const DOUBLE_CLICK_MS = 250;

/**
 * Click handlers of a tile of the stage: one click gives it the main area, one click on the
 * tile that already has it hands the area back, and two clicks go to the whole screen. Handing
 * back waits a moment, so a double click does not rearrange the stage on its way to fullscreen.
 */
export function useFocusClick({
  focused,
  fullscreen,
  onToggleFocus,
  onFullscreen,
}: {
  focused: boolean;
  fullscreen: boolean;
  onToggleFocus?: () => void;
  onFullscreen?: () => void;
}) {
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return {
    onClick: (event: MouseEvent) => {
      // The second click of a double click belongs to `onDoubleClick`; the keyboard sends 0.
      if (event.detail > 1 || fullscreen || !onToggleFocus) return;
      window.clearTimeout(timer.current);
      if (focused && event.detail === 1 && onFullscreen) {
        timer.current = window.setTimeout(onToggleFocus, DOUBLE_CLICK_MS);
      } else {
        onToggleFocus();
      }
    },
    onDoubleClick: () => {
      window.clearTimeout(timer.current);
      onFullscreen?.();
    },
  };
}
