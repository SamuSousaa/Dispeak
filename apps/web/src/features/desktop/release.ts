/** Where the installer of the newest desktop app is always served from. */
export const INSTALLER_URL = '/download/Dispeaker-Setup.exe';
/** The update feed the app itself reads; the page shows the version from it. */
export const RELEASE_FEED_URL = '/download/latest.yml';

export interface DesktopRelease {
  version: string;
  releasedAt: Date | null;
}

/**
 * Reads the two fields the page shows out of electron-builder's `latest.yml`. Anything else
 * (the single-page app's HTML where no release was uploaded yet, for one) gives `null`.
 */
export function parseReleaseFeed(text: string): DesktopRelease | null {
  const field = (name: string) =>
    new RegExp(`^${name}:\\s*['"]?([^'"\\r\\n]+)['"]?\\s*$`, 'm').exec(text)?.[1]?.trim();
  const version = field('version');
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) return null;
  const date = new Date(field('releaseDate') ?? '');
  return { version, releasedAt: Number.isNaN(date.getTime()) ? null : date };
}

export async function fetchDesktopRelease(): Promise<DesktopRelease | null> {
  const response = await fetch(RELEASE_FEED_URL, { cache: 'no-store' });
  if (!response.ok) return null;
  return parseReleaseFeed(await response.text());
}
