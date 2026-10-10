import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  /** The text chat docked next to a voice channel. */
  sideChatOpen: boolean;
  /** Text channel last opened in each guild; the side chat starts there. */
  lastTextChannel: Record<string, string>;
}

/** Where things were left on this device. */
export const useUiStore = create<UiState>()(
  persist(() => ({ sideChatOpen: false, lastTextChannel: {} }) as UiState, {
    name: 'frequencia.ui',
    version: 1,
  }),
);

export function toggleSideChat(): void {
  useUiStore.setState((state) => ({ sideChatOpen: !state.sideChatOpen }));
}

export function rememberTextChannel(guildId: string, channelId: string): void {
  if (useUiStore.getState().lastTextChannel[guildId] === channelId) return;
  useUiStore.setState((state) => ({
    lastTextChannel: { ...state.lastTextChannel, [guildId]: channelId },
  }));
}
