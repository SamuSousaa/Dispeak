import type { ImageContentType } from '@frequencia/shared';

export interface ImageInfo {
  contentType: ImageContentType;
  /** `null` when the header does not carry a usable size. */
  width: number | null;
  height: number | null;
}

const MAX_DIMENSION = 65_535;

const sized = (contentType: ImageContentType, width: number, height: number): ImageInfo => {
  const valid = width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION;
  return { contentType, width: valid ? width : null, height: valid ? height : null };
};

const ascii = (data: Buffer, start: number, end: number) => data.toString('latin1', start, end);

function jpegSize(data: Buffer): ImageInfo {
  let offset = 2;
  while (offset + 9 < data.length && data[offset] === 0xff) {
    const marker = data[offset + 1] ?? 0;
    // Fill bytes and markers without a payload.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    // Start-of-frame markers carry the size; C4, C8 and CC share the range but are not frames.
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return sized('image/jpeg', data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5));
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  return { contentType: 'image/jpeg', width: null, height: null };
}

function webpSize(data: Buffer): ImageInfo {
  const unknown: ImageInfo = { contentType: 'image/webp', width: null, height: null };
  if (data.length < 30) return unknown;
  switch (ascii(data, 12, 16)) {
    case 'VP8 ':
      return sized('image/webp', data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
    case 'VP8L': {
      const bits = data.readUInt32LE(21);
      return sized('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    case 'VP8X':
      return sized('image/webp', data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1);
    default:
      return unknown;
  }
}

/**
 * Identifies an image by its leading bytes, never by the name or the declared type, and reads
 * its pixel size from the header. Returns `null` for anything that is not PNG, JPEG, GIF or WebP.
 */
export function sniffImage(data: Buffer): ImageInfo | null {
  if (data.length < 12) return null;
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (data.length < 24) return null;
    return sized('image/png', data.readUInt32BE(16), data.readUInt32BE(20));
  }
  const signature = ascii(data, 0, 6);
  if (signature === 'GIF87a' || signature === 'GIF89a') {
    return sized('image/gif', data.readUInt16LE(6), data.readUInt16LE(8));
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return jpegSize(data);
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return webpSize(data);
  return null;
}
