// Frees the dev ports when a previous run was not shut down cleanly.
import { execSync } from 'node:child_process';

const ports = process.argv.slice(2).map(Number).filter(Boolean);
const targets = ports.length > 0 ? ports : [5173, 4000, 4100];

for (const port of targets) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`, {
        encoding: 'utf8',
      });
      const pids = new Set(
        output
          .split(/\r?\n/)
          .filter((line) => line.includes(`:${port} `))
          .map((line) => line.trim().split(/\s+/).at(-1)),
      );
      for (const pid of pids) if (pid) execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else {
      execSync(`lsof -ti tcp:${port} | xargs -r kill -9`, { stdio: 'ignore' });
    }
  } catch {
    // Nothing is listening on this port.
  }
}
