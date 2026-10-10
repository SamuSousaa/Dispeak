/** Display name of an upload: no path, no control characters. Never used as a path. */
export function cleanFilename(filename: string, fallback: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const clean = [...base]
    .filter((char) => char >= ' ' && char !== '\u007f')
    .join('')
    .trim();
  return clean.slice(0, 255) || fallback;
}
