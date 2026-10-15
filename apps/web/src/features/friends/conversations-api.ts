import { blockListSchema, guildSchema } from '@frequencia/shared';
import { create } from 'zustand';
import { api } from '../../lib/http';

/** Private conversations with anyone, message requests and blocking (ADR 0015). */
export const conversationsApi = {
  /** The conversation with someone, started when there is none. */
  open: (userId: string) => api('POST', `/users/${userId}/conversation`, { schema: guildSchema }),
  accept: (guildId: string) => api('POST', `/conversations/${guildId}/accept`),
  decline: (guildId: string) => api('POST', `/conversations/${guildId}/decline`),
  blocks: async () => (await api('GET', '/users/@me/blocks', { schema: blockListSchema })).users,
  block: (userId: string) => api('PUT', `/users/@me/blocks/${userId}`),
  unblock: (userId: string) => api('DELETE', `/users/@me/blocks/${userId}`),
};

/** Query key of the list of blocked people; the gateway invalidates it. */
export const BLOCKS_KEY = ['blocks'] as const;

/** Ids of the people this user blocks, from READY and BLOCKS_UPDATE. */
export const useBlockStore = create<string[]>(() => []);

export const useIsBlocked = (userId: string | undefined): boolean =>
  useBlockStore((ids) => (userId ? ids.includes(userId) : false));
