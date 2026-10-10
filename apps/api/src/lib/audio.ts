import type { GuildSoundContentType } from '@frequencia/shared';

const ascii = (data: Buffer, start: number, end: number) => data.toString('latin1', start, end);

/**
 * Identifies an audio file by its leading bytes, never by the name or the declared type.
 * Returns `null` for anything that is not MP3, WAV, Ogg, FLAC, MP4/M4A or WebM.
 */
export function sniffAudio(data: Buffer): GuildSoundContentType | null {
  if (data.length < 12) return null;
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(data, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(data, 0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(data, 4, 8) === 'ftyp') return 'audio/mp4';
  if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'audio/webm';
  if (ascii(data, 0, 3) === 'ID3') return 'audio/mpeg';
  // A bare MPEG audio frame: eleven sync bits, then a version, a layer, a bitrate and a sample
  // rate that are not the reserved values.
  const [first = 0, second = 0, third = 0] = data;
  const isFrame =
    first === 0xff &&
    (second & 0xe0) === 0xe0 &&
    (second & 0x18) !== 0x08 &&
    (second & 0x06) !== 0x00 &&
    (third & 0xf0) !== 0xf0 &&
    (third & 0x0c) !== 0x0c;
  return isFrame ? 'audio/mpeg' : null;
}
