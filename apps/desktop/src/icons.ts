import { crc32, deflateSync } from 'node:zlib';

/**
 * The few small icons the app shows outside its window: the notification area and the buttons
 * under the taskbar thumbnail. They are drawn here, from shapes, at every size Windows asks for
 * (one per display scale), so they stay sharp and need no image files. Transparent around the
 * drawing: only the mark itself shows on the taskbar.
 */

type Point = readonly [number, number];

export type Shape =
  /** A line with round ends; `extend` lengthens both ends, for square-looking caps. */
  | { kind: 'line'; from: Point; to: Point; width: number; color: string; extend?: number }
  /** Part of a circle, from one angle to another (degrees, clockwise from 3 o'clock). */
  | {
      kind: 'arc';
      center: Point;
      radius: number;
      from: number;
      to: number;
      width: number;
      color: string;
    }
  /** A filled rectangle with rounded corners. */
  | { kind: 'box'; min: Point; max: Point; radius: number; color: string };

export interface Drawing {
  /** Side of the square the shapes are laid out in. */
  grid: number;
  shapes: Shape[];
}

const SAMPLES = 4;

function rgb(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = dx * dx + dy * dy;
  const t =
    length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Whether a point of the grid is inside the shape. */
function inside(shape: Shape, p: Point): boolean {
  switch (shape.kind) {
    case 'line': {
      const extend = shape.extend ?? 0;
      const [dx, dy] = [shape.to[0] - shape.from[0], shape.to[1] - shape.from[1]];
      const length = Math.hypot(dx, dy) || 1;
      const [ux, uy] = [(dx / length) * extend, (dy / length) * extend];
      const a: Point = [shape.from[0] - ux, shape.from[1] - uy];
      const b: Point = [shape.to[0] + ux, shape.to[1] + uy];
      return segmentDistance(p, a, b) <= shape.width / 2;
    }
    case 'arc': {
      const [cx, cy] = shape.center;
      let angle = (Math.atan2(p[1] - cy, p[0] - cx) * 180) / Math.PI;
      if (angle < shape.from) angle += 360;
      if (angle <= shape.to) {
        return Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - shape.radius) <= shape.width / 2;
      }
      const end = (degrees: number): Point => [
        cx + shape.radius * Math.cos((degrees * Math.PI) / 180),
        cy + shape.radius * Math.sin((degrees * Math.PI) / 180),
      ];
      const [a, b] = [end(shape.from), end(shape.to)];
      return Math.min(segmentDistance(p, a, a), segmentDistance(p, b, b)) <= shape.width / 2;
    }
    case 'box': {
      const r = shape.radius;
      const qx = Math.max(shape.min[0] + r - p[0], 0, p[0] - (shape.max[0] - r));
      const qy = Math.max(shape.min[1] + r - p[1], 0, p[1] - (shape.max[1] - r));
      return Math.hypot(qx, qy) <= r;
    }
  }
}

/** The drawing as RGBA pixels, `size` by `size`, each shape painted over the ones before. */
export function rasterize(drawing: Drawing, size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const scale = drawing.grid / size;
  for (const shape of drawing.shapes) {
    const [r, g, b] = rgb(shape.color);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let hits = 0;
        for (let sy = 0; sy < SAMPLES; sy++) {
          for (let sx = 0; sx < SAMPLES; sx++) {
            const point: Point = [
              (x + (sx + 0.5) / SAMPLES) * scale,
              (y + (sy + 0.5) / SAMPLES) * scale,
            ];
            if (inside(shape, point)) hits++;
          }
        }
        if (hits === 0) continue;
        const alpha = hits / (SAMPLES * SAMPLES);
        const i = (y * size + x) * 4;
        const below = (pixels[i + 3] ?? 0) / 255;
        const out = alpha + below * (1 - alpha);
        const mix = (top: number, bottom: number) =>
          Math.round((top * alpha + bottom * below * (1 - alpha)) / out);
        pixels[i] = mix(r, pixels[i] ?? 0);
        pixels[i + 1] = mix(g, pixels[i + 1] ?? 0);
        pixels[i + 2] = mix(b, pixels[i + 2] ?? 0);
        pixels[i + 3] = Math.round(out * 255);
      }
    }
  }
  return pixels;
}

/** RGBA pixels as a PNG file. */
export function encodePng(pixels: Uint8Array, size: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  // Each row starts with its filter type: 0, none.
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * size * 4, size * 4).copy(
      rows,
      y * (size * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the icons ----------------------------------------------------------------------------

export const COLORS = {
  accent: '#ccf200',
  idle: '#8a8a8a',
  fg: '#ededed',
  /** Icons on a light system theme. */
  fgOnLight: '#1a1a1a',
  danger: '#ff5a4d',
} as const;

/** The mark of the app: a line of sound frequency, as in the favicon, filling the square. */
export function markDrawing(color: string, slashed = false): Drawing {
  const points: Point[] = [
    [5, 16],
    [9, 16],
    [12, 7],
    [17, 25],
    [21, 12],
    [23, 16],
    [27, 16],
  ];
  const width = 3;
  const shapes: Shape[] = points.slice(1).map((to, index) => ({
    kind: 'line',
    from: points[index] ?? to,
    to,
    width,
    color,
  }));
  // Square ends on the outside, like the favicon's stroke.
  const first = shapes[0];
  const last = shapes.at(-1);
  if (first?.kind === 'line') shapes[0] = { ...first, extend: width / 2 };
  if (last?.kind === 'line') shapes[shapes.length - 1] = { ...last, extend: width / 2 };
  if (slashed) {
    shapes.push({ kind: 'line', from: [7, 6], to: [25, 26], width: 3.2, color: COLORS.danger });
  }
  // The mark spans 4..28 across; the grid is cropped to it so it fills the icon.
  return {
    grid: 26,
    shapes: shapes.map((shape) => translate(shape, -3, -3)),
  };
}

function translate(shape: Shape, dx: number, dy: number): Shape {
  const move = (p: Point): Point => [p[0] + dx, p[1] + dy];
  switch (shape.kind) {
    case 'line':
      return { ...shape, from: move(shape.from), to: move(shape.to) };
    case 'arc':
      return { ...shape, center: move(shape.center) };
    case 'box':
      return { ...shape, min: move(shape.min), max: move(shape.max) };
  }
}

const slash = (): Shape => ({
  kind: 'line',
  from: [2.5, 2.5],
  to: [13.5, 13.5],
  width: 1.6,
  color: COLORS.danger,
});

/** `fg`: the colour of the icon when not muted, to stand out on the system theme. */
export function microphoneDrawing(muted: boolean, fg: string = COLORS.fg): Drawing {
  const color = muted ? COLORS.danger : fg;
  const shapes: Shape[] = [
    { kind: 'line', from: [8, 3.5], to: [8, 7.5], width: 4.2, color },
    { kind: 'arc', center: [8, 7.5], radius: 4.3, from: 0, to: 180, width: 1.3, color },
    { kind: 'line', from: [8, 11.8], to: [8, 14], width: 1.3, color },
    { kind: 'line', from: [5.5, 14.2], to: [10.5, 14.2], width: 1.3, color },
  ];
  if (muted) shapes.push(slash());
  return { grid: 16, shapes };
}

export function headphonesDrawing(deafened: boolean, fg: string = COLORS.fg): Drawing {
  const color = deafened ? COLORS.danger : fg;
  const shapes: Shape[] = [
    { kind: 'arc', center: [8, 9], radius: 5.6, from: 180, to: 360, width: 1.4, color },
    { kind: 'line', from: [2.4, 9], to: [2.4, 10], width: 1.4, color },
    { kind: 'line', from: [13.6, 9], to: [13.6, 10], width: 1.4, color },
    { kind: 'box', min: [1.6, 9.5], max: [5.2, 14.4], radius: 1, color },
    { kind: 'box', min: [10.8, 9.5], max: [14.4, 14.4], radius: 1, color },
  ];
  if (deafened) shapes.push(slash());
  return { grid: 16, shapes };
}

/** A handset lying down, as on the "hang up" button of a phone. */
export function hangUpDrawing(): Drawing {
  const color = COLORS.danger;
  return {
    grid: 16,
    shapes: [
      { kind: 'arc', center: [8, 11.5], radius: 6, from: 200, to: 340, width: 2.2, color },
      { kind: 'box', min: [1.2, 8.6], max: [4.6, 11.4], radius: 0.8, color },
      { kind: 'box', min: [11.4, 8.6], max: [14.8, 11.4], radius: 0.8, color },
    ],
  };
}
