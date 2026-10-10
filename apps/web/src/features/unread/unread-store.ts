import { APP_NAME, type GatewayEventData, type Message } from '@frequencia/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { chatApi } from '../chat/chat-store';

export interface ChannelUnread {
  guildId: string;
  count: number;
  /** Messages that mention the user, answer them or mention everyone. */
  mentions: number;
}

interface UnreadState {
  /** Text channels with messages the user has not seen, by channel id. */
  channels: Record<string, ChannelUnread>;
}

export const useUnreadStore = create<UnreadState>(() => ({ channels: {} }));

/** Whether a message is addressed to the user. */
export const mentionsUser = (message: Message, userId: string) =>
  message.mentionEveryone || message.mentions.includes(userId);

/** Pure transitions of the unread counters. */
export const unreadState = {
  add(state: UnreadState, message: Message, userId: string): UnreadState {
    if (message.author.id === userId) return state;
    const current = state.channels[message.channelId];
    return {
      channels: {
        ...state.channels,
        [message.channelId]: {
          guildId: message.guildId,
          count: (current?.count ?? 0) + 1,
          mentions: (current?.mentions ?? 0) + (mentionsUser(message, userId) ? 1 : 0),
        },
      },
    };
  },
  clear(state: UnreadState, channelId: string): UnreadState {
    if (!state.channels[channelId]) return state;
    const { [channelId]: _read, ...channels } = state.channels;
    return { channels };
  },
  clearGuild(state: UnreadState, guildId: string): UnreadState {
    return {
      channels: Object.fromEntries(
        Object.entries(state.channels).filter(([, entry]) => entry.guildId !== guildId),
      ),
    };
  },
};

/** Totals over a set of channels, e.g. the ones of a guild. */
export function sumUnread(entries: ChannelUnread[]): { count: number; mentions: number } {
  return entries.reduce(
    (total, entry) => ({
      count: total.count + entry.count,
      mentions: total.mentions + entry.mentions,
    }),
    { count: 0, mentions: 0 },
  );
}

// --- what is on screen ------------------------------------------------------------------------

/** Channels whose messages are on screen right now (a channel may be shown in two places). */
const viewing = new Map<string, number>();

const attentive = () => document.visibilityState === 'visible' && document.hasFocus();
const isReading = (channelId: string) => (viewing.get(channelId) ?? 0) > 0 && attentive();

const ackTimers = new Map<string, number>();

/** Tells the server, soon, that the channel was read; bursts of messages need one call. */
function scheduleAck(channelId: string): void {
  if (ackTimers.has(channelId)) return;
  ackTimers.set(
    channelId,
    window.setTimeout(() => {
      ackTimers.delete(channelId);
      void chatApi.ack(channelId).catch(() => undefined);
    }, 1000),
  );
}

/** Marks a channel as read, here and on the server. */
export function markRead(channelId: string): void {
  useUnreadStore.setState((state) => unreadState.clear(state, channelId));
  scheduleAck(channelId);
}

export function markGuildRead(guildId: string): void {
  const { channels } = useUnreadStore.getState();
  for (const [channelId, entry] of Object.entries(channels)) {
    if (entry.guildId === guildId) scheduleAck(channelId);
  }
  useUnreadStore.setState((state) => unreadState.clearGuild(state, guildId));
}

/** Loads what piled up while the user was away. */
export async function loadUnread(): Promise<void> {
  const { channels } = await chatApi.unread();
  useUnreadStore.setState({
    channels: Object.fromEntries(
      channels.map(({ channelId, ...entry }) => [channelId, entry] as const),
    ),
  });
  for (const { channelId } of channels) {
    if (isReading(channelId)) markRead(channelId);
  }
}

/**
 * Keeps the counters current from gateway events. Returns the message when it should also be
 * announced to the user (it mentions them and they are not looking at it).
 */
export function applyUnreadEvent(t: string, data: unknown, userId: string): Message | null {
  switch (t) {
    case 'READY':
      void loadUnread().catch(() => undefined);
      return null;
    case 'MESSAGE_CREATE': {
      const message = data as GatewayEventData<'MESSAGE_CREATE'>;
      if (message.author.id === userId) return null;
      if (isReading(message.channelId)) {
        scheduleAck(message.channelId);
        return null;
      }
      useUnreadStore.setState((state) => unreadState.add(state, message, userId));
      return mentionsUser(message, userId) ? message : null;
    }
    case 'CHANNEL_DELETE': {
      const { id } = data as GatewayEventData<'CHANNEL_DELETE'>;
      useUnreadStore.setState((state) => unreadState.clear(state, id));
      return null;
    }
    case 'GUILD_DELETE': {
      const { id } = data as GatewayEventData<'GUILD_DELETE'>;
      useUnreadStore.setState((state) => unreadState.clearGuild(state, id));
      return null;
    }
    default:
      return null;
  }
}

/** Declares that a channel's messages are on screen: it is read now and stays read. */
export function useViewingChannel(channelId: string): void {
  useEffect(() => {
    viewing.set(channelId, (viewing.get(channelId) ?? 0) + 1);
    const catchUp = () => {
      if (isReading(channelId) && useUnreadStore.getState().channels[channelId]) {
        markRead(channelId);
      }
    };
    catchUp();
    // Coming back to the tab reads whatever arrived in the meantime.
    window.addEventListener('focus', catchUp);
    document.addEventListener('visibilitychange', catchUp);
    return () => {
      window.removeEventListener('focus', catchUp);
      document.removeEventListener('visibilitychange', catchUp);
      const left = (viewing.get(channelId) ?? 1) - 1;
      if (left > 0) viewing.set(channelId, left);
      else viewing.delete(channelId);
    };
  }, [channelId]);
}

export const useChannelUnread = (channelId: string): ChannelUnread | undefined =>
  useUnreadStore((state) => state.channels[channelId]);

const APP_TITLE = APP_NAME;

/** Shows what is waiting in the tab title: `(3)` for mentions, a dot for anything unread. */
export function useUnreadTitle(): void {
  const channels = useUnreadStore((state) => state.channels);
  useEffect(() => {
    const { count, mentions } = sumUnread(Object.values(channels));
    document.title =
      mentions > 0 ? `(${mentions}) ${APP_TITLE}` : count > 0 ? `• ${APP_TITLE}` : APP_TITLE;
    return () => {
      document.title = APP_TITLE;
    };
  }, [channels]);
}
