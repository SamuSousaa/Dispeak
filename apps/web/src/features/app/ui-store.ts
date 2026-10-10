import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  /** The text chat of a voice channel, docked next to the call. */
  sideChatOpen: boolean;
  /** Categories folded away in the channel list, by id. */
  collapsed: Record<string, true>;
}

/** Where things were left on this device. */
export const useUiStore = create<UiState>()(
  persist(() => ({ sideChatOpen: false, collapsed: {} }) as UiState, {
    name: 'frequencia.ui',
    version: 2,
    // Older versions kept other things here; start from the defaults.
    migrate: () => ({ sideChatOpen: false, collapsed: {} }),
  }),
);

export function toggleSideChat(): void {
  useUiStore.setState((state) => ({ sideChatOpen: !state.sideChatOpen }));
}

export function toggleCollapsed(categoryId: string): void {
  useUiStore.setState((state) => {
    const { [categoryId]: folded, ...others } = state.collapsed;
    return { collapsed: folded ? others : { ...others, [categoryId]: true } };
  });
}
