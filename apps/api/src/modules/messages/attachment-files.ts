import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Attachment bytes on local disk, one file per attachment named after its id. Nothing a user
 * typed ever becomes part of a path.
 */
export class AttachmentFiles {
  private ready: Promise<unknown> | null = null;

  constructor(private readonly directory: string) {}

  private pathOf(id: string): string {
    if (!UUID.test(id)) throw new Error('invalid attachment id');
    return path.join(this.directory, id);
  }

  private ensureDirectory(): Promise<unknown> {
    this.ready ??= mkdir(this.directory, { recursive: true });
    return this.ready;
  }

  async write(id: string, data: Buffer): Promise<void> {
    await this.ensureDirectory();
    // `wx`: ids are random, an existing file would mean something is very wrong.
    await writeFile(this.pathOf(id), data, { flag: 'wx' });
  }

  open(id: string): ReadStream {
    return createReadStream(this.pathOf(id));
  }

  /** Best effort: a file that is already gone is not an error. */
  async remove(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => rm(this.pathOf(id), { force: true })));
  }

  /** Ids of the stored files last written before `olderThan`. */
  async list(olderThan: Date): Promise<string[]> {
    await this.ensureDirectory();
    const ids: string[] = [];
    for (const name of await readdir(this.directory)) {
      if (!UUID.test(name)) continue;
      const info = await stat(path.join(this.directory, name)).catch(() => null);
      if (info && info.mtime < olderThan) ids.push(name);
    }
    return ids;
  }
}
