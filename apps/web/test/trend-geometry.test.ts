import { describe, expect, it } from 'vitest';
import { binSpan, clampToSpan, spreadLabels } from '../src/lib/trend-geometry.ts';

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
