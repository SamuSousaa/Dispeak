import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app';

describe('service endpoints', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('reports the service as healthy', async () => {
    const response = await t.request('GET', '/health');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: 'api', media: false });
  });

  it('serves the OpenAPI document and its UI at /docs', async () => {
    const ui = await t.app.inject({ method: 'GET', url: '/docs/' });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');

    const spec = await t.app.inject({ method: 'GET', url: '/docs/json' });
    const document = spec.json<{
      openapi: string;
      paths: Record<string, Record<string, { security?: unknown[] }>>;
      components: { securitySchemes: Record<string, unknown> };
    }>();
    expect(document.openapi).toMatch(/^3\./);
    expect(document.components.securitySchemes).toHaveProperty('bearerAuth');
    for (const path of [
      '/api/auth/register',
      '/api/auth/refresh',
      '/api/guilds',
      '/api/guilds/{guildId}/roles',
      '/api/channels/{channelId}/overwrites/{targetId}',
      '/api/invites/{code}/accept',
      '/api/channels/{channelId}/voice-token',
    ]) {
      expect(document.paths).toHaveProperty([path]);
    }
    expect(document.paths['/api/guilds']?.post?.security).toEqual([{ bearerAuth: [] }]);
    // Internal endpoints stay out of the public document.
    expect(document.paths).not.toHaveProperty(['/api/gateway']);
    expect(document.paths).not.toHaveProperty(['/api/health']);
  });

  it('answers unknown routes with the standard error body', async () => {
    const response = await t.request('GET', '/nope');
    expect(response.statusCode).toBe(404);
  });
});
