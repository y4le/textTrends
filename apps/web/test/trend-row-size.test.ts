import { describe, expect, it } from 'vitest';
import { footerTrendMinimumHeight } from '../src/lib/footer-metrics.ts';
import { trendGeometryFor } from '../src/lib/trend-compact.ts';
import { byBookRowPitch } from '../src/lib/trend-geometry.ts';
import { trendRowSizing } from '../src/lib/trend-row-size.ts';

describe('trend row sizing', () => {
  it.each([
    { width: 'compact', coarse: false },
    { width: 'compact', coarse: true },
    { width: 'regular', coarse: false },
    { width: 'wide', coarse: true },
  ] as const)('preserves authored $width geometry without an explicit target', ({ width, coarse }) => {
    for (const trackCount of [0, 1, 3, 5]) {
      const sizing = trendRowSizing({ width, coarse, trackCount, targetPitch: null });
      expect(sizing.geometry).toBe(trendGeometryFor(width));
      expect(sizing.rowPitch).toBe(sizing.basePitch);
      expect(sizing.titlesPainted).toBe(true);
    }
  });

  it.each([
    { pitch: 214, rowHeight: 180, rowGap: 22, titlesPainted: true },
    { pitch: 100, rowHeight: 66, rowGap: 22, titlesPainted: true },
    { pitch: 78, rowHeight: 44, rowGap: 22, titlesPainted: true },
    { pitch: 70, rowHeight: 44, rowGap: 14, titlesPainted: true },
    { pitch: 64, rowHeight: 44, rowGap: 8, titlesPainted: true },
    { pitch: 63, rowHeight: 44, rowGap: 7, titlesPainted: false },
    { pitch: 58, rowHeight: 44, rowGap: 2, titlesPainted: false },
    { pitch: 40, rowHeight: 26, rowGap: 2, titlesPainted: false },
    { pitch: 26, rowHeight: 12, rowGap: 2, titlesPainted: false },
  ])('resolves regular one-track pitch $pitch', ({ pitch, rowHeight, rowGap, titlesPainted }) => {
    const sizing = trendRowSizing({
      width: 'regular',
      coarse: false,
      trackCount: 1,
      targetPitch: pitch,
    });
    expect(sizing).toMatchObject({ rowPitch: pitch, titlesPainted });
    expect(sizing.geometry).toMatchObject({ rowHeight, rowGap });
  });

  it('clamps requests without changing the request-owned bounds', () => {
    const below = trendRowSizing({
      width: 'regular', coarse: false, trackCount: 1, targetPitch: -100,
    });
    const above = trendRowSizing({
      width: 'regular', coarse: false, trackCount: 1, targetPitch: 10_000,
    });
    expect(below.rowPitch).toBe(below.minPitch);
    expect(below.atMinimum).toBe(true);
    expect(above.rowPitch).toBe(above.maxPitch);
  });

  it('starts compact coarse at the title threshold and preserves the three-track floor', () => {
    const sizing = trendRowSizing({
      width: 'compact', coarse: true, trackCount: 3, targetPitch: null,
    });
    expect(sizing).toMatchObject({
      basePitch: 60,
      titlePitch: 60,
      plotPitch: 54,
      minPitch: 50,
      maxPitch: 164,
      barcodeExtent: 24,
    });
    const minimum = trendRowSizing({
      width: 'compact', coarse: true, trackCount: 3, targetPitch: 0,
    });
    expect(minimum.atMinimum).toBe(true);
    expect(minimum.geometry.rowHeight).toBe(24);
  });

  it('removes the barcode extent completely when no tracks are present', () => {
    const noTracks = trendRowSizing({
      width: 'regular', coarse: false, trackCount: 0, targetPitch: null,
    });
    const oneTrack = trendRowSizing({
      width: 'regular', coarse: false, trackCount: 1, targetPitch: null,
    });
    expect(noTracks.barcodeExtent).toBe(0);
    expect(oneTrack.barcodeExtent).toBe(12);
    expect(oneTrack.basePitch - noTracks.basePitch).toBe(12);
    expect(oneTrack.minPitch - noTracks.minPitch).toBe(12);
  });

  it.each([
    { trackCount: Number.NaN, barcodeExtent: 0, basePitch: 66 },
    { trackCount: -5, barcodeExtent: 0, basePitch: 66 },
    { trackCount: Number.POSITIVE_INFINITY, barcodeExtent: 0, basePitch: 66 },
    { trackCount: 2.7, barcodeExtent: 21, basePitch: 87 },
  ])('sanitizes hostile track count $trackCount', ({ trackCount, barcodeExtent, basePitch }) => {
    expect(trendRowSizing({
      width: 'regular', coarse: false, trackCount, targetPitch: null,
    })).toMatchObject({ barcodeExtent, basePitch, rowPitch: basePitch });
  });

  it.each([Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY])(
    'treats non-finite pitch %s as automatic',
    (targetPitch) => {
      const sizing = trendRowSizing({
        width: 'regular', coarse: false, trackCount: 1, targetPitch,
      });
      expect(sizing.rowPitch).toBe(sizing.basePitch);
      expect(sizing.geometry).toBe(trendGeometryFor('regular'));
    },
  );

  it('rounds a fractional pitch to the nearest physical pixel', () => {
    const sizing = trendRowSizing({
      width: 'regular', coarse: false, trackCount: 1, targetPitch: 70.6,
    });
    expect(sizing.rowPitch).toBe(71);
    expect(sizing.geometry).toMatchObject({ rowHeight: 44, rowGap: 15 });
  });

  it('keeps barcode and analytical encoding fields invariant through the full range', () => {
    const base = trendGeometryFor('regular');
    const bounds = trendRowSizing({
      width: 'regular', coarse: false, trackCount: 2, targetPitch: null,
    });
    for (let pitch = bounds.minPitch; pitch <= bounds.maxPitch; pitch++) {
      const sizing = trendRowSizing({
        width: 'regular', coarse: false, trackCount: 2, targetPitch: pitch,
      });
      expect(sizing.geometry).toMatchObject({
        seriesHeight: base.seriesHeight,
        topPad: base.topPad,
        barcodeTrackHeight: base.barcodeTrackHeight,
        barcodeTrackGap: base.barcodeTrackGap,
        barcodeBandGap: base.barcodeBandGap,
        strokeWidth: base.strokeWidth,
      });
      expect(byBookRowPitch(
        sizing.geometry.rowHeight,
        sizing.geometry.rowGap,
        sizing.geometry.barcodeBandGap,
        sizing.barcodeExtent === 0
          ? 0
          : sizing.barcodeExtent - sizing.geometry.barcodeBandGap,
      )).toBe(sizing.rowPitch);
      expect(sizing.geometry.rowGap).toBeGreaterThanOrEqual(2);
      expect(sizing.geometry.rowHeight).toBeGreaterThanOrEqual(
        footerTrendMinimumHeight(false),
      );
      if (pitch >= bounds.plotPitch && pitch <= bounds.basePitch) {
        expect(sizing.geometry.rowHeight).toBe(base.rowHeight);
      }
      if (pitch > bounds.basePitch) {
        expect(sizing.geometry.rowGap).toBe(base.rowGap);
        expect(sizing.geometry.rowHeight - base.rowHeight).toBe(pitch - bounds.basePitch);
      }
      expect(Object.isFrozen(sizing.geometry)).toBe(true);
      expect(Object.isFrozen(sizing)).toBe(true);
    }
  });
});
