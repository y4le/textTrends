import { describe, expect, it } from 'vitest';
import { footerTrendMinimumHeight } from '../src/lib/footer-metrics.ts';
import { trendGeometryFor } from '../src/lib/trend-compact.ts';
import { byBookRowPitch } from '../src/lib/trend-geometry.ts';
import {
  TREND_BARCODE_BAND_GAP_MIN,
  TREND_BARCODE_INTERACTIVE_STRIDE,
  TREND_BARCODE_TRACK_GAP_MIN,
  TREND_BARCODE_TRACK_MIN_COARSE,
  TREND_BARCODE_TRACK_MIN_FINE,
  TREND_ROW_SEPARATOR,
  trendRowSizing,
} from '../src/lib/trend-row-size.ts';

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
      expect(sizing).toMatchObject({
        rowPitch: sizing.basePitch,
        phase: 'grow',
        titlesPainted: true,
        barcodeVisible: trackCount > 0,
      });
    }
  });

  it.each([
    { width: 'regular', coarse: false, tracks: 0, stops: [66, 52, 52, 46, 14, 14] },
    { width: 'regular', coarse: false, tracks: 1, stops: [78, 64, 61, 55, 18, 14] },
    { width: 'regular', coarse: false, tracks: 2, stops: [87, 73, 69, 63, 21, 14] },
    { width: 'regular', coarse: false, tracks: 3, stops: [96, 82, 77, 71, 24, 14] },
    { width: 'regular', coarse: false, tracks: 5, stops: [114, 100, 93, 87, 30, 14] },
    { width: 'wide', coarse: true, tracks: 1, stops: [78, 64, 61, 55, 31, 26] },
    { width: 'wide', coarse: true, tracks: 3, stops: [96, 82, 77, 71, 39, 26] },
    { width: 'compact', coarse: false, tracks: 1, stops: [46, 46, 43, 37, 18, 14] },
    { width: 'compact', coarse: false, tracks: 3, stops: [60, 60, 55, 49, 24, 14] },
    { width: 'compact', coarse: true, tracks: 1, stops: [46, 46, 43, 37, 31, 26] },
    { width: 'compact', coarse: true, tracks: 3, stops: [60, 60, 55, 49, 39, 26] },
  ] as const)(
    'derives the $width/$coarse/$tracks stop table',
    ({ width, coarse, tracks, stops }) => {
      const sizing = trendRowSizing({ width, coarse, trackCount: tracks, targetPitch: null });
      expect([
        sizing.basePitch,
        sizing.titlePitch,
        sizing.tightPitch,
        sizing.plotPitch,
        sizing.inkPitch,
        sizing.minPitch,
      ]).toEqual(stops);
    },
  );

  it.each([
    { pitch: 214, phase: 'grow', rowHeight: 180, rowGap: 22, titles: true, barcode: true },
    { pitch: 100, phase: 'grow', rowHeight: 66, rowGap: 22, titles: true, barcode: true },
    { pitch: 78, phase: 'grow', rowHeight: 44, rowGap: 22, titles: true, barcode: true },
    { pitch: 70, phase: 'lane', rowHeight: 44, rowGap: 14, titles: true, barcode: true },
    { pitch: 64, phase: 'lane', rowHeight: 44, rowGap: 8, titles: true, barcode: true },
    { pitch: 63, phase: 'band-space', rowHeight: 44, rowGap: 8, titles: true, barcode: true },
    { pitch: 61, phase: 'band-space', rowHeight: 44, rowGap: 8, titles: true, barcode: true },
    { pitch: 60, phase: 'hide', rowHeight: 44, rowGap: 7, titles: false, barcode: true },
    { pitch: 55, phase: 'hide', rowHeight: 44, rowGap: 2, titles: false, barcode: true },
    { pitch: 40, phase: 'ink', rowHeight: 31, rowGap: 2, titles: false, barcode: true },
    { pitch: 26, phase: 'ink', rowHeight: 19, rowGap: 2, titles: false, barcode: true },
    { pitch: 18, phase: 'ink', rowHeight: 12, rowGap: 2, titles: false, barcode: true },
    { pitch: 17, phase: 'drop', rowHeight: 12, rowGap: 2, titles: false, barcode: false },
    { pitch: 14, phase: 'drop', rowHeight: 12, rowGap: 2, titles: false, barcode: false },
  ] as const)(
    'resolves regular one-track pitch $pitch through $phase',
    ({ pitch, phase, rowHeight, rowGap, titles, barcode }) => {
      const sizing = trendRowSizing({
        width: 'regular', coarse: false, trackCount: 1, targetPitch: pitch,
      });
      expect(sizing).toMatchObject({
        rowPitch: phase === 'drop' ? 14 : pitch,
        phase,
        titlesPainted: titles,
        barcodeVisible: barcode,
      });
      expect(sizing.geometry).toMatchObject({ rowHeight, rowGap });
      expect(sizing.barcodeExtent > 0).toBe(barcode);
    },
  );

  it('tightens barcode whitespace before hiding titles', () => {
    const sizing = trendRowSizing({
      width: 'regular', coarse: false, trackCount: 1, targetPitch: 63,
    });
    expect(sizing.geometry.barcodeTrackHeight).toBe(7);
    expect(sizing.geometry.barcodeTrackGap).toBeCloseTo(5 / 3);
    expect(sizing.geometry.barcodeBandGap).toBeCloseTo(7 / 3);
    expect(sizing.titlesPainted).toBe(true);
    expect(sizing.geometry.rowHeight).toBe(44);
  });

  it('reaches a distinct miniature barcode before dropping the whole band', () => {
    const mini = trendRowSizing({
      width: 'regular', coarse: false, trackCount: 3, targetPitch: 24,
    });
    expect(mini).toMatchObject({
      phase: 'ink',
      barcodeVisible: true,
      barcodeInteractive: false,
      barcodeExtent: 10,
    });
    expect(mini.geometry).toMatchObject({
      rowHeight: 12,
      rowGap: 2,
      barcodeTrackHeight: TREND_BARCODE_TRACK_MIN_FINE,
      barcodeTrackGap: TREND_BARCODE_TRACK_GAP_MIN,
      barcodeBandGap: TREND_BARCODE_BAND_GAP_MIN,
    });

    const dropped = trendRowSizing({
      width: 'regular', coarse: false, trackCount: 3, targetPitch: 23,
    });
    expect(dropped).toMatchObject({
      rowPitch: 14,
      phase: 'drop',
      barcodeVisible: false,
      barcodeInteractive: false,
      barcodeExtent: 0,
    });

    const middle = trendRowSizing({
      width: 'regular', coarse: false, trackCount: 1, targetPitch: 40,
    });
    expect(middle.geometry).toMatchObject({ rowHeight: 31, barcodeTrackHeight: 5 });
  });

  it('clamps ordinary requests to a track-independent absolute floor', () => {
    for (const width of ['compact', 'regular', 'wide'] as const) {
      for (const coarse of [false, true]) {
        for (const trackCount of [0, 1, 3, 5]) {
          const sizing = trendRowSizing({
            width, coarse, trackCount, targetPitch: -100,
          });
          expect(sizing.minPitch).toBe(
            footerTrendMinimumHeight(coarse) + TREND_ROW_SEPARATOR,
          );
          expect(sizing.rowPitch).toBe(sizing.minPitch);
          expect(sizing.atMinimum).toBe(true);
        }
      }
    }
  });

  it('clamps upper requests to the authored maximum', () => {
    const sizing = trendRowSizing({
      width: 'regular', coarse: false, trackCount: 1, targetPitch: 10_000,
    });
    expect(sizing).toMatchObject({ rowPitch: 214, maxPitch: 214, phase: 'grow' });
  });

  it('pins Find to the miniature barcode stop', () => {
    const sizing = trendRowSizing({
      width: 'compact', coarse: true, trackCount: 3, targetPitch: 0,
      barcodeRequired: true,
    });
    expect(sizing).toMatchObject({
      inkPitch: 39,
      minPitch: 39,
      rowPitch: 39,
      barcodeVisible: true,
      atMinimum: true,
    });
    expect(sizing.geometry.barcodeTrackHeight).toBe(TREND_BARCODE_TRACK_MIN_COARSE);

    const noTracks = trendRowSizing({
      width: 'compact', coarse: true, trackCount: 0, targetPitch: 0,
      barcodeRequired: true,
    });
    expect(noTracks).toMatchObject({ minPitch: 26, rowPitch: 26, barcodeVisible: false });
  });

  it('pins the barcode interaction threshold to an authored and exact-boundary case', () => {
    expect(trendRowSizing({
      width: 'regular', coarse: false, trackCount: 1, targetPitch: null,
    }).barcodeInteractive).toBe(true);
    const compactTight = trendRowSizing({
      width: 'compact', coarse: false, trackCount: 1, targetPitch: 43,
    });
    expect(compactTight.geometry.barcodeTrackHeight + compactTight.geometry.barcodeTrackGap)
      .toBe(TREND_BARCODE_INTERACTIVE_STRIDE);
    expect(compactTight.barcodeInteractive).toBe(true);
    expect(trendRowSizing({
      width: 'compact', coarse: false, trackCount: 1, targetPitch: 33,
    }).barcodeInteractive).toBe(false);
  });

  it('removes all barcode cost at the floor but retains authored defaults', () => {
    const noTracks = trendRowSizing({
      width: 'regular', coarse: false, trackCount: 0, targetPitch: null,
    });
    const oneTrack = trendRowSizing({
      width: 'regular', coarse: false, trackCount: 1, targetPitch: null,
    });
    expect(noTracks.barcodeExtent).toBe(0);
    expect(oneTrack.barcodeExtent).toBe(12);
    expect(oneTrack.basePitch - noTracks.basePitch).toBe(12);
    expect(oneTrack.minPitch).toBe(noTracks.minPitch);
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

  it('preserves exact pitch and ordered compression invariants through the full range', () => {
    for (const width of ['compact', 'regular', 'wide'] as const) {
      for (const coarse of [false, true]) {
        for (const trackCount of [0, 1, 2, 3, 5]) {
          const base = trendGeometryFor(width);
          const bounds = trendRowSizing({
            width, coarse, trackCount, targetPitch: null,
          });
          let priorBarcodeExtent = -1;
          let priorRowHeight = -1;
          let titleFlips = 0;
          let barcodeFlips = 0;
          let priorTitles = false;
          let priorBarcode = false;
          for (let pitch = bounds.minPitch; pitch <= bounds.maxPitch; pitch++) {
            const sizing = trendRowSizing({
              width, coarse, trackCount, targetPitch: pitch,
            });
            const barcodeHeight = sizing.barcodeExtent === 0
              ? 0
              : sizing.barcodeExtent - sizing.geometry.barcodeBandGap;
            expect(byBookRowPitch(
              sizing.geometry.rowHeight,
              sizing.geometry.rowGap,
              sizing.geometry.barcodeBandGap,
              barcodeHeight,
            )).toBeCloseTo(sizing.rowPitch, 10);
            expect(sizing.geometry.rowGap).toBeGreaterThanOrEqual(TREND_ROW_SEPARATOR);
            expect(sizing.geometry.rowHeight).toBeGreaterThanOrEqual(
              footerTrendMinimumHeight(coarse),
            );
            expect(sizing.barcodeExtent).toBeGreaterThanOrEqual(priorBarcodeExtent);
            expect(sizing.geometry.rowHeight).toBeGreaterThanOrEqual(priorRowHeight);
            priorBarcodeExtent = sizing.barcodeExtent;
            priorRowHeight = sizing.geometry.rowHeight;
            expect(sizing.geometry).toMatchObject({
              seriesHeight: base.seriesHeight,
              topPad: base.topPad,
              strokeWidth: base.strokeWidth,
            });
            if (sizing.phase === 'ink') {
              expect(sizing.geometry).toMatchObject({
                rowGap: TREND_ROW_SEPARATOR,
                barcodeBandGap: trackCount > 0
                  ? TREND_BARCODE_BAND_GAP_MIN
                  : base.barcodeBandGap,
                barcodeTrackGap: trackCount > 0
                  ? TREND_BARCODE_TRACK_GAP_MIN
                  : base.barcodeTrackGap,
              });
            }
            if (sizing.phase === 'drop') {
              expect(sizing.barcodeExtent).toBe(0);
              expect(sizing.geometry.rowGap).toBe(TREND_ROW_SEPARATOR);
            }
            if (pitch >= bounds.plotPitch && pitch <= bounds.basePitch) {
              expect(sizing.geometry.rowHeight).toBe(base.rowHeight);
            }
            expect(sizing.barcodeInteractive).toBe(
              sizing.barcodeVisible
                && sizing.geometry.barcodeTrackHeight
                  + sizing.geometry.barcodeTrackGap >= TREND_BARCODE_INTERACTIVE_STRIDE,
            );
            if (sizing.titlesPainted !== priorTitles) titleFlips++;
            if (sizing.barcodeVisible !== priorBarcode) barcodeFlips++;
            priorTitles = sizing.titlesPainted;
            priorBarcode = sizing.barcodeVisible;
            expect(Object.isFrozen(sizing.geometry)).toBe(true);
            expect(Object.isFrozen(sizing)).toBe(true);
          }
          expect(titleFlips).toBe(1);
          expect(barcodeFlips).toBe(trackCount > 0 ? 1 : 0);
        }
      }
    }
  });

  it('snaps the barcode collapse without growing the plot or exposing gap pitches', () => {
    for (const width of ['compact', 'regular', 'wide'] as const) {
      for (const coarse of [false, true]) {
        for (const trackCount of [1, 3, 5, 12]) {
          const bounds = trendRowSizing({
            width, coarse, trackCount, targetPitch: null,
          });
          const mini = trendRowSizing({
            width, coarse, trackCount, targetPitch: bounds.inkPitch,
          });
          const dropped = trendRowSizing({
            width, coarse, trackCount, targetPitch: bounds.inkPitch - 1,
          });
          expect(dropped.rowPitch).toBe(bounds.minPitch);
          expect(dropped.geometry.rowHeight).toBe(mini.geometry.rowHeight);
          expect(dropped.barcodeVisible).toBe(false);
          expect(mini.barcodeVisible).toBe(true);
          expect(bounds.inkPitch - bounds.minPitch).toBe(mini.barcodeExtent);
          expect(trendRowSizing({
            width,
            coarse,
            trackCount,
            targetPitch: dropped.rowPitch,
          }).rowPitch).toBe(dropped.rowPitch);
          const regularFloor = trendRowSizing({
            width: 'regular', coarse, trackCount, targetPitch: null,
          });
          expect(bounds.inkPitch).toBe(regularFloor.inkPitch);
          expect(bounds.minPitch).toBe(regularFloor.minPitch);
        }
      }
    }
  });
});
