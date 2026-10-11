import { describe, expect, it } from 'vitest';
import { parseReleaseFeed } from './release';

const FEED = `version: 0.4.0
files:
  - url: Dispeaker-Setup-0.4.0.exe
    sha512: abc==
    size: 111893465
path: Dispeaker-Setup-0.4.0.exe
sha512: abc==
releaseDate: '2026-10-11T21:30:00.000Z'
`;

describe('parseReleaseFeed', () => {
  it('reads the version and the date of the newest release', () => {
    const release = parseReleaseFeed(FEED);
    expect(release?.version).toBe('0.4.0');
    expect(release?.releasedAt?.toISOString()).toBe('2026-10-11T21:30:00.000Z');
  });

  it('accepts a feed without a date', () => {
    expect(parseReleaseFeed('version: 1.2.3\n')).toEqual({ version: '1.2.3', releasedAt: null });
  });

  it('rejects what is not a feed', () => {
    expect(parseReleaseFeed('<!doctype html><html lang="pt-BR"></html>')).toBeNull();
    expect(parseReleaseFeed('version: latest\n')).toBeNull();
  });
});
