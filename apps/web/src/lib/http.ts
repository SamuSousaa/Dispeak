import { API_PREFIX } from '@frequencia/shared';
import type { z } from 'zod';
import { ApiError, getAccessToken, refreshSession, toApiError } from '../features/auth/auth-store';

export { ApiError };

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** JSON by default; a `Blob` is sent as it is, with its own content type. */
function send(method: Method, path: string, body: unknown, token: string | null) {
  const raw = body instanceof Blob;
  return fetch(`${API_PREFIX}${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': raw ? body.type : 'application/json' }),
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
}

/** One authenticated request; a 401 triggers one token refresh and a retry. */
async function request(method: Method, path: string, body?: unknown): Promise<Response> {
  let response = await send(method, path, body, await getAccessToken());
  if (response.status === 401) {
    const token = await refreshSession();
    if (token) response = await send(method, path, body, token);
  }
  if (!response.ok) throw await toApiError(response);
  return response;
}

/**
 * Authenticated request to the API. Responses are validated against `schema` so the rest of
 * the app can trust their shape.
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
  const response = await request(method, path, options.body);
  if (!options.schema || response.status === 204) return undefined;
  return options.schema.parse(await response.json());
}

/** Authenticated download of a binary resource (an `<img>` cannot send the access token). */
export async function apiBlob(path: string): Promise<Blob> {
  return (await request('GET', path)).blob();
}

/** User-facing text for an error thrown by `api`. */
export function describeError(
  error: unknown,
  fallback = 'Algo deu errado. Tente de novo.',
): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 413) return 'O arquivo é grande demais.';
  switch (error.code) {
    case 'invalid_credentials':
      return 'Usuário ou senha incorretos.';
    case 'username_taken':
      return 'Este nome de usuário já está em uso.';
    case 'access_code_invalid':
      return 'Código de acesso incorreto. Peça o código a quem cuida deste servidor.';
    case 'forbidden':
      return 'Você não tem permissão para fazer isso.';
    case 'banned':
      return 'Você foi banido deste servidor.';
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
    case 'dm_closed':
      return 'Esta pessoa só recebe mensagens de amigos ou de quem divide um servidor com ela.';
    case 'blocked':
      return 'Não é possível falar com esta pessoa.';
    default:
      return fallback;
  }
}
