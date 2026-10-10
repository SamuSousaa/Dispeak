import {
  attachmentSchema,
  featuresSchema,
  gifPageSchema,
  linkPreviewSchema,
  messagePageSchema,
  messageSchema,
  unreadResponseSchema,
  type CreatePoll,
  type GatewayEventData,
  type Message,
  type MessagePage,
} from '@frequencia/shared';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { api, apiBlob } from '../../lib/http';

export const chatApi = {
  list: (channelId: string, before?: string) =>
    api('GET', `/channels/${channelId}/messages${before ? `?before=${before}` : ''}`, {
      schema: messagePageSchema,
    }),
  send: (
    channelId: string,
    content: string,
    attachmentIds: string[] = [],
    replyToId: string | null = null,
    poll: CreatePoll | null = null,
  ) =>
    api('POST', `/channels/${channelId}/messages`, {
      body: { content, attachmentIds, replyToId, poll },
      schema: messageSchema,
    }),
  /** Stores a file on the server; its id goes into the next `send`. */
  upload: (channelId: string, file: File) =>
    api(
      'POST',
      `/channels/${channelId}/attachments?filename=${encodeURIComponent(file.name || 'arquivo')}`,
      // Sent as opaque bytes: the server decides what it is from the content.
      { body: new Blob([file], { type: 'application/octet-stream' }), schema: attachmentSchema },
    ),
  attachmentBlob: (attachmentId: string) => apiBlob(`/attachments/${attachmentId}`),
  /** Uploads the files one by one, then sends the message that carries them. */
  sendWithFiles: async (
    channelId: string,
    content: string,
    files: File[],
    replyToId: string | null = null,
  ) => {
    const attachmentIds: string[] = [];
    for (const file of files) attachmentIds.push((await chatApi.upload(channelId, file)).id);
    return chatApi.send(channelId, content, attachmentIds, replyToId);
  },
  edit: (messageId: string, content: string) =>
    api('PATCH', `/messages/${messageId}`, { body: { content }, schema: messageSchema }),
  delete: (messageId: string) => api('DELETE', `/messages/${messageId}`),
  typing: (channelId: string) => api('POST', `/channels/${channelId}/typing`),
  vote: (messageId: string, optionIds: string[]) =>
    api('PUT', `/messages/${messageId}/poll/votes`, {
      body: { optionIds },
      schema: messageSchema,
    }),
  react: (messageId: string, emoji: string) =>
    api('PUT', `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
      schema: messageSchema,
    }),
  unreact: (messageId: string, emoji: string) =>
    api('DELETE', `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
      schema: messageSchema,
    }),
  unread: () => api('GET', '/users/@me/unread', { schema: unreadResponseSchema }),
  ack: (channelId: string) => api('POST', `/channels/${channelId}/ack`),
  features: () => api('GET', '/features', { schema: featuresSchema }),
  unfurl: (url: string) =>
    api('GET', `/unfurl?url=${encodeURIComponent(url)}`, { schema: linkPreviewSchema.nullable() }),
  gifs: (query: string) =>
    api('GET', `/gifs?q=${encodeURIComponent(query)}`, { schema: gifPageSchema }),
};

export const messagesKey = (channelId: string) => ['messages', channelId] as const;

/** Pages as TanStack Query keeps them: the newest page first, each page oldest-first. */
export type MessageCache = InfiniteData<MessagePage, unknown>;

/** All loaded messages of a channel in chronological order. */
export function flattenMessages(cache: MessageCache | undefined): Message[] {
  return cache ? [...cache.pages].reverse().flatMap((page) => page.messages) : [];
}

function mapPages(cache: MessageCache, update: (messages: Message[]) => Message[]): MessageCache {
  return {
    ...cache,
    pages: cache.pages.map((page) => ({ ...page, messages: update(page.messages) })),
  };
}

/** Pure cache transitions for the three message events. */
export const messageCache = {
  add(cache: MessageCache, message: Message): MessageCache {
    const [newest, ...older] = cache.pages;
    if (!newest || flattenMessages(cache).some((entry) => entry.id === message.id)) return cache;
    return { ...cache, pages: [{ ...newest, messages: [...newest.messages, message] }, ...older] };
  },
  update(cache: MessageCache, message: Message): MessageCache {
    return mapPages(cache, (messages) =>
      messages.map((entry) => (entry.id === message.id ? message : entry)),
    );
  },
  remove(cache: MessageCache, messageId: string): MessageCache {
    return mapPages(cache, (messages) => messages.filter((entry) => entry.id !== messageId));
  },
};

// --- typing ---------------------------------------------------------------------------------

/** A typing notice is forgotten after this long without a refresh. */
export const TYPING_TTL_MS = 8000;

interface TypingState {
  /** channel id -> user id -> timestamp at which the notice expires. */
  typing: Record<string, Record<string, number>>;
}

export const useTypingStore = create<TypingState>(() => ({ typing: {} }));

function setTyping(channelId: string, userId: string, expiresAt: number | null): void {
  useTypingStore.setState((state) => {
    const { [userId]: _previous, ...others } = state.typing[channelId] ?? {};
    return {
      typing: {
        ...state.typing,
        [channelId]: expiresAt === null ? others : { ...others, [userId]: expiresAt },
      },
    };
  });
}

/** Applies a chat-related gateway event to the query cache and the typing store. */
export function applyChatEvent(queryClient: QueryClient, t: string, data: unknown): void {
  switch (t) {
    case 'MESSAGE_CREATE': {
      const message = data as GatewayEventData<'MESSAGE_CREATE'>;
      queryClient.setQueryData<MessageCache>(messagesKey(message.channelId), (cache) =>
        cache ? messageCache.add(cache, message) : cache,
      );
      // Sending a message ends the "typing" notice of its author.
      setTyping(message.channelId, message.author.id, null);
      break;
    }
    case 'MESSAGE_UPDATE': {
      const message = data as GatewayEventData<'MESSAGE_UPDATE'>;
      queryClient.setQueryData<MessageCache>(messagesKey(message.channelId), (cache) =>
        cache ? messageCache.update(cache, message) : cache,
      );
      break;
    }
    case 'MESSAGE_DELETE': {
      const { id, channelId } = data as GatewayEventData<'MESSAGE_DELETE'>;
      queryClient.setQueryData<MessageCache>(messagesKey(channelId), (cache) =>
        cache ? messageCache.remove(cache, id) : cache,
      );
      break;
    }
    case 'TYPING_START': {
      const { channelId, userId } = data as GatewayEventData<'TYPING_START'>;
      setTyping(channelId, userId, Date.now() + TYPING_TTL_MS);
      break;
    }
    case 'READY':
      // A fresh session may have missed messages: refetch whatever is on screen.
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      break;
  }
}
