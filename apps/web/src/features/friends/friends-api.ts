import {
  friendRequestsResponseSchema,
  guildSchema,
  sendFriendRequestResponseSchema,
} from '@frequencia/shared';
import { api } from '../../lib/http';

/** Query key of the pending friend requests; gateway events invalidate it. */
export const FRIEND_REQUESTS_KEY = ['friend-requests'] as const;

/** Thin, typed wrappers over the REST API. Conversations come and go through the gateway. */
export const friendsApi = {
  requests: async () =>
    (await api('GET', '/friends/requests', { schema: friendRequestsResponseSchema })).requests,
  ask: (username: string) =>
    api('POST', '/friends/requests', {
      body: { username },
      schema: sendFriendRequestResponseSchema,
    }),
  accept: (requestId: string) =>
    api('POST', `/friends/requests/${requestId}/accept`, { schema: guildSchema }),
  /** Declines a request received, or withdraws one that was sent. */
  dismiss: (requestId: string) => api('DELETE', `/friends/requests/${requestId}`),
  /** Ends the friendship: the conversation is deleted for both. */
  remove: (userId: string) => api('DELETE', `/friends/${userId}`),
};
