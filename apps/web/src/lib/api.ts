import { API_PREFIX, MEDIA_PREFIX } from '@frequencia/shared';

export interface ServiceHealth {
  status: 'ok';
  service: string;
  uptime: number;
  workers?: number;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, credentials: 'include' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export const fetchApiHealth = (signal?: AbortSignal) =>
  getJson<ServiceHealth>(`${API_PREFIX}/health`, signal);

export const fetchMediaHealth = (signal?: AbortSignal) =>
  getJson<ServiceHealth>(`${MEDIA_PREFIX}/health`, signal);

/** Builds an absolute ws(s):// URL for a same-origin path. */
export function wsUrl(path: string): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}${path}`;
}
