import type { Gif } from '@frequencia/shared';
import { z } from 'zod';

const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_ENTRIES = 200;
const PAGE_SIZE = 24;

const rendition = z.object({
  url: z.string(),
  width: z.coerce.number().int(),
  height: z.coerce.number().int(),
});

/** The part of GIPHY's answer this service uses. */
const giphyResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      title: z.string().default(''),
      images: z.object({
        fixed_width: rendition,
        original: rendition,
        // Capped at 2 MB by GIPHY; absent for some very small GIFs.
        downsized: rendition.optional(),
      }),
    }),
  ),
});

/** Tracking parameters are of no use in a chat message. */
const withoutQuery = (url: string) => url.split('?')[0] ?? url;

export interface GifSearchOptions {
  /** Without a key the feature is off. */
  apiKey?: string;
  baseUrl: string;
}

/**
 * GIF search through GIPHY. It is the one feature that depends on someone else's service, so
 * it is optional and only ever called from here: browsers never talk to GIPHY's API, and the
 * key stays on the server.
 */
export class GifSearch {
  private readonly cache = new Map<string, { expires: number; gifs: Gif[] }>();

  constructor(private readonly options: GifSearchOptions) {}

  get enabled(): boolean {
    return Boolean(this.options.apiKey);
  }

  /** GIFs for a query, or the trending ones for an empty query. */
  async search(query: string): Promise<Gif[]> {
    const { apiKey, baseUrl } = this.options;
    if (!apiKey) return [];
    const key = query.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.gifs;

    const url = new URL(query ? '/v1/gifs/search' : '/v1/gifs/trending', baseUrl);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('rating', 'pg-13');
    if (query) {
      url.searchParams.set('q', query);
      url.searchParams.set('lang', 'pt');
    }

    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`gif search answered ${response.status}`);
    const { data } = giphyResponse.parse(await response.json());
    const gifs = data.map((entry) => ({
      id: entry.id,
      title: entry.title,
      url: withoutQuery((entry.images.downsized ?? entry.images.original).url),
      previewUrl: entry.images.fixed_width.url,
      width: entry.images.fixed_width.width,
      height: entry.images.fixed_width.height,
    }));

    if (this.cache.size >= CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { expires: Date.now() + CACHE_TTL_MS, gifs });
    return gifs;
  }
}
