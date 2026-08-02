import { describe, expect, it } from 'vitest';
import { estimatedTrendRows, trendBinLimits } from '../src/lib/trend-settings.ts';

describe('trend result-geometry limits', () => {
  it('counts only non-empty documents in per-document mode', () => {
    expect(estimatedTrendRows([100, 0, 250], { mode: 'per-doc', count: 40 })).toBe(80);
    expect(trendBinLimits(Array.from({ length: 25 }, () => 10), 'per-doc'))
      .toEqual({ minimum: 4, maximum: 160 });
  });

  it('finds the smallest fixed-token width within the aggregate row cap', () => {
    const counts = [1_000_000, 1_000_000];
    const limits = trendBinLimits(counts, 'fixed-tokens');
    expect(limits).toEqual({ minimum: 500, maximum: 50_000 });
    expect(estimatedTrendRows(counts, { mode: 'fixed-tokens', count: 499 }))
      .toBeGreaterThan(4_000);
    expect(estimatedTrendRows(counts, { mode: 'fixed-tokens', count: 500 }))
      .toBe(4_000);
  });

  it('reports when no static mode value can satisfy the corpus', () => {
    expect(trendBinLimits(Array.from({ length: 4_001 }, () => 1), 'fixed-tokens')).toBeNull();
    expect(trendBinLimits(Array.from({ length: 1_001 }, () => 1), 'per-doc')).toBeNull();
  });
});
