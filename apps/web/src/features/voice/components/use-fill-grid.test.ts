import { describe, expect, it } from 'vitest';
import { fillGrid } from './use-fill-grid';

describe('fillGrid', () => {
  it('gives one participant the whole box, at 16:9', () => {
    expect(fillGrid(1600, 900, 1, 16 / 9, 12)).toEqual({ width: 1600, height: 900 });
    // A box that is too wide is limited by its height.
    expect(fillGrid(2000, 450, 1, 16 / 9, 12)).toEqual({ width: 800, height: 450 });
  });

  it('puts two side by side on a wide screen and stacked on a tall one', () => {
    const wide = fillGrid(1612, 600, 2, 16 / 9, 12);
    expect(wide).toEqual({ width: 800, height: 450 });
    const tall = fillGrid(400, 900, 2, 16 / 9, 12);
    expect(tall).toEqual({ width: 400, height: 225 });
  });

  it('grows the grid as people join', () => {
    const four = fillGrid(1200, 700, 4, 16 / 9, 12);
    // 2 x 2 beats 4 x 1 and 1 x 4.
    expect(four.width).toBeGreaterThan(550);
    expect(four.width * 2 + 12).toBeLessThanOrEqual(1200);
    expect(four.height * 2 + 12).toBeLessThanOrEqual(700);

    const nine = fillGrid(1200, 700, 9, 16 / 9, 12);
    expect(nine.width * 3 + 24).toBeLessThanOrEqual(1200);
    expect(nine.height * 3 + 24).toBeLessThanOrEqual(700);
    expect(nine.width).toBeLessThan(four.width);
  });

  it('has nothing to say about an empty box', () => {
    expect(fillGrid(0, 0, 3, 16 / 9, 12)).toEqual({ width: 0, height: 0 });
    expect(fillGrid(800, 600, 0, 16 / 9, 12)).toEqual({ width: 0, height: 0 });
  });
});
