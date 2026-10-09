import { loadConfig } from './config';
import { createHttpServer } from './http';
import { createLogger } from './logger';
import { WorkerPool } from './worker-pool';

const config = loadConfig();
const log = createLogger(config);

const pool = await WorkerPool.create(config, log);
const server = createHttpServer(pool);

const shutdown = (signal: string) => {
  log.info({ signal }, 'shutting down');
  server.close();
  pool.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(config.port, config.host, () => {
  log.info({ host: config.host, port: config.port }, 'media service listening');
});
