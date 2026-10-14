import net from 'node:net';
import type { DesktopNativeCapturePreview } from '@frequencia/shared';

/** Bigger than any preview the engine makes (640x360); anything else is not the engine. */
const MAX_SIDE = 4096;

/**
 * Splits the engine's preview stream into pictures: width and height (u32, little endian),
 * then the BGRA rows. Returns what is left over for the next chunk, or `null` when the bytes
 * cannot be a preview.
 */
export function readPictures(
  buffer: Buffer,
  onPicture: (picture: DesktopNativeCapturePreview) => void,
): Buffer | null {
  let rest = buffer;
  while (rest.length >= 8) {
    const width = rest.readUInt32LE(0);
    const height = rest.readUInt32LE(4);
    if (width === 0 || height === 0 || width > MAX_SIDE || height > MAX_SIDE) return null;
    const size = 8 + width * height * 4;
    if (rest.length < size) break;
    // A copy: the picture leaves for the page while the buffer is reused.
    onPicture({ width, height, data: new Uint8Array(rest.subarray(8, size)) });
    rest = rest.subarray(size);
  }
  return rest;
}

/**
 * A socket on this machine only, for the capture engine to send the streamer's own preview
 * to. It takes one connection, the engine's, and closes with it.
 */
export function openPreviewServer(
  onPicture: (picture: DesktopNativeCapturePreview) => void,
): Promise<{ port: number; close: () => void }> {
  const server = net.createServer();
  let engine: net.Socket | null = null;
  server.on('connection', (socket) => {
    if (engine) {
      socket.destroy();
      return;
    }
    engine = socket;
    let pending: Buffer | null = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = readPictures(pending ? Buffer.concat([pending, chunk]) : chunk, onPicture);
      if (!pending) socket.destroy();
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => {
          engine?.destroy();
          server.close();
        },
      });
    });
  });
}
