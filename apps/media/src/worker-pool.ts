import * as mediasoup from 'mediasoup';
import type { types } from 'mediasoup';
import type { Config } from './config';
import type { Logger } from './logger';

export interface PooledWorker {
  index: number;
  worker: types.Worker;
  webRtcServer: types.WebRtcServer;
  /** Number of routers (voice channels) currently hosted by this worker. */
  routers: number;
}

/**
 * One mediasoup worker per CPU core. Each worker owns a WebRtcServer, so every transport it
 * hosts shares a fixed UDP/TCP port instead of taking a random one from a wide range.
 */
export class WorkerPool {
  private readonly workers: PooledWorker[] = [];
  private closed = false;

  private constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  static async create(config: Config, log: Logger): Promise<WorkerPool> {
    const pool = new WorkerPool(config, log);
    try {
      for (let index = 0; index < config.numWorkers; index++) {
        pool.workers.push(await pool.spawn(index));
      }
    } catch (error) {
      pool.close();
      throw error;
    }
    log.info(
      {
        workers: pool.workers.length,
        announcedAddresses: config.rtc.announcedAddresses,
        ports: `${config.rtc.minPort}-${config.rtc.minPort + pool.portsInUse - 1}`,
      },
      'mediasoup worker pool ready',
    );
    return pool;
  }

  get size(): number {
    return this.workers.length;
  }

  get all(): readonly PooledWorker[] {
    return this.workers;
  }

  private get portsInUse(): number {
    return this.workers.length * this.config.rtc.announcedAddresses.length;
  }

  /** Picks the worker hosting the fewest routers. */
  leastLoaded(): PooledWorker {
    const [first, ...rest] = this.workers;
    if (!first) throw new Error('worker pool is empty');
    return rest.reduce(
      (best, candidate) => (candidate.routers < best.routers ? candidate : best),
      first,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { worker } of this.workers) worker.close();
    this.workers.length = 0;
  }

  private async spawn(index: number): Promise<PooledWorker> {
    const { rtc } = this.config;
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      appData: { index },
    });

    worker.on('died', (error) => {
      if (this.closed) return;
      // A dead worker takes its routers with it; the process manager restarts the service.
      this.log.fatal({ err: error, index }, 'mediasoup worker died, exiting');
      setTimeout(() => process.exit(1), 500);
    });

    const basePort = rtc.minPort + index * rtc.announcedAddresses.length;
    const listenInfos = rtc.announcedAddresses.flatMap((announcedAddress, offset) =>
      (['udp', 'tcp'] as const).map((protocol): types.TransportListenInfo => ({
        protocol,
        ip: rtc.listenIp,
        announcedAddress,
        port: basePort + offset,
      })),
    );
    const webRtcServer = await worker.createWebRtcServer({ listenInfos });

    return { index, worker, webRtcServer, routers: 0 };
  }
}
