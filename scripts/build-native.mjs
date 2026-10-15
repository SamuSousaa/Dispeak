// Compiles the desktop app's Rust programs into apps/desktop/vendor, where the installer (and
// the app run from the sources) picks them up:
//
// - native/capture → vendor/capture/dispeaker-capture.exe, the screen capture engine;
// - native/host    → vendor/host/dispeaker-host.exe, everything else the app asks of Windows
//                    (window in front, timers, graphics card counters, games running).
//
// Needs Rust with the x86_64-pc-windows-gnu toolchain (rustup); no Visual Studio. Runs as part
// of `pnpm --filter @frequencia/desktop package`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const desktop = path.resolve(import.meta.dirname, '../apps/desktop');
const programs = [
  { crate: 'native/capture', name: 'dispeaker-capture.exe', vendor: 'vendor/capture' },
  { crate: 'native/host', name: 'dispeaker-host.exe', vendor: 'vendor/host' },
];

if (process.platform !== 'win32') {
  console.error('These are Windows programs: package the desktop app on Windows.');
  process.exit(1);
}

// rustup puts cargo here; a shell opened before the install does not have it on PATH yet.
const cargoBin = path.join(homedir(), '.cargo', 'bin');
const env = { ...process.env, PATH: `${cargoBin}${path.delimiter}${process.env.PATH ?? ''}` };
const installed = path.join(cargoBin, 'cargo.exe');
const cargo = existsSync(installed) ? installed : 'cargo.exe';

for (const program of programs) {
  const crate = path.join(desktop, program.crate);
  const built = spawnSync(cargo, ['build', '--release', '--locked'], {
    cwd: crate,
    env,
    stdio: 'inherit',
  });
  const binary = path.join(crate, 'target/release', program.name);
  if (built.status !== 0 || !existsSync(binary)) {
    console.error(`could not build ${program.name} (is Rust installed? https://rustup.rs)`);
    process.exit(1);
  }
  const directory = path.join(desktop, program.vendor);
  mkdirSync(directory, { recursive: true });
  copyFileSync(binary, path.join(directory, program.name));
  console.log(`> ${program.name} is in ${directory}`);
}
