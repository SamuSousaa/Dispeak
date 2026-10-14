import net from 'node:net';
import type { DesktopNativeCapturePreview } from '@frequencia/shared';
import { describe, expect, it } from 'vitest';
import { openPreviewServer, readPictures } from './capture-preview';

function picture(width: number, height: number, fill: number): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(width, 0);
  header.writeUInt32LE(height, 4);
  return Buffer.concat([header, Buffer.alloc(width * height * 4, fill)]);
}

describe('readPictures', () => {
  it('splits pictures and keeps what is left for the next chunk', () => {
    const seen: DesktopNativeCapturePreview[] = [];
    const bytes = Buffer.concat([picture(2, 1, 7), picture(1, 1, 9)]);
    const rest = readPictures(bytes.subarray(0, bytes.length - 3), (p) => seen.push(p));
    expect(seen).toEqual([{ width: 2, height: 1, data: new Uint8Array(8).fill(7) }]);
    expect(rest?.length).toBe(9);
  });

  it('gives up on bytes that cannot be a preview', () => {
    expect(readPictures(picture(0, 4, 0), () => undefined)).toBeNull();
    const huge = Buffer.alloc(8);
    huge.writeUInt32LE(100_000, 0);
    huge.writeUInt32LE(1, 4);
    expect(readPictures(huge, () => undefined)).toBeNull();
  });
});

describe('openPreviewServer', () => {
  it('takes the pictures of the first connection only', async () => {
    const seen: DesktopNativeCapturePreview[] = [];
    const server = await openPreviewServer((p) => seen.push(p));
    const engine = net.connect(server.port, '127.0.0.1');
    await new Promise((resolve) => engine.once('connect', resolve));
    const intruder = net.connect(server.port, '127.0.0.1');
    const closed = new Promise((resolve) => intruder.once('close', resolve));
    intruder.on('error', () => undefined);
    // Written in two pieces, as a socket may deliver it.
    const bytes = picture(4, 2, 1);
    engine.write(bytes.subarray(0, 10));
    engine.write(bytes.subarray(10));
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ width: 4, height: 2 });
    await closed;
    server.close();
    engine.destroy();
  });
});
