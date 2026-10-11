// Builds the Windows installer of the desktop app and puts it on the server, where the
// download page and the app's own updater find it. Usage: `pnpm release:desktop`, after
// raising `version` in apps/desktop/package.json. Settings come from `.env.release`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const target = process.env.DESKTOP_RELEASE_SSH;
const directory = process.env.DESKTOP_RELEASE_DIR ?? '/opt/frequencia/downloads';
const key = process.env.DESKTOP_RELEASE_KEY;

if (!target) {
  console.error('Set DESKTOP_RELEASE_SSH (user@host) in .env.release — see .env.release.example.');
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, ...options });
  if (result.status !== 0) {
    console.error(`\n${command} ${args.join(' ')} failed`);
    process.exit(result.status ?? 1);
  }
}

const { version } = JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'));
const release = path.join(root, 'apps/desktop/release');
const installer = `Dispeaker-Setup-${version}.exe`;

console.log(`\n> building ${installer}`);
run('pnpm', ['--filter', '@frequencia/desktop', 'package'], { shell: true });

const files = [installer, `${installer}.blockmap`, 'latest.yml'];
for (const file of files) {
  if (!existsSync(path.join(release, file))) {
    console.error(`missing ${file} in apps/desktop/release`);
    process.exit(1);
  }
}

const identity = key ? ['-i', key] : [];
run('ssh', [...identity, target, `mkdir -p ${directory}`]);
// The feed goes last: it must never name an installer that is not there yet.
for (const file of files) {
  console.log(`\n> uploading ${file}`);
  run('scp', [...identity, '-q', path.join(release, file), `${target}:${directory}/${file}`]);
}
// The fixed name the download page links to.
run('ssh', [...identity, target, `cp ${directory}/${installer} ${directory}/Dispeaker-Setup.exe`]);

console.log(`\nVersion ${version} is published. Installed apps pick it up within a few hours.`);
