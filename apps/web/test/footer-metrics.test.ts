import { describe, expect, it } from 'vitest';
import {
  barcodeBandExtent,
  barcodeBandHeight,
  dockSizing,
  dockTermTargetMinimumHeight,
  DOCK_TERM_TARGET_MIN_HEIGHT,
  expandedFooterGeometry,
  FOOTER_BARCODE_TRACK_MAX_HEIGHT,
  FOOTER_DEFAULT_MAX_VIEWPORT_RATIO,
  footerBlockSize,
  footerGeometryFor,
  footerTrendMinimumHeight,
  readerDockSizing,
} from '../src/lib/footer-metrics.ts';
import {
  footerBlockSize as footerViewBlockSize,
  footerGeometryFor as footerViewGeometryFor,
} from '../src/lib/footer-view.ts';
import { DENSITY_METRICS } from '../src/lib/display-preference.ts';
import {
  barcodeBandExtent as trendBarcodeBandExtent,
  barcodeBandHeight as trendBarcodeBandHeight,
} from '../src/lib/trend-geometry.ts';

describe('eager footer metrics', () => {
  it('starts Compact and Standard squeezed while Comfortable keeps authored chrome', () => {
    const compact = dockSizing({
      width: 'compact',
      coarse: true,
      density: 'compact',
      trackCount: 3,
      footerPresent: true,
      targetBlockSize: null,
      viewportBlockSize: 844,
      availableBlockSize: 700,
    });
    const standard = dockSizing({
      width: 'compact',
      coarse: true,
      density: 'standard',
      trackCount: 3,
      footerPresent: true,
      targetBlockSize: null,
      viewportBlockSize: 844,
      availableBlockSize: 700,
    });
    const comfortable = dockSizing({
      width: 'compact',
      coarse: true,
      density: 'comfortable',
      trackCount: 3,
      footerPresent: true,
      targetBlockSize: null,
      viewportBlockSize: 844,
      availableBlockSize: 700,
    });
    expect([compact.railBlockSize, standard.railBlockSize, comfortable.railBlockSize])
      .toEqual([27, 37, 58]);
    expect([compact.termTargetBlockSize, standard.termTargetBlockSize, comfortable.termTargetBlockSize])
      .toEqual([DOCK_TERM_TARGET_MIN_HEIGHT, 34, 44]);
    expect([compact.footerGeometry.passageHeight, standard.footerGeometry.passageHeight])
      .toEqual([24, 24]);
    expect([compact.footerGeometry.padBlock, standard.footerGeometry.padBlock])
      .toEqual([1, 1]);
    expect([compact.footerGeometry.laneGap, standard.footerGeometry.laneGap])
      .toEqual([1, 1]);
    expect(compact.footerGeometry.seriesHeight).toBe(footerTrendMinimumHeight(true));
    expect(compact.footerGeometry.stripMinHeight).toBe(0);
    expect(compact.footerGeometry.barcodeTrackHeight)
      .toBe(standard.footerGeometry.barcodeTrackHeight);
    expect(compact.showStatus).toBe(true);
    expect(compact.showBarcode).toBe(true);
    expect(compact.blockSize).toBeLessThan(standard.blockSize);
    expect(standard.blockSize).toBeLessThan(comfortable.blockSize);
    expect(comfortable.footerGeometry.seriesHeight)
      .toBe(standard.footerGeometry.seriesHeight);
    expect(comfortable.footerGeometry.barcodeTrackHeight)
      .toBe(standard.footerGeometry.barcodeTrackHeight);
    expect(comfortable.footerGeometry.passageHeight)
      .toBeGreaterThan(standard.footerGeometry.passageHeight);

    const reader = readerDockSizing({
      width: 'compact',
      coarse: true,
      density: 'comfortable',
      trackCount: 3,
      footerPresent: true,
      targetBlockSize: null,
      viewportBlockSize: 844,
      availableBlockSize: 700,
    });
    expect(reader.termTargetBlockSize).toBe(32);
    expect(reader.railBlockSize).toBe(35);
  });

  it('keeps squeezed automatic, explicit, legacy, and Reader sizing boundaries separate', () => {
    for (const [width, coarse] of [
      ['compact', false],
      ['compact', true],
      ['regular', false],
      ['regular', true],
    ] as const) {
      const automatic = (density: 'compact' | 'standard' | 'comfortable') => dockSizing({
        width,
        coarse,
        density,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: null,
        viewportBlockSize: 1_000,
        availableBlockSize: 800,
      });
      const compact = automatic('compact');
      const standard = automatic('standard');
      const comfortable = automatic('comfortable');
      expect(compact.footerGeometry.seriesHeight)
        .toBe(footerTrendMinimumHeight(coarse));
      expect(compact.showStatus).toBe(true);
      expect(compact.showBarcode).toBe(true);
      expect(compact.blockSize).toBeLessThan(standard.blockSize);
      expect(standard.blockSize).toBeLessThan(comfortable.blockSize);
      expect(compact.minBlockSize).toBeLessThan(standard.minBlockSize);
      expect(standard.minBlockSize).toBeLessThan(comfortable.minBlockSize);
      expect(new Set([
        compact.maxBlockSize,
        standard.maxBlockSize,
        comfortable.maxBlockSize,
      ])).toHaveLength(1);
      for (const density of ['compact', 'standard', 'comfortable'] as const) {
        const sizing = automatic(density);
        const metrics = DENSITY_METRICS[density].dock;
        expect(sizing.railBlockSize)
          .toBe(sizing.blockSize - sizing.footerBlockSize);
        if (density === 'comfortable') {
          expect(sizing.termTargetBlockSize).toBe(width === 'compact' || coarse
            ? metrics.compactTermTargetBlockSize
            : metrics.termTargetBlockSize);
        } else {
          const targetFloor = dockTermTargetMinimumHeight(density);
          expect(sizing.railBlockSize).toBe(targetFloor + 3);
          expect(sizing.termTargetBlockSize).toBe(targetFloor);
          expect(sizing.footerGeometry.passageHeight).toBe(coarse
            ? 24
            : width === 'compact' ? 18 : 20);
          expect(sizing.showStatus).toBe(true);
          expect(sizing.showBarcode).toBe(true);
        }
      }

      const explicitTarget = compact.minBlockSize + 80;
      const explicitSizes = (['compact', 'standard', 'comfortable'] as const)
        .map((density) => dockSizing({
          width,
          coarse,
          density,
          trackCount: 3,
          footerPresent: true,
          targetBlockSize: explicitTarget,
          viewportBlockSize: 1_000,
          availableBlockSize: 800,
        }).blockSize);
      expect(explicitSizes).toEqual([explicitTarget, explicitTarget, explicitTarget]);

      const readerCompact = readerDockSizing({
        width,
        coarse,
        density: 'compact',
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: null,
        viewportBlockSize: 1_000,
        availableBlockSize: 800,
      });
      const readerStandard = readerDockSizing({
        width,
        coarse,
        density: 'standard',
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: null,
        viewportBlockSize: 1_000,
        availableBlockSize: 800,
      });
      expect(readerCompact.footerGeometry).toEqual(readerStandard.footerGeometry);
    }

    expect(footerGeometryFor('compact', true).seriesHeight)
      .toBeGreaterThan(footerTrendMinimumHeight(true));
  });

  it('keeps book and token status at the squeezed viewport floor', () => {
    for (const density of ['compact', 'standard'] as const) {
      for (const trackCount of [0, 1, 3, 5]) {
        const sizing = dockSizing({
          width: 'compact',
          coarse: true,
          density,
          trackCount,
          footerPresent: true,
          targetBlockSize: null,
          viewportBlockSize: 320,
          availableBlockSize: 276,
        });
        const targetFloor = dockTermTargetMinimumHeight(density);
        expect(sizing.railBlockSize).toBe(targetFloor + 3);
        expect(sizing.termTargetBlockSize).toBe(targetFloor);
        expect(sizing.footerGeometry.passageHeight).toBe(24);
        expect(sizing.showStatus).toBe(true);
        expect(sizing.showBarcode).toBe(trackCount > 0);
      }
    }
  });

  it('drops Reader Terms as a complete lane before barcode at every density', () => {
    for (const density of ['compact', 'standard', 'comfortable'] as const) {
      const base = readerDockSizing({
        width: 'compact',
        coarse: true,
        density,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: null,
        viewportBlockSize: 844,
        availableBlockSize: 700,
      });
      const withoutTerms = readerDockSizing({
        width: 'compact',
        coarse: true,
        density,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: base.blockSize - 32,
        viewportBlockSize: 844,
        availableBlockSize: 700,
      });
      expect(withoutTerms.railBlockSize).toBe(0);
      expect(withoutTerms.showBarcode).toBe(true);

      const graphOnly = Array.from(
        { length: withoutTerms.blockSize - withoutTerms.minBlockSize },
        (_, index) => withoutTerms.blockSize - index - 1,
      ).map((targetBlockSize) => readerDockSizing({
        width: 'compact',
        coarse: true,
        density,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize,
        viewportBlockSize: 844,
        availableBlockSize: 700,
      })).find((sizing) =>
        !sizing.showBarcode && sizing.footerGeometry.seriesHeight > 2);
      expect(graphOnly).toBeDefined();
    }
  });

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
          viewportBlockSize: 1_000,
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

  it('caps only the automatic footer default at one third of a short viewport', () => {
    const viewportBlockSize = 320;
    const automatic = dockSizing({
      width: 'compact',
      coarse: true,
      trackCount: 3,
      footerPresent: true,
      targetBlockSize: null,
      viewportBlockSize,
      availableBlockSize: 276,
    });
    const footerCap = Math.floor(
      viewportBlockSize * FOOTER_DEFAULT_MAX_VIEWPORT_RATIO,
    );
    expect(automatic.footerBlockSize).toBe(footerCap);
    expect(automatic.blockSize).toBeLessThan(automatic.baseBlockSize);
    expect(automatic.railBlockSize).toBe(50);
    expect(automatic.termTargetBlockSize).toBe(36);

    const firstGrowth = dockSizing({
      width: 'compact',
      coarse: true,
      trackCount: 3,
      footerPresent: true,
      targetBlockSize: automatic.blockSize + 1,
      viewportBlockSize,
      availableBlockSize: 276,
    });
    expect(firstGrowth.blockSize).toBe(automatic.blockSize + 1);
    expect(firstGrowth.railBlockSize).toBe(automatic.railBlockSize);
    expect(firstGrowth.footerBlockSize).toBe(automatic.footerBlockSize + 1);
    expect(firstGrowth.termTargetBlockSize).toBe(automatic.termTargetBlockSize);

    const expanded = dockSizing({
      width: 'compact',
      coarse: true,
      trackCount: 3,
      footerPresent: true,
      targetBlockSize: automatic.baseBlockSize,
      viewportBlockSize,
      availableBlockSize: 276,
    });
    expect(expanded.blockSize).toBe(expanded.baseBlockSize);
    expect(expanded.footerBlockSize).toBeGreaterThan(footerCap);
  });

  it('engages the automatic cap continuously without collapsing the terms rail', () => {
    const justCapped = dockSizing({
      width: 'compact',
      coarse: true,
      trackCount: 3,
      footerPresent: true,
      targetBlockSize: null,
      viewportBlockSize: 404,
      availableBlockSize: 360,
    });
    const justUncapped = dockSizing({
      width: 'compact',
      coarse: true,
      trackCount: 3,
      footerPresent: true,
      targetBlockSize: null,
      viewportBlockSize: 405,
      availableBlockSize: 360,
    });

    expect(justCapped.blockSize).toBe(justUncapped.blockSize - 1);
    expect(justCapped.footerBlockSize).toBe(justUncapped.footerBlockSize - 1);
    expect(justCapped.railBlockSize).toBe(50);
    expect(justCapped.termTargetBlockSize).toBe(36);
  });

  it('keeps authored defaults when the viewport gives the footer enough room', () => {
    const sizing = dockSizing({
      width: 'compact',
      coarse: true,
      trackCount: 3,
      footerPresent: true,
      targetBlockSize: null,
      viewportBlockSize: 844,
      availableBlockSize: 700,
    });
    expect(sizing.blockSize).toBe(sizing.baseBlockSize);
  });

  it('disables the automatic cap for unavailable viewport measurements', () => {
    for (const viewportBlockSize of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const sizing = dockSizing({
        width: 'compact',
        coarse: true,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: null,
        viewportBlockSize,
        availableBlockSize: 700,
      });
      expect(sizing.blockSize).toBe(sizing.baseBlockSize);
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
        viewportBlockSize: 1_000,
        availableBlockSize: 1_000,
      });
      const firstPixel = dockSizing({
        width,
        coarse,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: base.baseBlockSize - 1,
        viewportBlockSize: 1_000,
        availableBlockSize: 1_000,
      });
      expect(firstPixel.railBlockSize).toBe(railBase - 1);
      expect(firstPixel.termTargetBlockSize).toBeLessThan(
        width === 'compact' || coarse ? 36 : 34,
      );
      expect(firstPixel.footerGeometry).toBe(base.footerGeometry);

      const railCapacity = railBase - 27;
      const tight = dockSizing({
        width,
        coarse,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: base.baseBlockSize - railCapacity,
        viewportBlockSize: 1_000,
        availableBlockSize: 1_000,
      });
      expect(tight.railBlockSize).toBe(27);
      expect(tight.termTargetBlockSize).toBe(DOCK_TERM_TARGET_MIN_HEIGHT);
      expect(tight.footerBlockSize).toBe(base.footerBlockSize);

      const afterRail = dockSizing({
        width,
        coarse,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: base.baseBlockSize - railCapacity - 1,
        viewportBlockSize: 1_000,
        availableBlockSize: 1_000,
      });
      expect(afterRail.railBlockSize).toBe(27);
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
            viewportBlockSize: 1_000,
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
              viewportBlockSize: 1_000,
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
            viewportBlockSize: 1_000,
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
      viewportBlockSize: 1_000,
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
        viewportBlockSize: 1_000,
        availableBlockSize: 1_000,
      });
      if (sizing.showBarcode) visibleTargets.push(target);
    }
    const firstVisible = visibleTargets[0]!;
    expect(dockSizing({
      width: 'regular', coarse: false, trackCount: 3, footerPresent: true,
      targetBlockSize: firstVisible - 1, viewportBlockSize: 1_000, availableBlockSize: 1_000,
    }).showBarcode).toBe(false);
    expect(dockSizing({
      width: 'regular', coarse: false, trackCount: 3, footerPresent: true,
      targetBlockSize: firstVisible, viewportBlockSize: 1_000, availableBlockSize: 1_000,
    }).showBarcode).toBe(true);

    const maximized = dockSizing({
      width: 'regular', coarse: false, trackCount: 3, footerPresent: true,
      targetBlockSize: bounds.baseBlockSize + 500, viewportBlockSize: 1_000,
      availableBlockSize: 1_000,
    });
    expect(maximized.footerGeometry.barcodeTrackHeight)
      .toBe(FOOTER_BARCODE_TRACK_MAX_HEIGHT);
  });

  it('collapses Reader through Terms, barcode, and graph to its progress line', () => {
    for (const [width, coarse] of [
      ['compact', false],
      ['compact', true],
      ['regular', false],
      ['regular', true],
    ] as const) {
      const defaultSizing = readerDockSizing({
        width,
        coarse,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: null,
        viewportBlockSize: 844,
        availableBlockSize: 700,
      });
      expect(defaultSizing.blockSize).toBe(defaultSizing.baseBlockSize);
      expect(defaultSizing.blockSize).toBeGreaterThan(defaultSizing.minBlockSize);
      expect(defaultSizing.railBlockSize).toBe(27);
      expect(defaultSizing.termTargetBlockSize).toBe(DOCK_TERM_TARGET_MIN_HEIGHT);
      expect(defaultSizing.footerGeometry.passageHeight).toBe(0);
      expect(defaultSizing.showStatus).toBe(false);
      expect(defaultSizing.showBarcode).toBe(true);
      expect(defaultSizing.railBlockSize + defaultSizing.footerBlockSize)
        .toBe(defaultSizing.blockSize);

      const expanded = readerDockSizing({
        width,
        coarse,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: defaultSizing.blockSize + 48,
        viewportBlockSize: 844,
        availableBlockSize: 700,
      });
      expect(expanded.blockSize).toBe(defaultSizing.blockSize + 48);
      expect(expanded.railBlockSize).toBe(defaultSizing.railBlockSize);
      expect(expanded.footerBlockSize).toBe(defaultSizing.footerBlockSize + 48);
      expect(expanded.showBarcode).toBe(true);

      const noTerms = readerDockSizing({
        width,
        coarse,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: defaultSizing.footerBlockSize,
        viewportBlockSize: 844,
        availableBlockSize: 700,
      });
      expect(noTerms.railBlockSize).toBe(0);
      expect(noTerms.showBarcode).toBe(true);
      expect(noTerms.footerGeometry.seriesHeight).toBe(coarse ? 24 : 12);

      const graphOnly = readerDockSizing({
        width,
        coarse,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: 1 + (coarse ? 24 : 12),
        viewportBlockSize: 844,
        availableBlockSize: 700,
      });
      expect(graphOnly.railBlockSize).toBe(0);
      expect(graphOnly.showBarcode).toBe(false);
      expect(graphOnly.footerGeometry.seriesHeight).toBe(coarse ? 24 : 12);

      const progressOnly = readerDockSizing({
        width,
        coarse,
        trackCount: 3,
        footerPresent: true,
        targetBlockSize: 3,
        viewportBlockSize: 844,
        availableBlockSize: 700,
      });
      expect(progressOnly.blockSize).toBe(progressOnly.minBlockSize);
      expect(progressOnly.railBlockSize).toBe(0);
      expect(progressOnly.footerBlockSize).toBe(3);
      expect(progressOnly.showBarcode).toBe(false);
      expect(progressOnly.footerGeometry.seriesHeight).toBe(2);
    }

    const coarseFind = readerDockSizing({
      width: 'compact',
      coarse: true,
      trackCount: 1,
      readerRail: 'find',
      footerPresent: true,
      targetBlockSize: null,
      viewportBlockSize: 844,
      availableBlockSize: 700,
    });
    expect(coarseFind.railBlockSize).toBe(45);
    expect(coarseFind.termTargetBlockSize).toBe(44);
    expect(coarseFind.railBlockSize + coarseFind.footerBlockSize)
      .toBe(coarseFind.blockSize);
  });
});
