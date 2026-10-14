// Compiles the capture engine (apps/desktop/native/capture, Rust) into
// apps/desktop/vendor/capture, where the installer (and the app run from the sources) picks it
// up. Needs Rust with the x86_64-pc-windows-gnu toolchain (rustup); no Visual Studio. Runs as
// part of `pnpm --filter @frequencia/desktop package`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const desktop = path.resolve(import.meta.dirname, '../apps/desktop');
const crate = path.join(desktop, 'native/capture');
const directory = path.join(desktop, 'vendor/capture');
const name = 'dispeaker-capture.exe';

if (process.platform !== 'win32') {
  console.error('The capture engine is a Windows program: package the desktop app on Windows.');
  process.exit(1);
}

// rustup puts cargo here; a shell opened before the install does not have it on PATH yet.
const cargoBin = path.join(homedir(), '.cargo', 'bin');
const env = { ...process.env, PATH: `${cargoBin}${path.delimiter}${process.env.PATH ?? ''}` };
const installed = path.join(cargoBin, 'cargo.exe');
const cargo = existsSync(installed) ? installed : 'cargo.exe';
const built = spawnSync(cargo, ['build', '--release', '--locked'], {
  cwd: crate,
  env,
  stdio: 'inherit',
});
const binary = path.join(crate, 'target/release', name);
if (built.status !== 0 || !existsSync(binary)) {
  console.error('could not build the capture engine (is Rust installed? https://rustup.rs)');
  process.exit(1);
}
mkdirSync(directory, { recursive: true });
copyFileSync(binary, path.join(directory, name));
console.log(`> capture engine is in ${directory}`);
