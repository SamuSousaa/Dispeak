import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { MEDIA_PREFIX } from '@frequencia/shared';
import type { Config } from './config';
import type { RoomManager } from './rooms/room-manager';
import { INTERNAL_PATH, type InternalServer } from './signaling/internal-server';
import { VOICE_PATH, type VoiceServer } from './signaling/voice-server';
import type { WorkerPool } from './worker-pool';

export interface HttpDeps {
  config: Config;
  pool: WorkerPool;
  rooms: RoomManager;
  voice: VoiceServer;
  internal: InternalServer;
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** Operational endpoints are open in development and need the shared secret otherwise. */
function isAuthorized(request: http.IncomingMessage, config: Config): boolean {
  if (config.env !== 'production') return true;
  const header = request.headers.authorization ?? '';
  const provided = Buffer.from(header.replace(/^Bearer /, ''));
  const expected = Buffer.from(config.sharedSecret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createHttpServer({ config, pool, rooms, voice, internal }: HttpDeps): http.Server {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = `${request.method} ${url.pathname}`;

    if (route === `GET ${MEDIA_PREFIX}/health`) {
      json(response, 200, {
        status: 'ok',
        service: 'media',
        uptime: process.uptime(),
        workers: pool.size,
      });
      return;
    }

    // Live view of rooms, peers, producers and consumers.
    if (route === `GET ${MEDIA_PREFIX}/stats`) {
      if (!isAuthorized(request, config)) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }
      json(response, 200, {
        ...rooms.stats(),
        connections: voice.connections,
        apiLinks: internal.linkCount,
      });
      return;
    }

    json(response, 404, { error: 'not_found' });
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === VOICE_PATH) {
      void voice.handleUpgrade(request, socket, head);
      return;
    }
    if (url.pathname === INTERNAL_PATH) {
      internal.handleUpgrade(request, socket, head);
      return;
    }
    socket.destroy();
  });

  return server;
}
