import { describe, expect, it } from 'vitest';
import {
  bookTokenFromX,
  bookXFromTokenEdge,
  barcodeBandHeight,
  barcodeBandExtent,
  byBookRowPitch,
  clampToSpan,
  linearMap,
  selectedTrendPathData,
  seriesDocFromGlobal,
  seriesTokenFromX,
  seriesXFromToken,
  seriesXFromTokenEdge,
  stepAlongSequence,
  trendStageHit,
  type SequenceLayout,
} from '../src/lib/trend-geometry.ts';
import type { NumericTrend } from '@texttrends/core';

const trendWithDenominators = (
  binTokens: readonly number[],
  rates: readonly number[],
): NumericTrend => ({
  coordinate: 'declared-sequence',
  bins: { mode: 'per-doc', count: Math.max(4, binTokens.length) },
  rowOffsets: Uint32Array.from([0, binTokens.length]),
  order: ['doc'],
  docOrdinal: Uint32Array.from(binTokens.map(() => 0)),
  binIndex: Uint32Array.from(binTokens.map((_, i) => i)),
  binStartToken: Uint32Array.from(binTokens.map((_, i) => i)),
  binTokens: Uint32Array.from(binTokens),
  count: Uint32Array.from(binTokens.map(() => 0)),
  ratePer10k: Float64Array.from(rates),
  docTokenCount: [binTokens.reduce((sum, n) => sum + n, 0)],
  sequenceBases: [0],
});

describe('selected trend paths', () => {
  it('breaks at zero-denominator bins instead of drawing a fabricated zero', () => {
    const trend = trendWithDenominators([2, 0, 3, 4, 0, 5], [10, 999, 20, 30, 999, 40]);
    expect(selectedTrendPathData(trend, 'doc', trend.ratePer10k, (b) => b * 10, (rate) => 100 - rate)).toEqual([
      'M0.0,90.0 l0.01,0',
      'M20.0,80.0 L30.0,70.0',
      'M50.0,60.0 l0.01,0',
    ]);
  });

  it('returns no geometry for a document absent from the result', () => {
    const trend = trendWithDenominators([1], [5]);
    expect(selectedTrendPathData(trend, 'other', trend.ratePer10k, (b) => b, (r) => r)).toEqual([]);
  });

  it('extends each observed run to its bin edges when span geometry is supplied', () => {
    const trend = trendWithDenominators([2, 3, 0, 4], [10, 20, 999, 30]);
    expect(selectedTrendPathData(
      trend,
      'doc',
      trend.ratePer10k,
      (bin) => [1, 3.5, 7, 9][bin]!,
      (rate) => 100 - rate,
      (bin) => [
        { start: 0, end: 2 },
        { start: 2, end: 5 },
        { start: 5, end: 9 },
        { start: 9, end: 13 },
      ][bin]!,
    )).toEqual([
      'M0.0,90.0 L1.0,90.0 L3.5,80.0 L5.0,80.0',
      'M9.0,70.0 L13.0,70.0',
    ]);
  });
});

describe('linearMap', () => {
  it('maps a normal domain linearly, without clamping', () => {
    const x = linearMap(0, 10, 0, 100);
    expect(x(0)).toBe(0);
    expect(x(5)).toBe(50);
    expect(x(10)).toBe(100);
    expect(x(12)).toBe(120); // extrapolates, matching d3-scale's default
  });

  it('maps a reversed range (screen-y style)', () => {
    const y = linearMap(0, 4, 200, 0);
    expect(y(0)).toBe(200);
    expect(y(1)).toBe(150);
    expect(y(4)).toBe(0);
  });

  it('degenerate domain returns the range midpoint for every input (d3 semantics)', () => {
    const y = linearMap(0, 0, 200, 40);
    expect(y(0)).toBe(120);
    expect(y(123)).toBe(120);
    expect(y(-5)).toBe(120);
  });
});

/** Three books: 100 tokens, an EMPTY one, then 50 — bases skip the empty. */
const LAYOUT: SequenceLayout = {
  bases: [0, 100, 100],
  tokenCounts: [100, 0, 50],
  totalTokens: 150,
};

describe('clampToSpan', () => {
  it('applies boundary gaps on spans wide enough to contain them', () => {
    expect(clampToSpan(10, 10, 100, 2, 2)).toBe(12); // pushed off the leading rule
    expect(clampToSpan(100, 10, 100, 2, 2)).toBe(98); // pushed off the trailing rule
    expect(clampToSpan(50, 10, 100, 2, 2)).toBe(50); // interior points untouched
  });

  it('a sub-gap span collapses to its midpoint instead of inverting', () => {
    // Span of 3px with 2px gaps on both sides: bounds would cross (12 > 11).
    expect(clampToSpan(10.5, 10, 13, 2, 2)).toBe(11.5);
    // The result must stay INSIDE the book's own span — never in a neighbor.
    expect(clampToSpan(0, 10, 13, 2, 2)).toBeGreaterThanOrEqual(10);
    expect(clampToSpan(999, 10, 13, 2, 2)).toBeLessThanOrEqual(13);
  });

  it('a zero-width span (empty document) pins to its position', () => {
    expect(clampToSpan(7, 10, 10, 2, 2)).toBe(10);
    expect(clampToSpan(7, 10, 10, 0, 2)).toBe(10);
  });
});

describe('sequence scrub mapping', () => {
  it('resolves globals to (doc, token), skipping empty docs; boundary owned by the next non-empty', () => {
    expect(seriesDocFromGlobal(0, LAYOUT)).toEqual({ d: 0, token: 0 });
    expect(seriesDocFromGlobal(99, LAYOUT)).toEqual({ d: 0, token: 99 });
    expect(seriesDocFromGlobal(100, LAYOUT)).toEqual({ d: 2, token: 0 }); // never d=1 (empty)
    expect(seriesDocFromGlobal(149, LAYOUT)).toEqual({ d: 2, token: 49 });
  });

  it('clamps beyond the corpus ends instead of returning nothing', () => {
    expect(seriesDocFromGlobal(-5, LAYOUT)).toEqual({ d: 0, token: 0 });
    expect(seriesDocFromGlobal(9999, LAYOUT)).toEqual({ d: 2, token: 49 });
  });

  it('x mapping round-trips through token centers', () => {
    const plotW = 600;
    for (const g of [0, 42, 99, 100, 149]) {
      const hit = seriesDocFromGlobal(g, LAYOUT)!;
      const x = seriesXFromToken(hit.d, hit.token, plotW, LAYOUT);
      expect(seriesTokenFromX(x, plotW, LAYOUT)).toEqual(hit);
    }
  });

  it('bookTokenFromX clamps to the row and rejects empty docs', () => {
    expect(bookTokenFromX(0, 600, 50)).toBe(0);
    expect(bookTokenFromX(599.9, 600, 50)).toBe(49);
    expect(bookTokenFromX(300, 600, 0)).toBeNull();
  });

  it('stepping crosses book boundaries and skips the empty book', () => {
    expect(stepAlongSequence(0, 99, 1, LAYOUT)).toEqual({ d: 2, token: 0 });
    expect(stepAlongSequence(2, 0, -1, LAYOUT)).toEqual({ d: 0, token: 99 });
    expect(stepAlongSequence(0, 0, -1, LAYOUT)).toEqual({ d: 0, token: 0 }); // clamped
    expect(stepAlongSequence(2, 49, 5, LAYOUT)).toEqual({ d: 2, token: 49 }); // clamped
  });
});

describe('token-edge geometry (range boundary rules)', () => {
  it('series edge lands on the token START, not its center', () => {
    // Second book starts at base 100; a boundary at local token 10 is global
    // 110 → 110/150 of the width. The scrubber (center) would add +0.5.
    expect(seriesXFromTokenEdge(2, 10, 300, LAYOUT)).toBeCloseTo((110 / 150) * 300);
    expect(seriesXFromToken(2, 10, 300, LAYOUT)).toBeCloseTo((110.5 / 150) * 300);
  });
  it('series edge is 0 for an empty corpus', () => {
    expect(seriesXFromTokenEdge(0, 5, 300, { bases: [0], tokenCounts: [0], totalTokens: 0 })).toBe(0);
  });
  it('by-book edge is the token fraction of the row width', () => {
    expect(bookXFromTokenEdge(25, 400, 100)).toBeCloseTo(100);
    expect(bookXFromTokenEdge(0, 400, 100)).toBe(0);
  });
  it('by-book edge is 0 for an empty row', () => {
    expect(bookXFromTokenEdge(5, 400, 0)).toBe(0);
  });
});

describe('pointer plot containment', () => {
  it('series: right-edge, above-plot, and below-axis coordinates are rejected, never clamped', () => {
    const plotW = 600;
    const plotH = 180;
    const stage = {
      view: 'series' as const,
      plotWidth: plotW,
      plotHeight: plotH,
      barcodeBandGap: 0,
      barcodeHeight: 0,
      band: { trackCount: 0, trackHeight: 7, trackGap: 2 },
      layout: LAYOUT,
    };
    expect(trendStageHit(300, 90, stage, 'locate')).not.toBeNull();
    expect(trendStageHit(600, 90, stage, 'locate')).toBeNull(); // exclusive right edge
    expect(trendStageHit(700, 90, stage, 'locate')).toBeNull(); // beyond the plot
    expect(trendStageHit(-1, 90, stage, 'locate')).toBeNull();
    expect(trendStageHit(300, 181, stage, 'locate')).toBeNull(); // passage line below
    expect(trendStageHit(300, -1, stage, 'locate')).toBeNull();
  });

  it('by-book: title bands and the area past the last row are rejected, not snapped', () => {
    const tokenCounts = [100, 50];
    const stage = {
      view: 'by-book' as const,
      plotWidth: 600,
      rowHeight: 44,
      rowGap: 22,
      barcodeBandGap: 0,
      barcodeHeight: 0,
      band: { trackCount: 0, trackHeight: 7, trackGap: 2 },
      tokenCounts,
      rowDomain: tokenCounts,
    };
    const hit = trendStageHit(300, 20, stage, 'locate');
    expect(hit).toMatchObject({ d: 0, token: 50, zone: 'plot' });
    expect(trendStageHit(300, 50, stage, 'locate')).toBeNull(); // title below row 0
    expect(trendStageHit(300, 80, stage, 'locate')?.d).toBe(1);
    expect(trendStageHit(300, 200, stage, 'locate')).toBeNull(); // below last row
    expect(trendStageHit(600, 20, stage, 'locate')).toBeNull(); // exclusive right edge
  });

  it('by-book: an empty document row rejects instead of producing a position', () => {
    expect(trendStageHit(300, 20, {
      view: 'by-book',
      plotWidth: 600,
      rowHeight: 44,
      rowGap: 22,
      barcodeBandGap: 0,
      barcodeHeight: 0,
      band: { trackCount: 0, trackHeight: 7, trackGap: 2 },
      tokenCounts: [0, 50],
      rowDomain: [0, 50],
    }, 'locate')).toBeNull();
  });

  it('to-scale rows reject locating in blank tails but clamp an extending range head', () => {
    const stage = {
      view: 'by-book' as const,
      plotWidth: 600,
      rowHeight: 44,
      rowGap: 22,
      barcodeBandGap: 0,
      barcodeHeight: 0,
      band: { trackCount: 0, trackHeight: 7, trackGap: 2 },
      tokenCounts: [100, 50, 0],
      rowDomain: [100, 100, 100],
    };
    expect(trendStageHit(450, 80, stage, 'locate')).toBeNull();
    expect(trendStageHit(450, 80, stage, 'extend')).toMatchObject({
      d: 1,
      token: 49,
      zone: 'plot',
    });
    expect(trendStageHit(150, 80, stage, 'locate')).toMatchObject({ d: 1, token: 25 });
    expect(trendStageHit(100, 140, stage, 'locate')).toBeNull();
    expect(trendStageHit(100, 140, stage, 'extend')).toBeNull();
  });
});

describe('integrated barcode stage geometry', () => {
  it('classifies the series plot, axis gap, barcode rows, and label area independently', () => {
    const bandHeight = barcodeBandHeight(2, 7, 2);
    const stage = {
      view: 'series' as const,
      plotWidth: 600,
      plotHeight: 180,
      barcodeBandGap: 3,
      barcodeHeight: bandHeight,
      band: { trackCount: 2, trackHeight: 7, trackGap: 2 },
      layout: LAYOUT,
    };
    const hit = (y: number, x = 300) => trendStageHit(x, y, stage, 'locate');
    expect(hit(90)?.zone).toBe('plot');
    expect(hit(181)).toBeNull();
    expect(hit(184)).toMatchObject({ zone: 'barcode', trackRow: 0 });
    expect(hit(193)).toMatchObject({ zone: 'barcode', trackRow: 1 });
    expect(hit(202)).toBeNull();
    expect(hit(90, 600)).toBeNull();
    expect(hit(184, 700)).toBeNull();
  });

  it('uses one centralized by-book pitch and never crosses rows through title bands', () => {
    const bandHeight = barcodeBandHeight(2, 7, 2);
    const pitch = byBookRowPitch(44, 22, 3, bandHeight);
    expect(pitch).toBe(87);
    expect(barcodeBandExtent(3, 0)).toBe(0);
    expect(byBookRowPitch(44, 22, 3, 0)).toBe(66);
    const stage = {
      view: 'by-book' as const,
      plotWidth: 600,
      rowHeight: 44,
      rowGap: 22,
      barcodeBandGap: 3,
      barcodeHeight: bandHeight,
      band: { trackCount: 2, trackHeight: 7, trackGap: 2 },
      tokenCounts: [100, 50],
      rowDomain: [100, 50],
    };
    const hit = (y: number) => trendStageHit(300, y, stage, 'locate');
    expect(hit(20)).toMatchObject({ d: 0, token: 50, zone: 'plot' });
    expect(hit(45)).toBeNull();
    expect(hit(48)).toMatchObject({ d: 0, zone: 'barcode', trackRow: 0 });
    expect(hit(57)).toMatchObject({ d: 0, zone: 'barcode', trackRow: 1 });
    expect(hit(70)).toBeNull(); // title below row 0
    expect(hit(pitch + 20)).toMatchObject({ d: 1, token: 25, zone: 'plot' });
    expect(hit(pitch + 48)).toMatchObject({ d: 1, zone: 'barcode', trackRow: 0 });
  });
});
