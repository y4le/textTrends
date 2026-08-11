import type {
  NumericTrend,
  WorkspaceTrendMeasureV1,
} from '@texttrends/core';
import { formatRate } from './rate-format.ts';

/** Presentation values derived from immutable kernel output. Display choices
 * never re-enter the worker: rate scaling, count display, and smoothing are
 * resident-data transforms over the exact result. */
export function trendDisplayValues(
  trend: NumericTrend,
  measure: WorkspaceTrendMeasureV1,
): Float64Array {
  if (measure.kind === 'count') {
    return Float64Array.from(trend.count);
  }
  const scale = measure.denominator / 10_000;
  const raw = Float64Array.from(trend.ratePer10k, (value) => value * scale);
  return measure.smoothing === 0
    ? raw
    : smoothTrendValues(trend, raw, measure.smoothing);
}

/** Centered, token-weighted rolling mean. Windows shrink at document edges,
 * never cross documents, and require at least ceil(window/2) contributing
 * bins. A zero-denominator center remains an explicit gap. If a short edge or
 * document cannot meet the contributor rule, the exact unsmoothed value is
 * retained rather than inventing a partial estimate. */
export function smoothTrendValues(
  trend: NumericTrend,
  values: ArrayLike<number>,
  window: 3 | 5 | 7 | 9,
): Float64Array {
  if (values.length !== trend.binTokens.length) {
    throw new RangeError('trend values must align with trend rows');
  }
  const output = Float64Array.from(values);
  const radius = Math.floor(window / 2);
  const minimum = Math.ceil(window / 2);
  for (let d = 0; d < trend.order.length; d++) {
    const start = trend.rowOffsets[d] ?? 0;
    const end = trend.rowOffsets[d + 1] ?? start;
    for (let row = start; row < end; row++) {
      if ((trend.binTokens[row] ?? 0) === 0) {
        output[row] = Number.NaN;
        continue;
      }
      const lo = Math.max(start, row - radius);
      const hi = Math.min(end, row + radius + 1);
      let contributors = 0;
      let weighted = 0;
      let tokens = 0;
      for (let candidate = lo; candidate < hi; candidate++) {
        const weight = trend.binTokens[candidate] ?? 0;
        if (weight === 0) continue;
        contributors++;
        tokens += weight;
        weighted += (values[candidate] ?? 0) * weight;
      }
      if (contributors >= minimum && tokens > 0) {
        output[row] = weighted / tokens;
      }
    }
  }
  return output;
}

export function trendRawValues(
  trend: NumericTrend,
  measure: WorkspaceTrendMeasureV1,
): Float64Array {
  if (measure.kind === 'count') return Float64Array.from(trend.count);
  const scale = measure.denominator / 10_000;
  return Float64Array.from(trend.ratePer10k, (value) => value * scale);
}

export function trendMeasureUnit(measure: WorkspaceTrendMeasureV1): string {
  return measure.kind === 'count'
    ? 'count'
    : `/${measure.denominator.toLocaleString()}`;
}

export function formatTrendDisplayValue(
  value: number,
  measure: WorkspaceTrendMeasureV1,
): string {
  if (!Number.isFinite(value)) return 'unavailable';
  return measure.kind === 'count' ? value.toFixed(0) : formatRate(value);
}
