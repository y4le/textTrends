import {
  TREND_FIXED_TOKENS_MAX,
  TREND_FIXED_TOKENS_MIN,
  TREND_MAX_ROWS,
  TREND_PER_DOC_MAX,
  TREND_PER_DOC_MIN,
  type TrendBinMode,
  type TrendBinsSpecV1,
} from '@texttrends/core';

export interface TrendBinLimits {
  readonly minimum: number;
  readonly maximum: number;
}

export function estimatedTrendRows(
  tokenCounts: readonly number[],
  bins: TrendBinsSpecV1,
): number {
  if (bins.mode === 'per-doc') {
    return tokenCounts.filter((count) => count > 0).length * bins.count;
  }
  return tokenCounts.reduce(
    (rows, count) => rows + (count > 0 ? Math.ceil(count / bins.count) : 0),
    0,
  );
}

function minimumFixedTokens(tokenCounts: readonly number[]): number | null {
  if (estimatedTrendRows(tokenCounts, {
    mode: 'fixed-tokens',
    count: TREND_FIXED_TOKENS_MAX,
  }) > TREND_MAX_ROWS) return null;
  let low = TREND_FIXED_TOKENS_MIN;
  let high = TREND_FIXED_TOKENS_MAX;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (estimatedTrendRows(tokenCounts, { mode: 'fixed-tokens', count: middle }) <= TREND_MAX_ROWS) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

export function trendBinLimits(
  tokenCounts: readonly number[],
  mode: TrendBinMode,
): TrendBinLimits | null {
  if (mode === 'fixed-tokens') {
    const minimum = minimumFixedTokens(tokenCounts);
    return minimum === null
      ? null
      : { minimum, maximum: TREND_FIXED_TOKENS_MAX };
  }
  const documents = tokenCounts.filter((count) => count > 0).length;
  const maximum = documents === 0
    ? TREND_PER_DOC_MAX
    : Math.min(TREND_PER_DOC_MAX, Math.floor(TREND_MAX_ROWS / documents));
  return maximum < TREND_PER_DOC_MIN
    ? null
    : { minimum: TREND_PER_DOC_MIN, maximum };
}
