import { describe, expect, it } from 'vitest';
import {
  barcodeBandExtent,
  barcodeBandHeight,
  dockSizing,
  DOCK_TERM_TARGET_MIN_HEIGHT,
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

  it('treats the authored dock as the default rather than the minimum', () => {
    for (const width of ['compact', 'regular'] as const) {
      for (const coarse of [false, true] as const) {
        const sizing = dockSizing({
          width,
          coarse,
          trackCount: 3,
          footerPresent: true,
          targetBlockSize: null,
          availableBlockSize: 1_000,
        });
        expect(sizing.blockSize).toBe(sizing.baseBlockSize);
        expect(sizing.railBlockSize).toBe(width === 'compact' || coarse ? 50 : 48);
        expect(sizing.footerBlockSize).toBe(footerBlockSize(
          footerGeometryFor(width, coarse),
          3,
        ));
        expect(sizing.minBlockSize).toBeLessThan(sizing.baseBlockSize);
      }
    }
  });

  it('compresses the terms rail first and reaches its floor quickly', () => {
    for (const [width, coarse, railBase] of [
      ['regular', false, 48],
      ['compact', false, 50],
      ['regular', true, 50],
      ['compact', true, 50],
    ] as const) {
      const base = dockSizing({
        width,
        coarse,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: null,
        availableBlockSize: 1_000,
      });
      const firstPixel = dockSizing({
        width,
        coarse,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: base.baseBlockSize - 1,
        availableBlockSize: 1_000,
      });
      expect(firstPixel.railBlockSize).toBe(railBase - 1);
      expect(firstPixel.termTargetBlockSize).toBeLessThan(
        width === 'compact' || coarse ? 36 : 34,
      );
      expect(firstPixel.footerGeometry).toBe(base.footerGeometry);

      const railCapacity = railBase - 31;
      const tight = dockSizing({
        width,
        coarse,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: base.baseBlockSize - railCapacity,
        availableBlockSize: 1_000,
      });
      expect(tight.railBlockSize).toBe(31);
      expect(tight.termTargetBlockSize).toBe(DOCK_TERM_TARGET_MIN_HEIGHT);
      expect(tight.footerBlockSize).toBe(base.footerBlockSize);

      const afterRail = dockSizing({
        width,
        coarse,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: base.baseBlockSize - railCapacity - 1,
        availableBlockSize: 1_000,
      });
      expect(afterRail.railBlockSize).toBe(31);
      expect(afterRail.termTargetBlockSize).toBe(DOCK_TERM_TARGET_MIN_HEIGHT);
      expect(afterRail.footerBlockSize).toBe(base.footerBlockSize - 1);
    }
  });

  it('assigns every requested pixel and keeps the required smallest lanes', () => {
    for (const width of ['compact', 'regular'] as const) {
      for (const coarse of [false, true] as const) {
        for (const trackCount of [0, 1, 3, 5]) {
          const bounds = dockSizing({
            width,
            coarse,
            trackCount,
            footerPresent: true,
            targetBlockSize: null,
            availableBlockSize: 1_000,
          });
          let priorStatus = false;
          let priorBarcode = false;
          for (let target = bounds.minBlockSize; target <= bounds.baseBlockSize + 300; target++) {
            const sizing = dockSizing({
              width,
              coarse,
              trackCount,
              footerPresent: true,
              targetBlockSize: target,
              availableBlockSize: 1_000,
            });
            expect(sizing.blockSize).toBe(target);
            expect(sizing.railBlockSize + sizing.footerBlockSize).toBe(target);
            expect(sizing.termTargetBlockSize).toBeGreaterThanOrEqual(
              DOCK_TERM_TARGET_MIN_HEIGHT,
            );
            expect(sizing.footerGeometry.seriesHeight).toBeGreaterThanOrEqual(
              coarse ? 24 : 12,
            );
            expect(Number(sizing.showStatus)).toBeGreaterThanOrEqual(Number(priorStatus));
            expect(Number(sizing.showBarcode)).toBeGreaterThanOrEqual(Number(priorBarcode));
            priorStatus = sizing.showStatus;
            priorBarcode = sizing.showBarcode;
          }

          const smallest = dockSizing({
            width,
            coarse,
            trackCount,
            footerPresent: true,
            targetBlockSize: bounds.minBlockSize,
            availableBlockSize: 1_000,
          });
          expect(smallest.termTargetBlockSize).toBe(DOCK_TERM_TARGET_MIN_HEIGHT);
          expect(smallest.showStatus).toBe(false);
          expect(smallest.showBarcode).toBe(false);
          expect(smallest.footerGeometry.passageHeight).toBe(
            coarse ? 24 : width === 'compact' ? 18 : 20,
          );
          expect(smallest.footerGeometry.seriesHeight).toBe(coarse ? 24 : 12);
        }
      }
    }
  });

  it('drops the barcode as one lane and never grows it beyond the existing cap', () => {
    const bounds = dockSizing({
      width: 'regular',
      coarse: false,
      trackCount: 3,
      footerPresent: true,
      targetBlockSize: null,
      availableBlockSize: 1_000,
    });
    const visibleTargets = [];
    for (let target = bounds.minBlockSize; target <= bounds.baseBlockSize; target++) {
      const sizing = dockSizing({
        width: 'regular',
        coarse: false,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: target,
        availableBlockSize: 1_000,
      });
      if (sizing.showBarcode) visibleTargets.push(target);
    }
    const firstVisible = visibleTargets[0]!;
    expect(dockSizing({
      width: 'regular', coarse: false, trackCount: 3, footerPresent: true,
      targetBlockSize: firstVisible - 1, availableBlockSize: 1_000,
    }).showBarcode).toBe(false);
    expect(dockSizing({
      width: 'regular', coarse: false, trackCount: 3, footerPresent: true,
      targetBlockSize: firstVisible, availableBlockSize: 1_000,
    }).showBarcode).toBe(true);

    const maximized = dockSizing({
      width: 'regular', coarse: false, trackCount: 3, footerPresent: true,
      targetBlockSize: bounds.baseBlockSize + 500, availableBlockSize: 1_000,
    });
    expect(maximized.footerGeometry.barcodeTrackHeight)
      .toBe(FOOTER_BARCODE_TRACK_MAX_HEIGHT);
  });
});
