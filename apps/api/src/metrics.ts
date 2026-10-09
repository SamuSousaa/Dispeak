import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics at `/metrics` (outside `/api`, so the reverse proxy never exposes it).
 * Gateway numbers describe this API instance; media numbers are read from the media service
 * over the internal link at scrape time, so one scrape shows the whole system.
 */
export function registerMetrics(app: FastifyInstance): void {
  const { hub, media, config } = app.ctx;
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'api' });
  collectDefaultMetrics({ register: registry });

  // --- HTTP ---------------------------------------------------------------------------------
  const requests = new Histogram({
    name: 'frequencia_http_request_duration_seconds',
    help: 'Duration of HTTP requests handled by the API.',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  app.addHook('onResponse', async (request, reply) => {
    // The matched route pattern keeps cardinality bounded (no ids in labels).
    const route = request.routeOptions.url ?? 'unmatched';
    if (route === '/metrics') return;
    requests.observe(
      { method: request.method, route, status: reply.statusCode },
      reply.elapsedTime / 1000,
    );
  });

  // --- gateway ------------------------------------------------------------------------------
  const gauge = (name: string, help: string, collect: () => number) =>
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        this.set(collect());
      },
    });
  gauge(
    'frequencia_gateway_connections',
    'Open gateway WebSocket connections on this instance.',
    () => hub.connectionCount,
  );
  gauge(
    'frequencia_gateway_sessions',
    'Gateway sessions on this instance, including the ones waiting to be resumed.',
    () => hub.sessionCount,
  );
  gauge(
    'frequencia_users_connected',
    'Distinct users with at least one gateway session on this instance.',
    () => hub.userCount,
  );

  // --- media service ------------------------------------------------------------------------
  const mediaUp = new Gauge({
    name: 'frequencia_media_link_up',
    help: 'Whether the internal link to the media service is connected (1) or not (0).',
    registers: [registry],
  });
  const mediaGauges = {
    rooms: ['frequencia_voice_channels_active', 'Voice channels with at least one participant.'],
    peers: ['frequencia_voice_participants', 'Participants connected to voice channels.'],
    transports: ['frequencia_media_transports', 'Open WebRTC transports on the media service.'],
    producers: ['frequencia_media_producers', 'Media producers (microphones and screen shares).'],
    consumers: ['frequencia_media_consumers', 'Media consumers (streams being forwarded).'],
    connections: [
      'frequencia_media_signaling_connections',
      'Browser signaling connections to the media service.',
    ],
  } as const;
  const media_ = Object.fromEntries(
    Object.entries(mediaGauges).map(([key, [name, help]]) => [
      key,
      new Gauge({ name, help, registers: [registry] }),
    ]),
  ) as Record<keyof typeof mediaGauges, Gauge>;
  const workerCpu = new Counter({
    name: 'frequencia_media_worker_cpu_seconds_total',
    help: 'CPU time consumed by each mediasoup worker process.',
    labelNames: ['worker', 'mode'],
    registers: [registry],
  });
  const workerRouters = new Gauge({
    name: 'frequencia_media_worker_routers',
    help: 'Routers (voice channels) hosted by each mediasoup worker.',
    labelNames: ['worker'],
    registers: [registry],
  });
  /** Last CPU reading per worker; counters only ever move forward. */
  const lastCpu = new Map<string, number>();

  async function refreshMedia(): Promise<void> {
    mediaUp.set(media.connected ? 1 : 0);
    if (!media.connected) return;
    try {
      const stats = await media.request('stats', {});
      for (const key of Object.keys(media_) as Array<keyof typeof media_>) {
        media_[key].set(stats[key]);
      }
      for (const worker of stats.workers) {
        const label = String(worker.index);
        workerRouters.set({ worker: label }, worker.routers);
        for (const [mode, seconds] of [
          ['user', worker.cpuUserSeconds],
          ['system', worker.cpuSystemSeconds],
        ] as const) {
          const key = `${worker.pid}:${mode}`;
          const delta = seconds - (lastCpu.get(key) ?? 0);
          lastCpu.set(key, seconds);
          if (delta > 0) workerCpu.inc({ worker: label, mode }, delta);
        }
      }
    } catch (error) {
      app.log.debug({ err: error }, 'could not read media stats for metrics');
    }
  }

  const token = config.METRICS_TOKEN;
  app.get('/metrics', { schema: { hide: true } }, async (request, reply) => {
    if (token) {
      const provided = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, ''));
      const expected = Buffer.from(token);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return reply.code(401).send({ error: 'unauthorized', message: 'invalid metrics token' });
      }
    }
    await refreshMedia();
    return reply.header('content-type', registry.contentType).send(await registry.metrics());
  });
}
