import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from './config';
import { createHttpServer } from './http';
import type { Logger } from './logger';
import { RoomManager } from './rooms/room-manager';
import { VoiceServer } from './signaling/voice-server';
import { WorkerPool } from './worker-pool';

export interface MediaServer {
  http: http.Server;
  pool: WorkerPool;
  rooms: RoomManager;
  voice: VoiceServer;
  /** Port the HTTP server is bound to (useful when configured with port 0). */
  port: number;
  close: () => Promise<void>;
}

/** Wires the whole media service together and starts listening. */
export async function startMediaServer(config: Config, log: Logger): Promise<MediaServer> {
  const pool = await WorkerPool.create(config, log);
  const rooms = new RoomManager(pool, config, log);
  const voice = new VoiceServer(rooms, config, log);
  const server = createHttpServer({ config, pool, rooms, voice });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  log.info({ host: config.host, port }, 'media service listening');

  return {
    http: server,
    pool,
    rooms,
    voice,
    port,
    close: async () => {
      voice.close();
      rooms.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      pool.close();
    },
  };
}
