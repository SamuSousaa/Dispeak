import {
  apiErrorSchema,
  authResponseSchema,
  loginRequestSchema,
  registerRequestSchema,
  changePasswordRequestSchema,
  resetPasswordRequestSchema,
  selfSchema,
} from '@frequencia/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { notFound, unauthorized } from '../../errors';
import type { IssuedSession } from './service';

export const REFRESH_COOKIE = 'fq_refresh';
/** The cookie is only ever sent to the auth endpoints. */
const COOKIE_PATH = '/api/auth';

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { auth, config } = app.ctx;
  const errors = { 400: apiErrorSchema, 401: apiErrorSchema, 409: apiErrorSchema };
  // Credential endpoints get a much tighter rate limit than the rest of the API.
  const strict = { rateLimit: { max: config.RATE_LIMIT_AUTH_MAX, timeWindow: '1 minute' } };

  const cookieOptions = {
    path: COOKIE_PATH,
    httpOnly: true,
    sameSite: 'strict',
    secure: config.COOKIE_SECURE,
  } as const;

  const respond = (reply: FastifyReply, session: IssuedSession) => {
    reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      ...cookieOptions,
      expires: session.refreshExpiresAt,
    });
    return session.response;
  };
  const meta = (request: FastifyRequest) => ({ userAgent: request.headers['user-agent'] });

  app.post(
    '/auth/register',
    {
      config: strict,
      schema: {
        tags: ['auth'],
        summary: 'Create an account and start a session',
        body: registerRequestSchema,
        response: { 200: authResponseSchema, ...errors },
      },
    },
    async (request, reply) => respond(reply, await auth.register(request.body, meta(request))),
  );

  app.post(
    '/auth/login',
    {
      config: strict,
      schema: {
        tags: ['auth'],
        summary: 'Start a session with username and password',
        body: loginRequestSchema,
        response: { 200: authResponseSchema, ...errors },
      },
    },
    async (request, reply) => respond(reply, await auth.login(request.body, meta(request))),
  );

  app.post(
    '/auth/refresh',
    {
      config: strict,
      schema: {
        tags: ['auth'],
        summary: 'Exchange the refresh cookie for a new access token (rotates the cookie)',
        response: { 200: authResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const token = request.cookies[REFRESH_COOKIE];
      if (!token) throw unauthorized();
      try {
        return respond(reply, await auth.refresh(token, meta(request)));
      } catch (error) {
        reply.clearCookie(REFRESH_COOKIE, cookieOptions);
        throw error;
      }
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'End the current session and revoke its tokens',
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await auth.logout(request.cookies[REFRESH_COOKIE]);
      reply.clearCookie(REFRESH_COOKIE, cookieOptions);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/auth/logout-all',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['auth'],
        summary: 'Revoke every session of the current user, on every device',
        security: [{ bearerAuth: [] }],
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await auth.logoutAll(request.auth.userId);
      reply.clearCookie(REFRESH_COOKIE, cookieOptions);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/users/@me',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['auth'],
        summary: 'The authenticated user',
        security: [{ bearerAuth: [] }],
        response: { 200: selfSchema, 401: apiErrorSchema },
      },
    },
    async (request) => {
      const user = await auth.getUser(request.auth.userId);
      if (!user) throw notFound('user');
      return user;
    },
  );

  app.post(
    '/users/@me/password',
    {
      onRequest: [app.authenticate],
      config: { rateLimit: { max: config.RATE_LIMIT_AUTH_MAX, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        summary: 'Change your password; every session is signed out',
        security: [{ bearerAuth: [] }],
        body: changePasswordRequestSchema,
        response: { 204: z.null(), 401: apiErrorSchema },
      },
    },
    async (request, reply) => {
      await auth.changePassword(
        request.auth.userId,
        request.body.currentPassword,
        request.body.newPassword,
      );
      reply.clearCookie(REFRESH_COOKIE, cookieOptions);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/auth/password-reset',
    {
      config: strict,
      schema: {
        tags: ['auth'],
        summary: 'Set a new password with a reset link',
        description:
          'The link is made by the owner of a server the user belongs to, works once and ' +
          'for one hour. Every session of the user is signed out.',
        body: resetPasswordRequestSchema,
        response: { 204: z.null(), 404: apiErrorSchema },
      },
    },
    async (request, reply) => {
      await auth.resetPassword(request.body.token, request.body.newPassword);
      return reply.code(204).send(null);
    },
  );
};
