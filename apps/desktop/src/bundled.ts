import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * A program that comes with the app: beside the installed app or, run from the sources, in
 * `vendor` (put there by the scripts that `package` runs). `null` when it is not there.
 */
export function findBundled(folder: string, file: string): string | null {
  const candidates = [
    path.join(process.resourcesPath, folder, file),
    path.join(app.getAppPath(), 'vendor', folder, file),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}
