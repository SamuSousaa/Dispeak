import {
  apiErrorSchema,
  MEETING_KEY_HEADER,
  MEETING_SOCKET_ROUTE,
  meetingCreatedSchema,
  meetingIdSchema,
  meetingKeySchema,
  meetingKnockRequestSchema,
  meetingKnockResponseSchema,
  meetingMessageRequestSchema,
  meetingMessageSchema,
  meetingMuteRequestSchema,
  meetingPreviewSchema,
  meetingStateSchema,
  voiceTokenResponseSchema,
} from '@frequencia/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { unauthorized } from '../../errors';

const params = z.object({ meetingId: meetingIdSchema });
const requestParams = params.extend({ requestId: z.string().min(1).max(64) });
const participantParams = params.extend({ participantId: z.string().min(1).max(64) });
/** Who is asking, inside the meeting. */
const keyed = z.object({ [MEETING_KEY_HEADER]: meetingKeySchema });
const errors = { 400: apiErrorSchema, 403: apiErrorSchema, 404: apiErrorSchema };

export const meetingRoutes: FastifyPluginAsyncZod = async (app) => {
  const { meetings, auth, config } = app.ctx;
  // Creating and knocking are what a stranger with a link can do: as tight as signing in.
  const strict = { rateLimit: { max: config.RATE_LIMIT_AUTH_MAX, timeWindow: '1 minute' } };
  const keyOf = (request: FastifyRequest) => {
    const key = request.headers[MEETING_KEY_HEADER];
    if (typeof key !== 'string') throw unauthorized('meeting key required');
    return key;
  };
  /** The signed-in user, if any: guests come in with a name instead. */
  const viewer = async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    return token ? ((await auth.authenticate(token))?.userId ?? null) : null;
  };

  app.post(
    '/meetings',
    {
      onRequest: [app.authenticate],
      config: strict,
      schema: {
        tags: ['meetings'],
        summary: 'Start a meeting: a call outside any server, reached by its link',
        security: [{ bearerAuth: [] }],
        response: { 201: meetingCreatedSchema },
      },
    },
    async (request, reply) => reply.code(201).send(await meetings.create(request.auth.userId)),
  );

  app.get(
    '/meetings/:meetingId',
    {
      schema: {
        tags: ['meetings'],
        summary: 'Whether a meeting exists, and whose it is (anyone with the link)',
        params,
        response: { 200: meetingPreviewSchema, 404: apiErrorSchema },
      },
    },
    (request) => meetings.preview(request.params.meetingId),
  );

  app.post(
    '/meetings/:meetingId/knock',
    {
      config: strict,
      schema: {
        tags: ['meetings'],
        summary: 'Ask to come in; a guest gives a name, a signed-in user goes by theirs',
        description:
          'Answers with a key to wait with on the socket, or, for the host, the key to come in.',
        params,
        body: meetingKnockRequestSchema,
        response: { 200: meetingKnockResponseSchema, ...errors, 409: apiErrorSchema },
      },
    },
    async (request) =>
      meetings.knock(request.params.meetingId, {
        userId: await viewer(request),
        name: request.body.name,
      }),
  );

  app.get(
    '/meetings/:meetingId/state',
    {
      schema: {
        tags: ['meetings'],
        summary: 'Everything someone inside sees: people, the door, the chat',
        params,
        headers: keyed,
        response: { 200: meetingStateSchema, ...errors },
      },
    },
    (request) => meetings.state(request.params.meetingId, keyOf(request)),
  );

  app.post(
    '/meetings/:meetingId/waiting/:requestId/admit',
    {
      schema: {
        tags: ['meetings'],
        summary: 'Let someone at the door in (anyone inside may)',
        params: requestParams,
        headers: keyed,
        response: { 204: z.null(), ...errors, 409: apiErrorSchema },
      },
    },
    async (request, reply) => {
      await meetings.admit(request.params.meetingId, keyOf(request), request.params.requestId);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/meetings/:meetingId/waiting/:requestId/deny',
    {
      schema: {
        tags: ['meetings'],
        summary: 'Turn someone at the door away',
        params: requestParams,
        headers: keyed,
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      await meetings.deny(request.params.meetingId, keyOf(request), request.params.requestId);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/meetings/:meetingId/messages',
    {
      config: { rateLimit: { max: config.RATE_LIMIT_MESSAGES_MAX, timeWindow: '1 minute' } },
      schema: {
        tags: ['meetings'],
        summary: 'Say something in the meeting chat; it goes when the meeting does',
        params,
        headers: keyed,
        body: meetingMessageRequestSchema,
        response: { 201: meetingMessageSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await meetings.say(request.params.meetingId, keyOf(request), request.body.content)),
  );

  app.put(
    '/meetings/:meetingId/participants/:participantId/mute',
    {
      schema: {
        tags: ['meetings'],
        summary: 'Mute someone for everyone, or give their microphone back (host only)',
        params: participantParams,
        headers: keyed,
        body: meetingMuteRequestSchema,
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      const { meetingId, participantId } = request.params;
      await meetings.setMuted(meetingId, keyOf(request), participantId, request.body.muted);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    '/meetings/:meetingId/participants/:participantId',
    {
      schema: {
        tags: ['meetings'],
        summary: 'Take someone out of the meeting (host only); they can knock again',
        params: participantParams,
        headers: keyed,
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      const { meetingId, participantId } = request.params;
      await meetings.remove(meetingId, keyOf(request), participantId);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/meetings/:meetingId/voice-token',
    {
      schema: {
        tags: ['meetings'],
        summary: 'Token to join the meeting call on the media service',
        params,
        headers: keyed,
        response: { 200: voiceTokenResponseSchema, ...errors },
      },
    },
    (request) => meetings.voiceToken(request.params.meetingId, keyOf(request)),
  );

  app.post(
    '/meetings/:meetingId/end',
    {
      schema: {
        tags: ['meetings'],
        summary: 'End the meeting for everyone (host only); everything in it is deleted',
        params,
        headers: keyed,
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      await meetings.end(request.params.meetingId, keyOf(request));
      return reply.code(204).send(null);
    },
  );

  app.get(
    MEETING_SOCKET_ROUTE,
    { websocket: true, schema: { hide: true, params } },
    (socket, request) => meetings.accept(socket, request.params.meetingId),
  );
};
