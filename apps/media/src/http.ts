import http from 'node:http';
import { MEDIA_PREFIX } from '@frequencia/shared';
import type { WorkerPool } from './worker-pool';

export function createHttpServer(pool: WorkerPool): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === `${MEDIA_PREFIX}/health`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'ok',
          service: 'media',
          uptime: process.uptime(),
          workers: pool.size,
        }),
      );
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
}
