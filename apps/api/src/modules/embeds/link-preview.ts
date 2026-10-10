import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LinkPreview } from '@frequencia/shared';

const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
/**
 * The tags that matter sit in the head, and reading stops where the head ends. Some sites put
 * megabytes of scripts before them (YouTube: ~770 KB), hence the generous ceiling.
 */
const MAX_HTML_BYTES = 1536 * 1024;
const HEAD_END = Buffer.from('</head>');
const FOUND_TTL_MS = 60 * 60 * 1000;
const MISSING_TTL_MS = 10 * 60 * 1000;
const CACHE_ENTRIES = 500;

// Everything a link posted in a chat has no business reaching from inside our network.
const internal = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  internal.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 127], // unspecified and loopback
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  internal.addSubnet(prefix, bits, 'ipv6');
}

/** Whether an IP address belongs to the public internet. */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return !internal.check(mapped[1], 'ipv4');
  const family = net.isIP(address);
  if (family === 0) return false;
  return !internal.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const clean = (value: string | undefined, max: number): string | null => {
  const text = decodeEntities(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
};

/** Title, description and picture a page declares about itself (Open Graph, Twitter, plain HTML). */
export function parsePreview(
  html: string,
  pageUrl: string,
): Pick<LinkPreview, 'title' | 'description' | 'siteName' | 'image'> {
  const meta = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([a-z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      attributes.set((match[1] ?? '').toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
    }
    const key = (attributes.get('property') ?? attributes.get('name'))?.toLowerCase();
    const content = attributes.get('content');
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];

  let image: string | null = null;
  const rawImage = clean(meta.get('og:image') ?? meta.get('twitter:image'), 2048);
  if (rawImage) {
    try {
      const resolved = new URL(rawImage, pageUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') image = resolved.href;
    } catch {
      // A malformed picture address is just a missing picture.
    }
  }

  return {
    title: clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag, 200),
    description: clean(
      meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'),
      400,
    ),
    siteName: clean(meta.get('og:site_name'), 80),
    image,
  };
}

interface Fetched {
  status: number;
  contentType: string;
  location: string | null;
  body: string;
}

export interface LinkPreviewOptions {
  /** Tests fetch from a local server; production never should. */
  allowPrivate?: boolean;
}

/**
 * Fetches what a link looks like so the chat can show it. The request leaves from the server,
 * which makes this a way to poke at whatever the server can reach: only http(s) on the default
 * ports, only public addresses (checked on the address actually connected to, on every
 * redirect), a short timeout and a small read.
 */
export class LinkPreviews {
  private readonly cache = new Map<string, { expires: number; value: LinkPreview | null }>();
  private readonly pending = new Map<string, Promise<LinkPreview | null>>();
  private readonly allowPrivate: boolean;

  constructor(options: LinkPreviewOptions = {}) {
    this.allowPrivate = options.allowPrivate ?? false;
  }

  async get(url: string): Promise<LinkPreview | null> {
    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) return cached.value;

    let pending = this.pending.get(url);
    if (!pending) {
      pending = this.load(url)
        .catch(() => null)
        .then((value) => {
          this.remember(url, value);
          return value;
        })
        .finally(() => this.pending.delete(url));
      this.pending.set(url, pending);
    }
    return pending;
  }

  private remember(url: string, value: LinkPreview | null): void {
    // Insertion order doubles as age: drop the oldest when full.
    if (this.cache.size >= CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(url, {
      expires: Date.now() + (value ? FOUND_TTL_MS : MISSING_TTL_MS),
      value,
    });
  }

  private async load(url: string): Promise<LinkPreview | null> {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.fetch(current);
      if (response.status >= 300 && response.status < 400 && response.location) {
        current = new URL(response.location, current);
        continue;
      }
      if (response.status < 200 || response.status >= 300) return null;

      if (response.contentType.startsWith('image/')) {
        return {
          url,
          kind: 'image',
          title: null,
          description: null,
          siteName: null,
          image: current.href,
        };
      }
      if (!response.contentType.startsWith('text/html')) return null;
      const parsed = parsePreview(response.body, current.href);
      if (!parsed.title && !parsed.image) return null;
      return { url, kind: 'page', ...parsed };
    }
    return null;
  }

  private fetch(url: URL): Promise<Fetched> {
    return new Promise((resolve, reject) => {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        reject(new Error('unsupported protocol'));
        return;
      }
      if (!this.allowPrivate) {
        if (url.port !== '' || url.username || url.password) {
          reject(new Error('only default ports, no credentials'));
          return;
        }
        // An address written out in the link never goes through the resolver below.
        const literal = url.hostname.replace(/^\[|\]$/g, '');
        if (net.isIP(literal) !== 0 && !isPublicAddress(literal)) {
          reject(new Error('internal address'));
          return;
        }
      }

      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.get(
        url,
        {
          timeout: TIMEOUT_MS,
          lookup: this.allowPrivate ? undefined : publicLookup,
          headers: {
            'user-agent': 'Mozilla/5.0 (compatible; DispeakerBot/1.0; link preview)',
            accept: 'text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.5',
            'accept-language': 'pt-BR,pt;q=0.9,en;q=0.7',
            'accept-encoding': 'identity',
          },
        },
        (response) => {
          const contentType = (response.headers['content-type'] ?? '').toLowerCase();
          const head = {
            status: response.statusCode ?? 0,
            contentType,
            location: response.headers.location ?? null,
          };
          if (!contentType.startsWith('text/html') || head.status !== 200) {
            response.destroy();
            resolve({ ...head, body: '' });
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          const finish = () => {
            const encoding = /charset=["']?(iso-8859-1|latin1|windows-1252)/.test(contentType)
              ? 'latin1'
              : 'utf8';
            resolve({ ...head, body: Buffer.concat(chunks).toString(encoding) });
          };
          let done = false;
          response.on('data', (chunk: Buffer) => {
            if (done) return;
            // The marker may straddle two chunks: look at the seam as well.
            const seam = Buffer.concat([
              chunks.at(-1)?.subarray(-HEAD_END.length) ?? HEAD_END.subarray(0, 0),
              chunk,
            ]);
            chunks.push(chunk);
            size += chunk.length;
            if (size >= MAX_HTML_BYTES || seam.includes(HEAD_END)) {
              done = true;
              response.destroy();
              finish();
            }
          });
          response.on('end', finish);
          response.on('error', reject);
        },
      );
      // The idle timeout above does not bound a server that trickles bytes forever.
      const deadline = setTimeout(() => request.destroy(new Error('timeout')), TIMEOUT_MS * 2);
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', reject);
      request.on('close', () => clearTimeout(deadline));
    });
  }
}

/**
 * DNS lookup that refuses names pointing inside the network. Running at connection time, it
 * checks the very address the socket will use, so a name cannot answer differently later.
 */
const publicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, options, (error, address, family) => {
    if (error) {
      callback(error, address, family);
      return;
    }
    const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
      callback(new Error(`refusing to connect to ${hostname}`), address, family);
      return;
    }
    callback(null, address, family);
  });
};
