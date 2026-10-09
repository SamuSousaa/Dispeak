import { ApiErrorCode, type ApiErrorBody } from '@frequencia/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

/** An expected failure with a stable code; anything else is reported as a 500. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string) =>
  new AppError(400, ApiErrorCode.InvalidRequest, message);
export const unauthorized = (message = 'authentication required') =>
  new AppError(401, ApiErrorCode.Unauthorized, message);
export const forbidden = (message = 'missing permission') =>
  new AppError(403, ApiErrorCode.Forbidden, message);
export const notFound = (what: string) =>
  new AppError(404, ApiErrorCode.NotFound, `${what} not found`);
export const conflict = (message: string) => new AppError(409, ApiErrorCode.Conflict, message);

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const send = (status: number, body: ApiErrorBody) => void reply.code(status).send(body);

  if (error instanceof AppError) {
    send(error.statusCode, { error: error.code, message: error.message });
    return;
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    const [issue] = error.validation;
    const where = issue?.instancePath ? `${issue.instancePath.slice(1)}: ` : '';
    send(400, {
      error: ApiErrorCode.InvalidRequest,
      message: `${where}${issue?.message ?? 'invalid request'}`,
    });
    return;
  }
  if (error.statusCode === 429) {
    send(429, { error: ApiErrorCode.RateLimited, message: 'too many requests, slow down' });
    return;
  }
  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    send(error.statusCode, { error: ApiErrorCode.InvalidRequest, message: error.message });
    return;
  }

  request.log.error({ err: error }, 'unhandled error');
  send(500, { error: ApiErrorCode.Internal, message: 'internal error' });
}
