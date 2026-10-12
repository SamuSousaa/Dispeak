import { QueryClient } from '@tanstack/react-query';

/** The one cache of server state. Exported for code outside React, such as menus built on click. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});
