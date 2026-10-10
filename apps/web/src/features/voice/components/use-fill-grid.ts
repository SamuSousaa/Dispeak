import { useLayoutEffect, useState } from 'react';

export interface GridCell {
  width: number;
  height: number;
}

/**
 * The largest tiles of a given proportion that fit `count` items in a box, trying every
 * number of columns. On a box that is wider than tall the grid is never taller than wide: two
 * people sit side by side, as in every call app, even where stacking them would make each
 * tile a little bigger. Pure, so the arithmetic is easy to test.
 */
export function fillGrid(
  boxWidth: number,
  boxHeight: number,
  count: number,
  aspect: number,
  gap: number,
): GridCell {
  if (count <= 0 || boxWidth <= 0 || boxHeight <= 0) return { width: 0, height: 0 };
  const landscape = boxWidth >= boxHeight;
  let best: GridCell = { width: 0, height: 0 };
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    if (landscape && columns < rows) continue;
    let width = (boxWidth - gap * (columns - 1)) / columns;
    let height = width / aspect;
    const tallest = (boxHeight - gap * (rows - 1)) / rows;
    if (height > tallest) {
      height = tallest;
      width = height * aspect;
    }
    if (width > best.width) best = { width, height };
  }
  return { width: Math.floor(best.width), height: Math.floor(best.height) };
}

/** Size of each tile so that `count` of them fill the element as well as they can. */
export function useFillGrid(
  /** The grid itself; it comes and goes, and each time it has to be measured afresh. */
  element: HTMLElement | null,
  count: number,
  aspect = 16 / 9,
  gap = 12,
): GridCell {
  const [cell, setCell] = useState<GridCell>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const width =
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height =
        element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const next = fillGrid(width, height, count, aspect, gap);
      setCell((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, count, aspect, gap]);

  return cell;
}
