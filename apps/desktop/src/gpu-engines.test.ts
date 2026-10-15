import { describe, expect, it } from 'vitest';
import { foldEngines } from './gpu-engines';

describe('foldEngines', () => {
  it('keeps the busiest engine of each kind, as the Task Manager does', () => {
    expect(
      foldEngines({
        'luid_a_phys_0_eng_0|3d': 30,
        'luid_a_phys_0_eng_3|3d': 55.4,
        'luid_a_phys_0_eng_1|copy': 2,
        'luid_a_phys_0_eng_7|video codec engine': 22.1,
        'luid_a_phys_0_eng_6|video jpeg 0': 90,
        'luid_a_phys_0_eng_2|compute 0': 80,
      }),
    ).toEqual({ threeD: 55, video: 22, copy: 2 });
  });

  it('reads the NVIDIA and Intel names too, and never says more than 100', () => {
    expect(
      foldEngines({
        'luid_b_phys_0_eng_4|VideoDecode': 12,
        'luid_b_phys_0_eng_5|VideoEncode': 40,
        'luid_b_phys_0_eng_0|3D': 140,
      }),
    ).toEqual({ threeD: 100, video: 40, copy: 0 });
  });
});
