import type { FastifyRequest } from 'fastify';

/**
 * Subject of the bearer token, read without verifying it. Rate limiting runs before
 * authentication, and a forged subject only earns a 401 from the next hook.
 */
function tokenSubject(request: FastifyRequest): string | null {
  const payload = request.headers.authorization?.split('.')[1];
  if (!payload) return null;
  try {
    const { sub } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: unknown };
    return typeof sub === 'string' ? `user:${sub}` : null;
  } catch {
    return null;
  }
}

/**
 * Route config for a limit per user and minute. Counting per user, not per address, keeps
 * friends behind the same router from sharing a budget.
 */
export const perUser = (max: number) => ({
  rateLimit: {
    max,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => tokenSubject(request) ?? request.ip,
  },
});
