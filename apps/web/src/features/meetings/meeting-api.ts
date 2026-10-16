import {
  API_PREFIX,
  MEETING_KEY_HEADER,
  meetingCreatedSchema,
  meetingKnockResponseSchema,
  meetingPreviewSchema,
  voiceTokenResponseSchema,
} from '@frequencia/shared';
import type { z } from 'zod';
import { getAccessToken, toApiError, useAuthStore } from '../auth/auth-store';
import { api } from '../../lib/http';

/**
 * Requests about a meeting. Inside one, a person is who their meeting key says, signed in or
 * not; knocking goes with the access token when there is one, so a user keeps their name.
 */
async function meetingRequest<S extends z.ZodType | undefined>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: { key?: string; body?: unknown; schema?: S; signedIn?: boolean } = {},
): Promise<S extends z.ZodType ? z.infer<S> : undefined> {
  const token =
    options.signedIn && useAuthStore.getState().status === 'authenticated'
      ? await getAccessToken()
      : null;
  const response = await fetch(`${API_PREFIX}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.key ? { [MEETING_KEY_HEADER]: options.key } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) throw await toApiError(response);
  if (!options.schema || response.status === 204) {
    return undefined as S extends z.ZodType ? z.infer<S> : undefined;
  }
  return options.schema.parse(await response.json()) as S extends z.ZodType
    ? z.infer<S>
    : undefined;
}

export const meetingApi = {
  create: () => api('POST', '/meetings', { schema: meetingCreatedSchema }),
  preview: (id: string) =>
    meetingRequest('GET', `/meetings/${id}`, { schema: meetingPreviewSchema }),
  knock: (id: string, name: string | undefined) =>
    meetingRequest('POST', `/meetings/${id}/knock`, {
      body: name ? { name } : {},
      schema: meetingKnockResponseSchema,
      signedIn: true,
    }),
  admit: (id: string, key: string, requestId: string) =>
    meetingRequest('POST', `/meetings/${id}/waiting/${requestId}/admit`, { key }),
  deny: (id: string, key: string, requestId: string) =>
    meetingRequest('POST', `/meetings/${id}/waiting/${requestId}/deny`, { key }),
  say: (id: string, key: string, content: string) =>
    meetingRequest('POST', `/meetings/${id}/messages`, { key, body: { content } }),
  mute: (id: string, key: string, participantId: string, muted: boolean) =>
    meetingRequest('PUT', `/meetings/${id}/participants/${participantId}/mute`, {
      key,
      body: { muted },
    }),
  remove: (id: string, key: string, participantId: string) =>
    meetingRequest('DELETE', `/meetings/${id}/participants/${participantId}`, { key }),
  voiceToken: (id: string, key: string) =>
    meetingRequest('POST', `/meetings/${id}/voice-token`, {
      key,
      schema: voiceTokenResponseSchema,
    }),
  end: (id: string, key: string) => meetingRequest('POST', `/meetings/${id}/end`, { key }),
};
