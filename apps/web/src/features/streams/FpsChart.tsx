import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { median } from './stream-summary';

export interface ChartPoint {
  /** Seconds since the stream started. */
  t: number;
  value: number | null;
}

const HEIGHT = 120;
const PAD = { top: 10, right: 12, bottom: 20, left: 32 };

/** `85` → `1:25`. */
export function clock(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Ticks of a scale from zero: 0, half and top, with the top rounded up to a tidy number. */
function scaleTop(max: number): number {
  const step = max <= 30 ? 10 : max <= 120 ? 30 : 60;
  return Math.max(step, Math.ceil(max / step) * step);
}

/**
 * Frames per second over a stream, one line, against the rate it aimed at. Hovering shows the
 * value at that moment; the table below the charts has every number.
 */
export function FpsChart({
  title,
  points,
  target,
}: {
  title: string;
  points: ChartPoint[];
  target: number | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(200, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const top = scaleTop(Math.max(target ?? 0, ...values, 1));
  const lastT = Math.max(points.at(-1)?.t ?? 1, 1);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + (t / lastT) * plotW;
  const y = (value: number) => PAD.top + plotH - (Math.min(value, top) / top) * plotH;

  // Missing samples break the line instead of bridging the gap.
  const path = points
    .map((point, index) => {
      if (point.value === null) return '';
      const previous = points[index - 1];
      const command = !previous || previous.value === null ? 'M' : 'L';
      return `${command}${x(point.t).toFixed(1)},${y(point.value).toFixed(1)}`;
    })
    .join('');

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const t = ((event.clientX - rect.left - PAD.left) / plotW) * lastT;
    let nearest = 0;
    points.forEach((point, index) => {
      if (Math.abs(point.t - t) < Math.abs((points[nearest]?.t ?? 0) - t)) nearest = index;
    });
    setHover(points.length > 0 ? nearest : null);
  };

  const hovered = hover === null ? undefined : points[hover];
  const ticks = [0, top / 2, top];

  return (
    <figure className="m-0 border border-line bg-surface">
      <figcaption className="flex items-baseline justify-between gap-2 border-b border-line px-3 py-2">
        <span className="label text-fg">{title}</span>
        <span className="label tabular-nums text-muted" aria-live="polite">
          {hovered
            ? `${clock(hovered.t)} · ${hovered.value === null ? '—' : `${hovered.value} FPS`}`
            : `MEDIANA ${median(values) ?? '—'} FPS`}
        </span>
      </figcaption>
      <div ref={box} className="px-1 py-1">
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`${title}: quadros por segundo ao longo da transmissão`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          className="block touch-none"
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--line)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                className="fill-[var(--muted)] font-mono text-[10px] tabular-nums"
              >
                {tick}
              </text>
            </g>
          ))}
          {target !== null && (
            <g>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(target)}
                y2={y(target)}
                stroke="var(--line-strong)"
                strokeWidth={1}
              />
              {/* Under the line, where there is no room above it. */}
              <text
                x={width - PAD.right}
                y={y(target) - PAD.top < 12 ? y(target) + 12 : y(target) - 4}
                textAnchor="end"
                className="fill-[var(--muted)] font-mono text-[10px]"
              >
                ALVO {target}
              </text>
            </g>
          )}
          <text
            x={PAD.left}
            y={HEIGHT - 4}
            className="fill-[var(--muted)] font-mono text-[10px] tabular-nums"
          >
            0:00
          </text>
          <text
            x={width - PAD.right}
            y={HEIGHT - 4}
            textAnchor="end"
            className="fill-[var(--muted)] font-mono text-[10px] tabular-nums"
          >
            {clock(lastT)}
          </text>
          <path
            d={path}
            fill="none"
            stroke="var(--fg)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* A point with no neighbour draws no line: it gets a dot. */}
          {points.map((point, index) =>
            point.value !== null &&
            (points[index - 1]?.value ?? null) === null &&
            (points[index + 1]?.value ?? null) === null ? (
              <circle key={point.t} cx={x(point.t)} cy={y(point.value)} r={4} fill="var(--fg)" />
            ) : null,
          )}
          {hovered && (
            <g pointerEvents="none">
              <line
                x1={x(hovered.t)}
                x2={x(hovered.t)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke="var(--line-strong)"
                strokeWidth={1}
              />
              {hovered.value !== null && (
                <circle
                  cx={x(hovered.t)}
                  cy={y(hovered.value)}
                  r={4}
                  fill="var(--accent)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              )}
            </g>
          )}
        </svg>
      </div>
    </figure>
  );
}
