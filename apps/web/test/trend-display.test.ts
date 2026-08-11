import { describe, expect, it } from 'vitest';
import type { NumericTrend } from '@texttrends/core';
import {
  formatTrendDisplayValue,
  smoothTrendValues,
  trendDisplayValues,
} from '../src/lib/trend-display.ts';
import {
  trendBinAtToken,
  trendBinSpan,
  trendRowsForDoc,
} from '../src/lib/trend-geometry.ts';

function result(args: {
  readonly rowOffsets: readonly number[];
  readonly starts: readonly number[];
  readonly tokens: readonly number[];
  readonly counts?: readonly number[];
  readonly rates?: readonly number[];
  readonly docTokens: readonly number[];
}): NumericTrend {
  const rows = args.starts.length;
  return {
    coordinate: 'declared-sequence',
    bins: { mode: 'fixed-tokens', count: 250 },
    rowOffsets: Uint32Array.from(args.rowOffsets),
    order: args.docTokens.map((_, index) => `d${index}`),
    docOrdinal: Uint32Array.from(args.docTokens.flatMap((_, d) =>
      Array.from({ length: args.rowOffsets[d + 1]! - args.rowOffsets[d]! }, () => d))),
    binIndex: Uint32Array.from(args.docTokens.flatMap((_, d) =>
      Array.from({ length: args.rowOffsets[d + 1]! - args.rowOffsets[d]! }, (_, b) => b))),
    binStartToken: Uint32Array.from(args.starts),
    binTokens: Uint32Array.from(args.tokens),
    count: Uint32Array.from(args.counts ?? Array.from({ length: rows }, () => 0)),
    ratePer10k: Float64Array.from(args.rates ?? Array.from({ length: rows }, () => 0)),
    docTokenCount: args.docTokens,
    sequenceBases: args.docTokens.map((_, d) =>
      args.docTokens.slice(0, d).reduce((sum, value) => sum + value, 0)),
  };
}

describe('variable trend geometry', () => {
  const trend = result({
    rowOffsets: [0, 2, 5, 5],
    starts: [0, 250, 0, 250, 500],
    tokens: [250, 150, 250, 250, 120],
    docTokens: [400, 620, 0],
  });

  it('uses row offsets and adjacent starts rather than a dense matrix', () => {
    expect(trendRowsForDoc(trend, 0)).toEqual({ start: 0, end: 2, count: 2 });
    expect(trendRowsForDoc(trend, 1)).toEqual({ start: 2, end: 5, count: 3 });
    expect(trendRowsForDoc(trend, 2)).toEqual({ start: 5, end: 5, count: 0 });
    expect(trendBinSpan(trend, 0, 1)).toEqual({ start: 250, end: 400 });
    expect(trendBinSpan(trend, 1, 2)).toEqual({ start: 500, end: 620 });
    expect(trendBinAtToken(trend, 1, 619)).toEqual({
      row: 4,
      span: { start: 500, end: 620 },
    });
    expect(trendBinAtToken(trend, 2, 0)).toBeNull();
  });

  it('clamps trailing per-document rows to an empty span at the document edge', () => {
    const trailing = result({
      rowOffsets: [0, 40],
      starts: Array.from({ length: 40 }, (_, index) => index * 26),
      tokens: [...Array.from({ length: 39 }, () => 26), 0],
      docTokens: [1_001],
    });
    expect(trendBinSpan(trailing, 0, 39)).toEqual({ start: 1_001, end: 1_001 });
  });
});

describe('trend display transforms', () => {
  it('uses canonical per-10k rates and exposes exact counts without worker recomputation', () => {
    const trend = result({
      rowOffsets: [0, 3],
      starts: [0, 1, 2],
      tokens: [1, 1, 1],
      counts: [2, 3, 4],
      rates: [20, 30, 40],
      docTokens: [3],
    });
    expect([...trendDisplayValues(trend, {
      kind: 'rate', denominator: 10_000, smoothing: 0, showRaw: false,
    })]).toEqual([20, 30, 40]);
    expect([...trendDisplayValues(trend, { kind: 'count' })]).toEqual([2, 3, 4]);
  });

  it('formats rate and count values without leaking non-finite input', () => {
    expect(formatTrendDisplayValue(0.05432, {
      kind: 'rate', denominator: 10_000, smoothing: 0, showRaw: false,
    })).toBe('0.0543');
    expect(formatTrendDisplayValue(12.6, { kind: 'count' })).toBe('13');
    expect(formatTrendDisplayValue(Number.NaN, { kind: 'count' })).toBe('unavailable');
  });

  it('is token-weighted, document-fenced, gap-preserving, and contributor-bounded', () => {
    const trend = result({
      rowOffsets: [0, 4, 7],
      starts: [0, 1, 3, 4, 0, 1, 2],
      tokens: [1, 2, 0, 1, 1, 1, 1],
      rates: [0, 10, 999, 40, 100, 200, 300],
      docTokens: [4, 3],
    });
    const smoothed = smoothTrendValues(trend, trend.ratePer10k, 3);
    expect(smoothed[0]).toBeCloseTo(20 / 3);
    expect(smoothed[1]).toBeCloseTo(20 / 3);
    expect(Number.isNaN(smoothed[2])).toBe(true);
    // One contributor beside the gap is below ceil(3/2): retain raw.
    expect(smoothed[3]).toBe(40);
    // The second document never borrows the previous book's value.
    expect(smoothed[4]).toBe(150);
    expect(smoothed[5]).toBe(200);
    expect(smoothed[6]).toBe(250);
    // A five-bin window needs three contributors; the short first edge stays raw.
    expect(smoothTrendValues(trend, trend.ratePer10k, 5)[0]).toBe(0);
  });
});
