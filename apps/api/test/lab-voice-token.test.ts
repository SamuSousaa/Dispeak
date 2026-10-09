import { VOICE_TOKEN_AUDIENCE, VOICE_TOKEN_ISSUER } from '@frequencia/shared';
import type { FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

const secret = 'test-secret-test-secret-test-secret-1234';

describe('POST /api/lab/voice-token', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test', MEDIA_SHARED_SECRET: secret }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('issues a short-lived token scoped to one channel', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/lab/voice-token',
      payload: {
        nickname: 'Alice',
        channel: 'geral',
        clientId: '3f0c1e0e-6f1b-4c58-9f0a-0d6f6a1b2c3d',
      },
    });
    expect(response.statusCode).toBe(200);

    const { token } = response.json<{ token: string }>();
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      audience: VOICE_TOKEN_AUDIENCE,
      issuer: VOICE_TOKEN_ISSUER,
    });
    expect(payload).toMatchObject({
      sub: 'lab:3f0c1e0e-6f1b-4c58-9f0a-0d6f6a1b2c3d',
      name: 'Alice',
      room: 'lab:geral',
      speak: true,
      stream: true,
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(60);
  });

  it('rejects invalid payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/lab/voice-token',
      payload: { nickname: 'A', channel: 'has spaces', clientId: 'nope' },
    });
    expect(response.statusCode).toBe(400);
  });
});
