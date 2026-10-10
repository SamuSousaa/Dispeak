import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  /** The text chat of a voice channel, docked next to the call. */
  sideChatOpen: boolean;
  /** Categories folded away in the channel list, by id. */
  collapsed: Record<string, true>;
  /** Emojis picked lately, most recent first. */
  recentEmojis: string[];
}

const RECENT_EMOJIS = 27;

/** Where things were left on this device. */
export const useUiStore = create<UiState>()(
  persist(() => ({ sideChatOpen: false, collapsed: {}, recentEmojis: [] }) as UiState, {
    name: 'frequencia.ui',
    version: 3,
    // Older versions kept other things here; start from the defaults.
    migrate: () => ({ sideChatOpen: false, collapsed: {}, recentEmojis: [] }),
  }),
);

export function toggleSideChat(): void {
  useUiStore.setState((state) => ({ sideChatOpen: !state.sideChatOpen }));
}

export function rememberEmoji(emoji: string): void {
  useUiStore.setState((state) => ({
    recentEmojis: [emoji, ...state.recentEmojis.filter((entry) => entry !== emoji)].slice(
      0,
      RECENT_EMOJIS,
    ),
  }));
}

export function toggleCollapsed(categoryId: string): void {
  useUiStore.setState((state) => {
    const { [categoryId]: folded, ...others } = state.collapsed;
    return { collapsed: folded ? others : { ...others, [categoryId]: true } };
  });
}
