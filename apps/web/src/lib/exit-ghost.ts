/** The way out: back down, back up, shrinking in place, or off to the side it came from. */
export type GhostExit = 'down' | 'up' | 'scale' | 'side';

const GHOST_MS = 400;

/**
 * Gives an element a way out. React removes what is no longer rendered at once, so a panel
 * that closes would simply vanish: the function returned here, called while the element is
 * being taken away (a ref's cleanup, a layout effect's cleanup), leaves a lifeless copy in its
 * place for the length of an exit animation. The copy is only a picture: hidden from assistive
 * technology, not focusable, without ids or test ids.
 */
export function exitGhost(
  element: HTMLElement,
  exit: GhostExit,
  options: {
    /** Dim the page behind the copy and fade that out too, as a modal's backdrop does. */
    backdrop?: boolean;
    /** Asked at the last moment: `true` when the element has already played its way out. */
    skip?: () => boolean;
  } = {},
): () => void {
  return () => {
    if (options.skip?.()) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const ghost = element.cloneNode(true) as HTMLElement;

    // React's development rehearsal runs cleanups of things that stay: only a real removal,
    // seen once the commit is over, gets a ghost.
    queueMicrotask(() => {
      if (element.isConnected) return;
      for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>('*')]) {
        for (const name of ['id', 'data-testid', 'role', 'aria-label', 'aria-live', 'for']) {
          node.removeAttribute(name);
        }
      }
      ghost.setAttribute('aria-hidden', 'true');
      ghost.setAttribute('inert', '');
      ghost.dataset.ghost = exit;
      Object.assign(ghost.style, {
        left: `${box.left}px`,
        top: `${box.top}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${box.width}px`,
        height: `${box.height}px`,
        maxWidth: 'none',
        maxHeight: 'none',
        translate: 'none',
      });

      const pieces: HTMLElement[] = [ghost];
      if (options.backdrop) {
        const backdrop = document.createElement('div');
        backdrop.dataset.ghostBackdrop = '';
        backdrop.setAttribute('aria-hidden', 'true');
        pieces.unshift(backdrop);
      }
      const remove = () => pieces.forEach((piece) => piece.remove());
      ghost.addEventListener('animationend', (event) => {
        if (event.target === ghost) remove();
      });
      // An animation that never runs (a hidden tab) must not leave the copy behind.
      window.setTimeout(remove, GHOST_MS);
      document.body.append(...pieces);
    });
  };
}

/** Refs for panels that open upwards (and leave downwards) or drop down (and leave upwards). */
export const ghostDown = (element: HTMLElement | null) =>
  element ? exitGhost(element, 'down') : undefined;
export const ghostUp = (element: HTMLElement | null) =>
  element ? exitGhost(element, 'up') : undefined;
