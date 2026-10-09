import { API_PREFIX } from '@frequencia/shared';
import type { z } from 'zod';
import { ApiError, getAccessToken, refreshSession, toApiError } from '../features/auth/auth-store';

export { ApiError };

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function send(method: Method, path: string, body: unknown, token: string | null) {
  return fetch(`${API_PREFIX}${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Authenticated request to the API. A 401 triggers one token refresh and a retry; responses
 * are validated against `schema` so the rest of the app can trust their shape.
 */
export async function api<S extends z.ZodType>(
  method: Method,
  path: string,
  options: { body?: unknown; schema: S },
): Promise<z.infer<S>>;
export async function api(
  method: Method,
  path: string,
  options?: { body?: unknown },
): Promise<void>;
export async function api(
  method: Method,
  path: string,
  options: { body?: unknown; schema?: z.ZodType } = {},
): Promise<unknown> {
  let response = await send(method, path, options.body, await getAccessToken());
  if (response.status === 401) {
    const token = await refreshSession();
    if (token) response = await send(method, path, options.body, token);
  }
  if (!response.ok) throw await toApiError(response);
  if (!options.schema || response.status === 204) return undefined;
  return options.schema.parse(await response.json());
}

/** User-facing text for an error thrown by `api`. */
export function describeError(
  error: unknown,
  fallback = 'Algo deu errado. Tente de novo.',
): string {
  if (!(error instanceof ApiError)) return fallback;
  switch (error.code) {
    case 'invalid_credentials':
      return 'Usuário ou senha incorretos.';
    case 'username_taken':
      return 'Este nome de usuário já está em uso.';
    case 'forbidden':
      return 'Você não tem permissão para fazer isso.';
    case 'invite_invalid':
      return 'Este convite é inválido ou expirou.';
    case 'rate_limited':
      return 'Muitas tentativas. Aguarde um instante.';
    case 'not_found':
      return 'Não encontrado.';
    case 'conflict':
      return 'O dono não pode sair do servidor. Exclua-o ou transfira a posse.';
    case 'media_unavailable':
      return 'O servidor de mídia está indisponível.';
    default:
      return fallback;
  }
}
