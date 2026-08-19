import type { NumericTrend } from '@texttrends/core';
import { trendRowsForDoc } from './trend-geometry.ts';

export interface TermBookTotals {
  readonly count: number;
  /** The kernel-owned selected-token denominator for this result lane. */
  readonly tokens: number;
  /** Full document extent, retained even when this is a ranged trend. */
  readonly extent: number;
  readonly rowStart: number;
  readonly rowEnd: number;
}

/**
 * Sum one document's resident trend rows after joining by document id.
 *
 * Ranged trends contain only the documents touched by the range, so callers
 * must never assume their row offsets are index-parallel with the baseline.
 */
export function termBookTotals(
  trend: NumericTrend,
  doc: string,
): TermBookTotals | null {
  const ordinal = trend.order.indexOf(doc);
  if (ordinal < 0) return null;
  const rows = trendRowsForDoc(trend, ordinal);
  let count = 0;
  let tokens = 0;
  for (let row = rows.start; row < rows.end; row++) {
    count += trend.count[row] as number;
    tokens += trend.binTokens[row] as number;
  }
  return {
    count,
    tokens,
    extent: trend.docTokenCount[ordinal] ?? 0,
    rowStart: rows.start,
    rowEnd: rows.end,
  };
}
