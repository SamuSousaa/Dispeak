import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';
import type { RoomManager } from './rooms/room-manager';

/**
 * Prometheus metrics of the media service itself (`/media/metrics`). The API republishes the
 * same numbers on its own `/metrics`; this endpoint exists for scraping the SFU directly.
 */
export function createMetrics(rooms: RoomManager, getConnectionCount: () => number) {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'media' });
  collectDefaultMetrics({ register: registry });

  const gauge = (name: string, help: string, labelNames: string[] = []) =>
    new Gauge({ name, help, labelNames, registers: [registry] });

  const channels = gauge(
    'frequencia_voice_channels_active',
    'Voice channels with at least one participant.',
  );
  const participants = gauge(
    'frequencia_voice_participants',
    'Participants connected to voice channels.',
  );
  const transports = gauge('frequencia_media_transports', 'Open WebRTC transports.');
  const producers = gauge('frequencia_media_producers', 'Media producers by what they carry.', [
    'source',
  ]);
  const consumers = gauge('frequencia_media_consumers', 'Media consumers by what they carry.', [
    'source',
  ]);
  const connections = gauge(
    'frequencia_media_signaling_connections',
    'Browser signaling connections.',
  );
  const workerRouters = gauge(
    'frequencia_media_worker_routers',
    'Routers (voice channels) hosted by each mediasoup worker.',
    ['worker'],
  );
  const workerCpu = new Counter({
    name: 'frequencia_media_worker_cpu_seconds_total',
    help: 'CPU time consumed by each mediasoup worker process.',
    labelNames: ['worker', 'mode'],
    registers: [registry],
  });
  const lastCpu = new Map<string, number>();

  return {
    contentType: registry.contentType,
    async render(): Promise<string> {
      const stats = rooms.stats();
      const peers = stats.rooms.flatMap((room) => room.peers);
      channels.set(stats.totals.rooms);
      participants.set(stats.totals.peers);
      transports.set(stats.totals.transports);
      connections.set(getConnectionCount());

      for (const source of ['mic', 'camera', 'screen', 'screen-audio'] as const) {
        producers.set(
          { source },
          peers.reduce(
            (sum, peer) => sum + peer.producers.filter((p) => p.source === source).length,
            0,
          ),
        );
        consumers.set(
          { source },
          peers.reduce(
            (sum, peer) => sum + peer.consumers.filter((c) => c.source === source).length,
            0,
          ),
        );
      }

      for (const worker of await rooms.workerUsage()) {
        const label = String(worker.index);
        workerRouters.set({ worker: label }, worker.routers);
        for (const [mode, seconds] of [
          ['user', worker.cpuUserSeconds],
          ['system', worker.cpuSystemSeconds],
        ] as const) {
          const key = `${label}:${mode}`;
          const delta = seconds - (lastCpu.get(key) ?? 0);
          lastCpu.set(key, seconds);
          if (delta > 0) workerCpu.inc({ worker: label, mode }, delta);
        }
      }
      return registry.metrics();
    },
  };
}
