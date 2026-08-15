import { describe, expect, it } from 'vitest';
import {
  COMPARE_MAX_RESIDENT_ROWS,
  compareRowTop,
  compareVirtualLayout,
} from '../src/lib/compare-scroll.ts';

describe('Compare virtual scroll geometry', () => {
  it('uses the measured row pitch instead of assuming the 44px minimum', () => {
    const layout = compareVirtualLayout({
      rowCount: 100,
      rowHeight: 60,
      detailIndex: -1,
      detailHeight: 0,
      bodyViewportTop: 1_200,
      viewportHeight: 300,
      overscan: 0,
    });
    expect(layout).toEqual({
      start: 20,
      end: 26,
      topSpacer: 1_200,
      bottomSpacer: 4_440,
      bodyHeight: 6_000,
    });
  });

  it('keeps the expanded detail band attached above, inside, and below the window', () => {
    expect(compareRowTop(3, 50, 2, 100)).toBe(250);
    expect(compareVirtualLayout({
      rowCount: 10,
      rowHeight: 50,
      detailIndex: 2,
      detailHeight: 100,
      bodyViewportTop: 150,
      viewportHeight: 10,
      overscan: 0,
    })).toEqual({
      start: 2,
      end: 3,
      topSpacer: 100,
      bottomSpacer: 350,
      bodyHeight: 600,
    });
    expect(compareVirtualLayout({
      rowCount: 10,
      rowHeight: 50,
      detailIndex: 2,
      detailHeight: 100,
      bodyViewportTop: 250,
      viewportHeight: 50,
      overscan: 0,
    })).toMatchObject({ start: 3, end: 5, topSpacer: 250, bottomSpacer: 250 });
  });

  it('totally guards empty and invalid geometry and pins a finite resident bound', () => {
    expect(compareVirtualLayout({
      rowCount: Number.NaN,
      rowHeight: 0,
      detailIndex: 0,
      detailHeight: Number.POSITIVE_INFINITY,
      bodyViewportTop: Number.NaN,
      viewportHeight: -1,
      overscan: -1,
    })).toEqual({
      start: 0,
      end: 0,
      topSpacer: 0,
      bottomSpacer: 0,
      bodyHeight: 0,
    });
    expect(COMPARE_MAX_RESIDENT_ROWS).toBe(50_000);
  });
});
