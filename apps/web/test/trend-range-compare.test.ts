import type { NumericTrend } from '@texttrends/core';
import { describe, expect, it } from 'vitest';
import type { SeriesIntent, SeriesTrendState } from '../src/lib/store.ts';
import {
  selectedTrendsPending,
  trendRangeCompare,
} from '../src/lib/trend-range-compare.ts';

const term: SeriesIntent = {
  id: 'term',
  label: 'wolves',
  style: { color: 'blue', line: 'solid' },
};

function trend(
  documents: readonly {
    readonly doc: string;
    readonly tokens: readonly number[];
    readonly counts: readonly number[];
    readonly extent?: number;
  }[],
): NumericTrend {
  const offsets = [0];
  const docOrdinal: number[] = [];
  const binIndex: number[] = [];
  const starts: number[] = [];
  const tokens: number[] = [];
  const counts: number[] = [];
  const extents: number[] = [];
  const bases: number[] = [];
  let base = 0;
  documents.forEach((document, ordinal) => {
    let start = 0;
    bases.push(base);
    document.tokens.forEach((size, index) => {
      docOrdinal.push(ordinal);
      binIndex.push(index);
      starts.push(start);
      tokens.push(size);
      counts.push(document.counts[index] ?? 0);
      start += size;
    });
    const extent = document.extent ?? start;
    extents.push(extent);
    base += extent;
    offsets.push(counts.length);
  });
  return {
    coordinate: 'declared-sequence',
    bins: { mode: 'per-doc', count: 4 },
    rowOffsets: Uint32Array.from(offsets),
    order: documents.map((document) => document.doc),
    docOrdinal: Uint32Array.from(docOrdinal),
    binIndex: Uint32Array.from(binIndex),
    binStartToken: Uint32Array.from(starts),
    binTokens: Uint32Array.from(tokens),
    count: Uint32Array.from(counts),
    ratePer10k: Float64Array.from(counts, (count, index) =>
      tokens[index] === 0 ? 0 : count / (tokens[index] as number) * 10_000),
    docTokenCount: extents,
    sequenceBases: bases,
  };
}

const ready = (value: NumericTrend): SeriesTrendState => ({ status: 'ready', trend: value });
const compare = (baseline: NumericTrend, ranged: NumericTrend) => trendRangeCompare({
  series: [term],
  baseline: new Map([['term', ready(baseline)]]),
  ranged: new Map([['term', ready(ranged)]]),
});

describe('trendRangeCompare', () => {
  it('joins a selected subset by document id before deriving the rest', () => {
    const vm = compare(
      trend([
        { doc: 'first', tokens: [100], counts: [1] },
        { doc: 'second', tokens: [200], counts: [5] },
        { doc: 'third', tokens: [300], counts: [4] },
      ]),
      trend([
        { doc: 'second', tokens: [50], counts: [3], extent: 200 },
      ]),
    );
    expect(vm.rows[0]).toMatchObject({
      status: 'ready',
      inside: { count: 3, tokens: 50, rate: 600 },
      outside: { count: 7, tokens: 550 },
    });
  });

  it('uses a fixed bounded contrast whose sign follows the printed rates', () => {
    const vm = compare(
      trend([
        { doc: 'inside-doc', tokens: [1_000], counts: [10] },
        { doc: 'outside-doc', tokens: [2_000], counts: [2] },
      ]),
      trend([
        { doc: 'inside-doc', tokens: [1_000], counts: [10], extent: 1_000 },
      ]),
    );
    const row = vm.rows[0];
    expect(row?.status).toBe('ready');
    if (row?.status !== 'ready' || row.direction.kind !== 'contrast') return;
    expect(row.direction.contrast).toBeCloseTo((100 - 10) / (100 + 10), 12);
    expect(row.direction.expectedMin).toBeCloseTo(4, 12);
    expect(row.direction.evidenced).toBe(false);
    expect('maximum' in vm).toBe(false);
  });

  it.each([
    {
      name: 'whole corpus',
      baseline: trend([{ doc: 'a', tokens: [100], counts: [2] }]),
      ranged: trend([{ doc: 'a', tokens: [100], counts: [2], extent: 100 }]),
      reason: 'whole-corpus',
    },
    {
      name: 'no occurrences',
      baseline: trend([
        { doc: 'a', tokens: [100], counts: [0] },
        { doc: 'b', tokens: [100], counts: [0] },
      ]),
      ranged: trend([{ doc: 'a', tokens: [50], counts: [0], extent: 100 }]),
      reason: 'no-occurrences',
    },
    {
      name: 'empty range',
      baseline: trend([{ doc: 'a', tokens: [100], counts: [2] }]),
      ranged: trend([{ doc: 'a', tokens: [], counts: [], extent: 100 }]),
      reason: 'empty-range',
    },
    {
      name: 'snapshot mismatch',
      baseline: trend([
        { doc: 'a', tokens: [100], counts: [2] },
        { doc: 'b', tokens: [100], counts: [2] },
      ]),
      ranged: trend([{ doc: 'a', tokens: [50], counts: [1], extent: 99 }]),
      reason: 'snapshot-mismatch',
    },
  ])('returns an explicit refusal for $name', ({ baseline, ranged, reason }) => {
    const row = compare(baseline, ranged).rows[0];
    expect(row?.status).toBe('ready');
    if (row?.status !== 'ready') return;
    expect(row.direction).toEqual({ kind: 'undefined', reason });
  });

  it('points a zero-hit short range toward the observed rest rate', () => {
    const row = compare(
      trend([
        { doc: 'range', tokens: [21], counts: [0] },
        { doc: 'rest', tokens: [1_923], counts: [8] },
      ]),
      trend([{ doc: 'range', tokens: [21], counts: [0], extent: 21 }]),
    ).rows[0];
    expect(row?.status).toBe('ready');
    if (row?.status !== 'ready') return;
    expect(row.inside.rate).toBe(0);
    expect(row.outside.rate).toBeCloseTo(41.6, 1);
    expect(row.direction).toMatchObject({
      kind: 'contrast',
      contrast: -1,
      evidenced: false,
    });
  });

  it('uses mark weight to distinguish thin and supported one-sided absence', () => {
    const thin = compare(
      trend([
        { doc: 'range', tokens: [21], counts: [0] },
        { doc: 'rest', tokens: [1_923], counts: [8] },
      ]),
      trend([{ doc: 'range', tokens: [21], counts: [0], extent: 21 }]),
    ).rows[0];
    const supported = compare(
      trend([
        { doc: 'range', tokens: [5_000], counts: [0] },
        { doc: 'rest', tokens: [100_000], counts: [416] },
      ]),
      trend([{ doc: 'range', tokens: [5_000], counts: [0], extent: 5_000 }]),
    ).rows[0];
    expect(thin?.status === 'ready' ? thin.direction : null)
      .toMatchObject({ kind: 'contrast', contrast: -1, evidenced: false });
    expect(supported?.status === 'ready' ? supported.direction : null)
      .toMatchObject({ kind: 'contrast', contrast: -1, evidenced: true });
  });

  it('keeps overlap-counted groups comparable when occurrences exceed tokens', () => {
    const row = compare(
      trend([
        { doc: 'a', tokens: [10], counts: [8] },
        { doc: 'b', tokens: [10], counts: [1] },
      ]),
      trend([{ doc: 'a', tokens: [2], counts: [5], extent: 10 }]),
    ).rows[0];
    expect(row?.status).toBe('ready');
    if (row?.status !== 'ready' || row.direction.kind !== 'contrast') return;
    expect(row.direction.contrast).toBeGreaterThan(0);
  });

  it('preserves pending and per-term errors without throwing', () => {
    const pending = trendRangeCompare({
      series: [term],
      baseline: new Map([['term', ready(trend([{ doc: 'a', tokens: [10], counts: [1] }]))]]),
      ranged: new Map([['term', { status: 'pending' }]]),
    });
    const failed = trendRangeCompare({
      series: [term],
      baseline: new Map([['term', ready(trend([{ doc: 'a', tokens: [10], counts: [1] }]))]]),
      ranged: new Map([['term', { status: 'error', message: 'failed' }]]),
    });
    expect(pending.rows[0]?.status).toBe('pending');
    expect(failed.rows[0]).toMatchObject({ status: 'error', message: 'failed' });
    expect(selectedTrendsPending([term], pending.rows[0]?.status === 'pending'
      ? new Map([['term', { status: 'pending' }]])
      : new Map())).toBe(true);
    expect(selectedTrendsPending(
      [term],
      new Map([['term', { status: 'error', message: 'failed' }]]),
    )).toBe(false);
  });
});
