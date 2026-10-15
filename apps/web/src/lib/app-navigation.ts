type Navigate = (path: string) => void;

/**
 * Lets code outside a component (a menu entry, a notification) move the app to a page. The
 * app's page registers the router's navigate function while it is mounted.
 */
let navigate: Navigate | null = null;

/** Registers the function that changes page. Returns the function that unregisters it. */
export function registerNavigation(next: Navigate): () => void {
  navigate = next;
  return () => {
    if (navigate === next) navigate = null;
  };
}

export function navigateTo(path: string): void {
  navigate?.(path);
}
