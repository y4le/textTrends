import { describe, expect, it } from 'vitest';
import {
  binSpan,
  bookTokenFromX,
  bookXFromTokenEdge,
  clampRangeHeadToOrigin,
  clampToSpan,
  linearMap,
  pointerTargetByBook,
  pointerTargetSeries,
  selectedTrendPathData,
  seriesDocFromGlobal,
  seriesTokenFromX,
  seriesXFromToken,
  seriesXFromTokenEdge,
  spreadLabels,
  stepAlongSequence,
  type SequenceLayout,
} from '../src/lib/trend-geometry.ts';
import type { NumericTrend } from '@texttrends/core';

const trendWithDenominators = (
  binTokens: readonly number[],
  rates: readonly number[],
): NumericTrend => ({
  coordinate: 'declared-sequence',
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
    expect(selectedTrendPathData(trend, 'doc', 6, (b) => b * 10, (rate) => 100 - rate)).toEqual([
      'M0.0,90.0 l0.01,0',
      'M20.0,80.0 L30.0,70.0',
      'M50.0,60.0 l0.01,0',
    ]);
  });

  it('returns no geometry for a document absent from the result', () => {
    expect(selectedTrendPathData(trendWithDenominators([1], [5]), 'other', 1, (b) => b, (r) => r)).toEqual([]);
  });
});

describe('single-document range clamping', () => {
  const docs = ['a', 'empty', 'b'];
  const counts = [10, 0, 6];

  it('preserves a head inside the origin document', () => {
    expect(clampRangeHeadToOrigin(
      { doc: 'a', token: 3 },
      { doc: 'a', token: 8 },
      docs,
      counts,
    )).toEqual({ doc: 'a', token: 8 });
  });

  it('clamps cross-document motion to the appropriate origin edge', () => {
    expect(clampRangeHeadToOrigin(
      { doc: 'a', token: 3 },
      { doc: 'b', token: 2 },
      docs,
      counts,
    )).toEqual({ doc: 'a', token: 9 });
    expect(clampRangeHeadToOrigin(
      { doc: 'b', token: 3 },
      { doc: 'a', token: 2 },
      docs,
      counts,
    )).toEqual({ doc: 'b', token: 0 });
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

describe('binSpan', () => {
  it('matches the kernel: ceil(tokens/bins) widths, last bin clamped', () => {
    // 5 tokens over 2 bins → width 3: [0,3) and [3,5)
    expect(binSpan(5, 2, 0)).toEqual({ start: 0, end: 3 });
    expect(binSpan(5, 2, 1)).toEqual({ start: 3, end: 5 });
  });

  it('zero-token documents produce empty spans, never negative ones', () => {
    expect(binSpan(0, 40, 0)).toEqual({ start: 0, end: 0 });
    expect(binSpan(0, 40, 39)).toEqual({ start: 0, end: 0 });
  });

  it('bins past the token count clamp to the document end', () => {
    // 3 tokens over 4 bins → width 1; bin 3 starts at the end.
    expect(binSpan(3, 4, 3)).toEqual({ start: 3, end: 3 });
  });
});

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

describe('token-edge geometry (chapter boundary rules)', () => {
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
  it('series: label rail, above-plot, and below-axis coordinates are rejected, never clamped', () => {
    const plotW = 600;
    const plotH = 180;
    expect(pointerTargetSeries(300, 90, plotW, plotH, LAYOUT)).not.toBeNull();
    expect(pointerTargetSeries(600, 90, plotW, plotH, LAYOUT)).toBeNull(); // label rail
    expect(pointerTargetSeries(700, 90, plotW, plotH, LAYOUT)).toBeNull(); // end labels
    expect(pointerTargetSeries(-1, 90, plotW, plotH, LAYOUT)).toBeNull();
    expect(pointerTargetSeries(300, 181, plotW, plotH, LAYOUT)).toBeNull(); // passage line below
    expect(pointerTargetSeries(300, -1, plotW, plotH, LAYOUT)).toBeNull();
  });

  it('by-book: row gaps and the area past the last row are rejected, not snapped', () => {
    const tokenCounts = [100, 50];
    const hit = pointerTargetByBook(300, 20, 600, 44, 22, tokenCounts);
    expect(hit).toEqual({ d: 0, token: 50 });
    expect(pointerTargetByBook(300, 50, 600, 44, 22, tokenCounts)).toBeNull(); // gap after row 0
    expect(pointerTargetByBook(300, 80, 600, 44, 22, tokenCounts)?.d).toBe(1);
    expect(pointerTargetByBook(300, 200, 600, 44, 22, tokenCounts)).toBeNull(); // below last row
    expect(pointerTargetByBook(600, 20, 600, 44, 22, tokenCounts)).toBeNull(); // label rail
  });

  it('by-book: an empty document row rejects instead of producing a position', () => {
    expect(pointerTargetByBook(300, 20, 600, 44, 22, [0, 50])).toBeNull();
  });
});

describe('spreadLabels', () => {
  it('leaves non-colliding labels at their desired positions', () => {
    expect(spreadLabels([10, 40, 80], 0, 100, 12)).toEqual([10, 40, 80]);
  });

  it('spreads colliding labels to the minimum gap, preserving vertical order', () => {
    const out = spreadLabels([50, 52, 51], 0, 100, 12);
    const sorted = [...out].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(12);
    }
    // Relative order of the inputs' ranks is preserved.
    expect(out[0]!).toBeLessThan(out[2]!);
    expect(out[2]!).toBeLessThan(out[1]!);
  });

  it('respects the [min, max] range even when crowded at the bottom', () => {
    const out = spreadLabels([98, 99, 100], 0, 100, 12);
    for (const y of out) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });
});
