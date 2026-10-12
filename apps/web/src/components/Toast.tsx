import { ghostDown } from '../lib/exit-ghost';
import { create } from 'zustand';
import { describeError } from '../lib/http';

interface ToastState {
  message: string | null;
  tone: 'danger' | 'info';
}

const useToastStore = create<ToastState>(() => ({ message: null, tone: 'danger' }));
let timer: number | undefined;

/**
 * Shows a short notice at the bottom of the screen; a new one replaces the previous. It reads
 * as a failure unless `tone` says it is only news.
 */
export function toast(message: string, tone: ToastState['tone'] = 'danger'): void {
  window.clearTimeout(timer);
  useToastStore.setState({ message, tone });
  timer = window.setTimeout(() => useToastStore.setState({ message: null }), 4500);
}

/**
 * Runs an action started from a menu, where there is no form to show a failure in: the reason
 * goes to a toast instead of being swallowed.
 */
export function attempt(action: () => Promise<unknown>): void {
  action().catch((error: unknown) => toast(describeError(error)));
}

/** Mount once, near the root. */
export function ToastHost() {
  const message = useToastStore((state) => state.message);
  const tone = useToastStore((state) => state.tone);
  if (!message) return null;
  return (
    <p
      ref={ghostDown}
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid="toast"
      className={`anim-pop label fixed bottom-10 left-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 border bg-bg px-3 py-2 ${
        tone === 'danger' ? 'border-danger text-danger' : 'border-line-strong text-fg'
      }`}
    >
      {message}
    </p>
  );
}
