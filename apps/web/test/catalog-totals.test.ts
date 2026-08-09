import type { NumericTrend } from '@texttrends/core';
import { describe, expect, it } from 'vitest';
import { catalogTotals } from '../src/lib/catalog-totals.ts';
import type { SeriesIntent, SeriesTrendState } from '../src/lib/store.ts';

const term: SeriesIntent = { id: 'term', label: 'wolves', styleSlot: 0 };

function trend(
  order: readonly string[],
  bins: readonly { readonly tokens: readonly number[]; readonly counts: readonly number[] }[],
): NumericTrend {
  const offsets = [0];
  const docOrdinal: number[] = [];
  const binIndex: number[] = [];
  const binStartToken: number[] = [];
  const binTokens: number[] = [];
  const counts: number[] = [];
  const rates: number[] = [];
  const docTokenCount: number[] = [];
  const sequenceBases: number[] = [];
  let base = 0;
  bins.forEach((book, ordinal) => {
    let start = 0;
    sequenceBases.push(base);
    book.tokens.forEach((tokens, index) => {
      const count = book.counts[index] ?? 0;
      docOrdinal.push(ordinal);
      binIndex.push(index);
      binStartToken.push(start);
      binTokens.push(tokens);
      counts.push(count);
      rates.push(tokens === 0 ? 0 : count / tokens * 10_000);
      start += tokens;
    });
    docTokenCount.push(start);
    base += start;
    offsets.push(counts.length);
  });
  return {
    coordinate: 'declared-sequence',
    bins: { mode: 'per-doc', count: 4 },
    rowOffsets: Uint32Array.from(offsets),
    order,
    docOrdinal: Uint32Array.from(docOrdinal),
    binIndex: Uint32Array.from(binIndex),
    binStartToken: Uint32Array.from(binStartToken),
    binTokens: Uint32Array.from(binTokens),
    count: Uint32Array.from(counts),
    ratePer10k: Float64Array.from(rates),
    docTokenCount,
    sequenceBases,
  };
}

const ready = (value: NumericTrend): SeriesTrendState => ({ status: 'ready', trend: value });

describe('catalogTotals', () => {
  it('sums counts and denominators within each book and across the corpus', () => {
    const result = catalogTotals({
      scope: 'full',
      docs: ['a', 'b'],
      series: [term],
      baseline: new Map([['term', ready(trend(
        ['a', 'b'],
        [
          { tokens: [40, 60], counts: [2, 3] },
          { tokens: [200], counts: [10] },
        ],
      ))]]),
      ranged: new Map(),
      fullTokens: new Map([['a', 100], ['b', 200]]),
      rangeTokens: new Map(),
    });

    expect(result.rows[0]?.values.get('term')).toEqual({ status: 'ready', count: 5, rate: 500 });
    expect(result.rows[1]?.values.get('term')).toEqual({ status: 'ready', count: 10, rate: 500 });
    expect(result.corpus).toEqual({
      tokens: 300,
      values: new Map([['term', { status: 'ready', count: 15, rate: 500 }]]),
    });
    expect(result.missingDocs).toEqual([]);
  });

  it('uses only the ranged lane and ranged denominators in range scope', () => {
    const result = catalogTotals({
      scope: 'range',
      docs: ['a', 'b'],
      series: [term],
      baseline: new Map([['term', ready(trend(['a', 'b'], [
        { tokens: [100], counts: [50] },
        { tokens: [200], counts: [100] },
      ]))]]),
      ranged: new Map([['term', ready(trend(['b'], [
        { tokens: [20], counts: [3] },
      ]))]]),
      fullTokens: new Map([['a', 100], ['b', 200]]),
      rangeTokens: new Map([['b', 20]]),
    });

    expect(result.rows.map((row) => row.doc)).toEqual(['b']);
    expect(result.missingDocs).toEqual([]);
    expect(result.rows[0]?.values.get('term')).toEqual({ status: 'ready', count: 3, rate: 1_500 });
    expect(result.corpus.tokens).toBe(20);
  });

  it('never turns pending, failed, or absent results into zeroes', () => {
    for (const [state, status] of [
      [{ status: 'pending' } as const, 'pending'],
      [{ status: 'error', message: 'failed' } as const, 'error'],
      [ready(trend(['other'], [{ tokens: [10], counts: [1] }])), 'unavailable'],
    ] as const) {
      const result = catalogTotals({
        scope: 'full',
        docs: ['a'],
        series: [term],
        baseline: new Map([['term', state]]),
        ranged: new Map(),
        fullTokens: new Map([['a', 10]]),
        rangeTokens: new Map(),
      });
      expect(result.rows[0]?.values.get('term')?.status).toBe(status);
      expect(result.corpus.values.get('term')?.status).toBe(status);
    }
  });

  it('withholds rows and aggregates whose token extents are unavailable', () => {
    const result = catalogTotals({
      scope: 'full',
      docs: ['missing'],
      series: [term],
      baseline: new Map([['term', ready(trend(
        ['missing'],
        [{ tokens: [10], counts: [4] }],
      ))]]),
      ranged: new Map(),
      fullTokens: new Map(),
      rangeTokens: new Map(),
    });

    expect(result.rows).toEqual([]);
    expect(result.missingDocs).toEqual(['missing']);
    expect(result.corpus).toEqual({
      tokens: 0,
      values: new Map([['term', { status: 'unavailable' }]]),
    });
  });
});
