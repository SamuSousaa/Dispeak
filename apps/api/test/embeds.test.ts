import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Features, Gif, LinkPreview } from '@frequencia/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPublicAddress, LinkPreviews, parsePreview } from '../src/modules/embeds/link-preview';
import { createTestApp, type Account, type TestApp } from './helpers/app';

describe('isPublicAddress', () => {
  it('accepts internet addresses', () => {
    for (const address of ['8.8.8.8', '142.250.79.14', '2606:4700:4700::1111']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it('refuses everything inside a network', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.18.167',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      'not an address',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe('parsePreview', () => {
  it('prefers Open Graph, falls back to plain HTML and resolves the picture', () => {
    const html = `<html><head>
      <title>Título &amp; simples</title>
      <meta name="description" content="descrição simples">
      <meta property="og:title" content="Gato tocando piano">
      <meta content='Um gato. Um piano.' property='og:description'>
      <meta property="og:image" content="/img/gato.jpg">
      <meta property="og:site_name" content="Vídeos">
    </head></html>`;
    expect(parsePreview(html, 'https://exemplo.com/v/1')).toEqual({
      title: 'Gato tocando piano',
      description: 'Um gato. Um piano.',
      siteName: 'Vídeos',
      image: 'https://exemplo.com/img/gato.jpg',
    });
    expect(parsePreview('<title>Só  o\n título &#233;</title>', 'https://exemplo.com')).toEqual({
      title: 'Só o título é',
      description: null,
      siteName: null,
      image: null,
    });
  });

  it('drops pictures that are not web addresses', () => {
    const html = '<meta property="og:image" content="javascript:alert(1)"><title>x</title>';
    expect(parsePreview(html, 'https://exemplo.com').image).toBeNull();
  });
});

describe('link previews and GIF search', () => {
  let t: TestApp;
  let user: Account;
  let site: http.Server;
  let origin: string;
  const giphyRequests: URL[] = [];

  beforeAll(async () => {
    site = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/page') {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(
          '<title>Página de teste</title><meta property="og:image" content="/foto.png">',
        );
      } else if (url.pathname === '/moved') {
        response.writeHead(302, { location: '/page' }).end();
      } else if (url.pathname === '/loop') {
        response.writeHead(302, { location: '/loop' }).end();
      } else if (url.pathname === '/foto.png') {
        response.setHeader('content-type', 'image/png');
        response.end('not really a png');
      } else if (url.pathname === '/file.zip') {
        response.setHeader('content-type', 'application/zip');
        response.end('PK');
      } else if (url.pathname.startsWith('/v1/gifs/')) {
        giphyRequests.push(url);
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            data: [
              {
                id: 'abc',
                title: 'Gato dançando',
                images: {
                  fixed_width: {
                    url: 'https://media.test/abc/200w.gif?cid=1',
                    width: '200',
                    height: '150',
                  },
                  original: {
                    url: 'https://media.test/abc/giphy.gif?cid=1',
                    width: '480',
                    height: '360',
                  },
                  downsized: {
                    url: 'https://media.test/abc/small.gif?cid=1',
                    width: '320',
                    height: '240',
                  },
                },
              },
            ],
          }),
        );
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

    t = await createTestApp({
      LINK_PREVIEW_ALLOW_PRIVATE: 'true',
      GIPHY_API_KEY: 'test-key',
      GIPHY_API_URL: origin,
    });
    user = await t.account('Ana');
  });

  afterAll(async () => {
    await t.close();
    await new Promise((resolve) => site.close(resolve));
  });

  const unfurl = (url: string, token: string | undefined = user.token) =>
    t.request('GET', `/unfurl?url=${encodeURIComponent(url)}`, { token });

  it('describes a page, following redirects', async () => {
    const expected = {
      kind: 'page',
      title: 'Página de teste',
      description: null,
      siteName: null,
      image: `${origin}/foto.png`,
    };
    const direct = await unfurl(`${origin}/page`);
    expect(direct.statusCode).toBe(200);
    expect(direct.json<LinkPreview>()).toEqual({ url: `${origin}/page`, ...expected });
    expect((await unfurl(`${origin}/moved`)).json<LinkPreview>()).toEqual({
      url: `${origin}/moved`,
      ...expected,
    });
  });

  it('recognises a link that is the picture itself', async () => {
    expect((await unfurl(`${origin}/foto.png`)).json<LinkPreview>()).toMatchObject({
      kind: 'image',
      image: `${origin}/foto.png`,
    });
  });

  it('answers null for what has nothing to show', async () => {
    for (const path of ['/file.zip', '/missing', '/loop']) {
      const response = await unfurl(`${origin}${path}`);
      expect(response.statusCode, path).toBe(200);
      expect(response.json(), path).toBeNull();
    }
  });

  it('needs a session and a web address', async () => {
    expect((await unfurl(`${origin}/page`, '')).statusCode).toBe(401);
    expect((await unfurl('file:///etc/passwd')).statusCode).toBe(400);
    expect((await unfurl('nada')).statusCode).toBe(400);
  });

  it('never fetches internal addresses unless told to', async () => {
    // The default configuration, pointed at the very same local server.
    const strict = new LinkPreviews();
    expect(await strict.get(`${origin}/page`)).toBeNull();
    expect(await strict.get('http://localhost/')).toBeNull();
    expect(await strict.get('http://169.254.169.254/latest/meta-data/')).toBeNull();
    expect(await strict.get('http://[::1]/')).toBeNull();
    expect(await strict.get('http://user:pass@8.8.8.8/')).toBeNull();
  });

  it('searches GIFs through the server, keeping the key out of the answer', async () => {
    expect((await t.request('GET', '/features', { token: user.token })).json<Features>()).toEqual({
      gifs: true,
      linkPreviews: true,
    });

    const response = await t.request('GET', '/gifs?q=gato', { token: user.token });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ gifs: Gif[] }>().gifs).toEqual([
      {
        id: 'abc',
        title: 'Gato dançando',
        url: 'https://media.test/abc/small.gif',
        previewUrl: 'https://media.test/abc/200w.gif?cid=1',
        width: 200,
        height: 150,
      },
    ]);
    expect(response.body).not.toContain('test-key');
    const search = giphyRequests.at(-1);
    expect(search?.pathname).toBe('/v1/gifs/search');
    expect(search?.searchParams.get('q')).toBe('gato');
    expect(search?.searchParams.get('api_key')).toBe('test-key');

    // No query: trending. The same query again comes from the cache.
    await t.request('GET', '/gifs', { token: user.token });
    expect(giphyRequests.at(-1)?.pathname).toBe('/v1/gifs/trending');
    const before = giphyRequests.length;
    await t.request('GET', '/gifs?q=GATO', { token: user.token });
    expect(giphyRequests.length).toBe(before);
  });

  it('hides the GIF search when there is no key', async () => {
    const plain = await createTestApp();
    try {
      const someone = await plain.account('Bia');
      expect(
        (await plain.request('GET', '/features', { token: someone.token })).json<Features>().gifs,
      ).toBe(false);
      expect((await plain.request('GET', '/gifs?q=x', { token: someone.token })).statusCode).toBe(
        404,
      );
    } finally {
      await plain.close();
    }
  });
});
