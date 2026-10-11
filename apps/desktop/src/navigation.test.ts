import { describe, expect, it } from 'vitest';
import { isAppUrl, isExternalLink } from './navigation';

const appUrl = new URL('https://dispeaker.example');

describe('isAppUrl', () => {
  it('accepts any page of the app origin', () => {
    expect(isAppUrl('https://dispeaker.example/app/123', appUrl)).toBe(true);
  });

  it('rejects other origins, lookalikes and garbage', () => {
    expect(isAppUrl('https://dispeaker.example.evil.test/', appUrl)).toBe(false);
    expect(isAppUrl('http://dispeaker.example/', appUrl)).toBe(false);
    expect(isAppUrl('not a url', appUrl)).toBe(false);
  });
});

describe('isExternalLink', () => {
  it('lets web and mail links out, nothing else', () => {
    expect(isExternalLink('https://example.com')).toBe(true);
    expect(isExternalLink('mailto:a@example.com')).toBe(true);
    expect(isExternalLink('file:///C:/Windows/system32/calc.exe')).toBe(false);
    expect(isExternalLink('javascript:alert(1)')).toBe(false);
  });
});
