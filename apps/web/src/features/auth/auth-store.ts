import {
  API_PREFIX,
  apiErrorSchema,
  authResponseSchema,
  type AuthResponse,
  type LoginRequest,
  type RegisterRequest,
  type Self,
} from '@frequencia/shared';
import { create } from 'zustand';

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

interface AuthState {
  status: AuthStatus;
  user: Self | null;
  /** Kept in memory only; the refresh token lives in an httpOnly cookie. */
  accessToken: string | null;
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number;
}

export const useAuthStore = create<AuthState>(() => ({
  status: 'loading',
  user: null,
  accessToken: null,
  expiresAt: 0,
}));

/** An error answered by the API, with its stable machine-readable code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function toApiError(response: Response): Promise<ApiError> {
  const body = apiErrorSchema.safeParse(await response.json().catch(() => null));
  return new ApiError(
    response.status,
    body.success ? body.data.error : 'unknown',
    body.success ? body.data.message : response.statusText,
  );
}

function accept(session: AuthResponse): string {
  useAuthStore.setState({
    status: 'authenticated',
    user: session.user,
    accessToken: session.accessToken,
    // Refresh a little early so requests never go out with a token about to expire.
    expiresAt: Date.now() + (session.expiresIn - 30) * 1000,
  });
  return session.accessToken;
}

async function post(path: string, body?: unknown): Promise<AuthResponse> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await toApiError(response);
  return authResponseSchema.parse(await response.json());
}

let refreshing: Promise<string | null> | null = null;

/** Exchanges the refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshSession(): Promise<string | null> {
  refreshing ??= post('/auth/refresh')
    .then(accept)
    .catch((error: unknown) => {
      // Only a definite "no" logs the user out; a network blip keeps the session.
      if (error instanceof ApiError && error.status === 401) {
        useAuthStore.setState({
          status: 'anonymous',
          user: null,
          accessToken: null,
          expiresAt: 0,
        });
      } else if (useAuthStore.getState().status === 'loading') {
        useAuthStore.setState({ status: 'anonymous' });
      }
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** A valid access token, refreshed first when it is missing or about to expire. */
export async function getAccessToken(): Promise<string | null> {
  const { accessToken, expiresAt } = useAuthStore.getState();
  if (accessToken && Date.now() < expiresAt) return accessToken;
  return refreshSession();
}

/** Restores the session on page load. */
export async function bootstrapAuth(): Promise<void> {
  await refreshSession();
}

export async function login(input: LoginRequest): Promise<void> {
  accept(await post('/auth/login', input));
}

export async function register(input: RegisterRequest): Promise<void> {
  accept(await post('/auth/register', input));
}

export async function logout(): Promise<void> {
  await fetch(`${API_PREFIX}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(
    () => undefined,
  );
  useAuthStore.setState({ status: 'anonymous', user: null, accessToken: null, expiresAt: 0 });
}
