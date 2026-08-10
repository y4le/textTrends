import { describe, expect, it } from 'vitest';
import {
  barcodeBandExtent,
  barcodeBandHeight,
  footerBlockSize,
  footerGeometryFor,
} from '../src/lib/footer-metrics.ts';
import {
  footerBlockSize as footerViewBlockSize,
  footerGeometryFor as footerViewGeometryFor,
} from '../src/lib/footer-view.ts';
import {
  barcodeBandExtent as trendBarcodeBandExtent,
  barcodeBandHeight as trendBarcodeBandHeight,
} from '../src/lib/trend-geometry.ts';

describe('eager footer metrics', () => {
  it('preserves every width, pointer, and track-count reservation', () => {
    const expected = {
      'compact-fine': [69, 78, 90, 102],
      'regular-fine': [85, 96, 112, 128],
      'compact-coarse': [117, 117, 117, 126],
      'regular-coarse': [125, 125, 134, 150],
    } as const;
    const trackCounts = [0, 1, 3, 5] as const;

    for (const width of ['compact', 'regular'] as const) {
      for (const coarse of [false, true] as const) {
        const key = `${width}-${coarse ? 'coarse' : 'fine'}` as keyof typeof expected;
        const geometry = footerGeometryFor(width, coarse);
        expect(trackCounts.map((count) => footerBlockSize(geometry, count)))
          .toEqual(expected[key]);
      }
    }
  });

  it('is the single authority re-exported by the existing view modules', () => {
    expect(footerViewBlockSize).toBe(footerBlockSize);
    expect(footerViewGeometryFor).toBe(footerGeometryFor);
    expect(trendBarcodeBandHeight).toBe(barcodeBandHeight);
    expect(trendBarcodeBandExtent).toBe(barcodeBandExtent);
  });
});
