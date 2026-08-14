import { describe, expect, it } from 'vitest';
import {
  barcodeBandExtent,
  barcodeBandHeight,
  expandedFooterGeometry,
  FOOTER_BARCODE_TRACK_MAX_HEIGHT,
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
      'compact-coarse': [135, 135, 135, 152],
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

  it('shares expansion between barcode rows and graph until barcode rows cap', () => {
    const base = footerGeometryFor('regular');
    const minimum = footerBlockSize(base, 3);
    const shared = expandedFooterGeometry(base, 3, 30);
    expect(shared.barcodeTrackHeight).toBe(base.barcodeTrackHeight + 5);
    expect(shared.seriesHeight).toBe(base.seriesHeight + 15);
    expect(footerBlockSize(shared, 3)).toBe(minimum + 30);

    const capped = expandedFooterGeometry(base, 3, 300);
    expect(capped.barcodeTrackHeight).toBe(FOOTER_BARCODE_TRACK_MAX_HEIGHT);
    expect(capped.seriesHeight).toBe(base.seriesHeight + 270);
    expect(footerBlockSize(capped, 3)).toBe(minimum + 300);

    const graphOnly = expandedFooterGeometry(base, 0, 48);
    expect(graphOnly.barcodeTrackHeight).toBe(base.barcodeTrackHeight);
    expect(graphOnly.seriesHeight).toBe(base.seriesHeight + 48);
    expect(footerBlockSize(graphOnly, 0)).toBe(footerBlockSize(base, 0) + 48);
  });
});
