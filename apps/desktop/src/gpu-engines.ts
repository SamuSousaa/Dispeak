import type { DesktopGpuUsage } from '@frequencia/shared';

type Engines = DesktopGpuUsage['app'];

/**
 * Engine types as Windows names them ("3d", "copy", "video codec engine" on AMD, "videodecode"
 * and "videoencode" on NVIDIA and Intel, "video jpeg 0", "compute 0"), folded into what
 * matters for a stream.
 */
function kindOf(type: string): keyof Engines | null {
  const name = type.toLowerCase().replace(/[\s_]+/g, '');
  if (name === '3d' || name.startsWith('graphics')) return 'threeD';
  // Pictures of a webcam or a photo viewer, not a stream.
  if (name.startsWith('videojpeg')) return null;
  if (name.startsWith('video')) return 'video';
  if (name.startsWith('copy')) return 'copy';
  return null;
}

/**
 * Sums of each engine (keys `<engine id>|<type>`) as the busiest engine of each kind, 0 to
 * 100: what the Task Manager shows for that kind.
 */
export function foldEngines(table: Record<string, number>): Engines {
  const result: Engines = { threeD: 0, video: 0, copy: 0 };
  for (const [engine, value] of Object.entries(table)) {
    const kind = kindOf(engine.split('|')[1] ?? '');
    if (kind) result[kind] = Math.max(result[kind], value);
  }
  return {
    threeD: Math.min(100, Math.round(result.threeD)),
    video: Math.min(100, Math.round(result.video)),
    copy: Math.min(100, Math.round(result.copy)),
  };
}
