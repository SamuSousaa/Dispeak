// Compiles apps/desktop/native/game-audio.cs into apps/desktop/vendor/game-audio, where the
// installer (and the app run from the sources) picks it up. It uses the C# compiler that is
// part of every Windows, so nothing has to be installed. Runs as part of
// `pnpm --filter @frequencia/desktop package`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const desktop = path.resolve(import.meta.dirname, '../apps/desktop');
const source = path.join(desktop, 'native/game-audio.cs');
const directory = path.join(desktop, 'vendor/game-audio');
const binary = path.join(directory, 'dispeaker-game-audio.exe');

if (process.platform !== 'win32') {
  console.error('The game audio helper is a Windows program: package the desktop app on Windows.');
  process.exit(1);
}
const compiler = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
);
if (!existsSync(compiler)) {
  console.error(`C# compiler not found at ${compiler}`);
  process.exit(1);
}

mkdirSync(directory, { recursive: true });
const built = spawnSync(
  compiler,
  ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${binary}`, source],
  { stdio: 'inherit' },
);
if (built.status !== 0 || !existsSync(binary)) {
  console.error('could not compile the game audio helper');
  process.exit(1);
}
console.log(`> game audio helper is in ${directory}`);
