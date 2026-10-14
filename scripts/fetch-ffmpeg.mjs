// Puts the ffmpeg the desktop app ships with in apps/desktop/vendor/ffmpeg, where the installer
// (and the app run from the sources) picks it up. It is the LGPL build of the 9.0 branch from
// BtbN/FFmpeg-Builds: screen capture, the cards' encoders and SRTP are all in it. Runs as part
// of `pnpm --filter @frequencia/desktop package`; delete the folder to fetch a newer build.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BUILD = 'ffmpeg-n9.0-latest-win64-lgpl-9.0';
const URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${BUILD}.zip`;

const directory = path.resolve(import.meta.dirname, '../apps/desktop/vendor/ffmpeg');
const binary = path.join(directory, 'ffmpeg.exe');

if (existsSync(binary)) process.exit(0);
if (process.platform !== 'win32') {
  console.error('The bundled ffmpeg is a Windows build: package the desktop app on Windows.');
  process.exit(1);
}

console.log(`> downloading ${BUILD} (170 MB)`);
mkdirSync(directory, { recursive: true });
const zip = path.join(directory, 'ffmpeg.zip');
const response = await fetch(URL);
if (!response.ok) {
  console.error(`download failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}
writeFileSync(zip, Buffer.from(await response.arrayBuffer()));

// The tar that comes with Windows reads zip files; the one from Git does not.
const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const unpack = (member, depth) =>
  spawnSync(tar, ['-xf', zip, '-C', directory, `--strip-components=${depth}`, member], {
    stdio: 'inherit',
  }).status === 0;
// The licence travels with the binary it covers.
const unpacked = unpack(`${BUILD}/bin/ffmpeg.exe`, 2) && unpack(`${BUILD}/LICENSE.txt`, 1);
rmSync(zip);
if (!unpacked || !existsSync(binary)) {
  console.error('could not unpack ffmpeg.exe');
  process.exit(1);
}
console.log(`> ffmpeg is in ${directory}`);
