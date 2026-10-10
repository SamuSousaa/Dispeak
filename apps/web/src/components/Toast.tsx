import { create } from 'zustand';
import { describeError } from '../lib/http';

interface ToastState {
  message: string | null;
}

const useToastStore = create<ToastState>(() => ({ message: null }));
let timer: number | undefined;

/** Shows a short notice at the bottom of the screen; a new one replaces the previous. */
export function toast(message: string): void {
  window.clearTimeout(timer);
  useToastStore.setState({ message });
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
  if (!message) return null;
  return (
    <p
      role="alert"
      data-testid="toast"
      className="anim-pop label fixed bottom-10 left-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 border border-danger bg-bg px-3 py-2 text-danger"
    >
      {message}
    </p>
  );
}
