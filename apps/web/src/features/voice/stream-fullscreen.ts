interface FullscreenTarget {
  toggle: () => void;
  focused: boolean;
}

/** How long a fullscreen request waits for its stream; the browser's own allowance is ~5 s. */
const PENDING_MS = 4000;

// Stream tiles on screen, so the keyboard shortcut can reach one without knowing the DOM.
const targets = new Map<string, FullscreenTarget>();
let pending: { id: string; until: number } | null = null;

export function registerStreamFullscreen(id: string, target: FullscreenTarget): () => void {
  targets.set(id, target);
  if (pending?.id === id) {
    if (Date.now() < pending.until && !document.fullscreenElement) target.toggle();
    pending = null;
  }
  return () => {
    if (targets.get(id) === target) targets.delete(id);
  };
}

/** Asks for fullscreen on a stream that is not on screen yet. */
export function fullscreenWhenShown(id: string): void {
  pending = { id, until: Date.now() + PENDING_MS };
}

/**
 * Toggles fullscreen on the focused stream, or on the first one on screen. Returns false
 * when there was nothing to act on.
 */
export function toggleStreamFullscreen(): boolean {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return true;
  }
  const all = [...targets.values()];
  const target = all.find((entry) => entry.focused) ?? all[0];
  target?.toggle();
  return Boolean(target);
}
