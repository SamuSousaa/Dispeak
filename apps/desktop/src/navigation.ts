/** Whether `url` belongs to the web app, the only thing the main window is allowed to show. */
export function isAppUrl(url: string, appUrl: URL): boolean {
  try {
    return new URL(url).origin === appUrl.origin;
  } catch {
    return false;
  }
}

/** Links the operating system may open in the default browser. */
export function isExternalLink(url: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
