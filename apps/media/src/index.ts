import { loadConfig } from './config';
import { createLogger } from './logger';
import { startMediaServer } from './server';

const config = loadConfig();
const log = createLogger(config);
const server = await startMediaServer(config, log);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
