import {
  TREND_RATE_DENOMINATOR,
  rateContrast,
} from '@texttrends/core';
import type { SeriesIntent, SeriesTrendState } from './store.ts';
import { termBookTotals } from './term-book-totals.ts';

export interface TrendRangeSide {
  readonly count: number;
  readonly tokens: number;
  readonly rate: number;
}

export type TrendRangeDirection =
  | {
      readonly kind: 'contrast';
      readonly contrast: number;
      readonly expectedMin: number;
      readonly evidenced: boolean;
    }
  | {
      readonly kind: 'undefined';
      readonly reason:
        | 'whole-corpus'
        | 'empty-range'
        | 'no-occurrences'
        | 'snapshot-mismatch';
    };

export type TrendRangeRow =
  | {
      readonly status: 'ready';
      readonly series: SeriesIntent;
      readonly inside: TrendRangeSide;
      readonly outside: TrendRangeSide;
      readonly direction: TrendRangeDirection;
    }
  | { readonly status: 'pending'; readonly series: SeriesIntent }
  | { readonly status: 'error'; readonly series: SeriesIntent; readonly message: string };

export interface TrendRangeCompareVM {
  readonly rows: readonly TrendRangeRow[];
}

function side(count: number, tokens: number): TrendRangeSide {
  return {
    count,
    tokens,
    rate: tokens === 0 ? 0 : (count / tokens) * TREND_RATE_DENOMINATOR,
  };
}

function joinedTotals(
  whole: SeriesTrendState & { status: 'ready' },
  ranged: SeriesTrendState & { status: 'ready' },
): {
  readonly insideCount: number;
  readonly insideTokens: number;
  readonly outsideCount: number;
  readonly outsideTokens: number;
} | null {
  const rangedByDoc = new Map<string, NonNullable<ReturnType<typeof termBookTotals>>>();
  for (const doc of ranged.trend.order) {
    if (rangedByDoc.has(doc)) return null;
    const selected = termBookTotals(ranged.trend, doc);
    if (selected === null) return null;
    rangedByDoc.set(doc, selected);
  }
  const seen = new Set<string>();
  let insideCount = 0;
  let insideTokens = 0;
  let outsideCount = 0;
  let outsideTokens = 0;
  for (const doc of whole.trend.order) {
    if (seen.has(doc)) return null;
    seen.add(doc);
    const full = termBookTotals(whole.trend, doc);
    if (full === null) return null;
    const selected = rangedByDoc.get(doc);
    if (selected === undefined) {
      outsideCount += full.count;
      outsideTokens += full.tokens;
      continue;
    }
    if (
      full.extent !== selected.extent
      || selected.count > full.count
      || selected.tokens > full.tokens
    ) return null;
    insideCount += selected.count;
    insideTokens += selected.tokens;
    outsideCount += full.count - selected.count;
    outsideTokens += full.tokens - selected.tokens;
    rangedByDoc.delete(doc);
  }
  if (rangedByDoc.size > 0) return null;
  return { insideCount, insideTokens, outsideCount, outsideTokens };
}

function readyRow(
  series: SeriesIntent,
  whole: SeriesTrendState & { status: 'ready' },
  ranged: SeriesTrendState & { status: 'ready' },
): TrendRangeRow {
  const joined = joinedTotals(whole, ranged);
  const inside = side(joined?.insideCount ?? 0, joined?.insideTokens ?? 0);
  const outside = side(joined?.outsideCount ?? 0, joined?.outsideTokens ?? 0);
  let direction: TrendRangeDirection;
  if (joined === null) {
    direction = { kind: 'undefined', reason: 'snapshot-mismatch' };
  } else if (outside.tokens <= 0) {
    direction = { kind: 'undefined', reason: 'whole-corpus' };
  } else if (inside.tokens <= 0) {
    direction = { kind: 'undefined', reason: 'empty-range' };
  } else if (inside.count + outside.count === 0) {
    direction = { kind: 'undefined', reason: 'no-occurrences' };
  } else {
    const contrast = rateContrast(
      inside.count,
      inside.tokens,
      outside.count,
      outside.tokens,
    );
    if (contrast === null) {
      direction = { kind: 'undefined', reason: 'no-occurrences' };
      return { status: 'ready', series, inside, outside, direction };
    }
    const pooledRate = (inside.count + outside.count) / (inside.tokens + outside.tokens);
    const expectedMin = pooledRate * Math.min(inside.tokens, outside.tokens);
    direction = {
      kind: 'contrast',
      contrast,
      expectedMin,
      evidenced: expectedMin >= 5,
    };
  }
  return { status: 'ready', series, inside, outside, direction };
}

/** Build the selected-range/rest comparison from resident trend lanes only. */
export function trendRangeCompare(input: {
  readonly series: readonly SeriesIntent[];
  readonly baseline: ReadonlyMap<string, SeriesTrendState>;
  readonly ranged: ReadonlyMap<string, SeriesTrendState>;
}): TrendRangeCompareVM {
  const rows = input.series.map((series): TrendRangeRow => {
    const whole = input.baseline.get(series.id);
    const ranged = input.ranged.get(series.id);
    const error = whole?.status === 'error'
      ? whole.message
      : ranged?.status === 'error' ? ranged.message : null;
    if (error !== null) return { status: 'error', series, message: error };
    if (whole?.status !== 'ready' || ranged?.status !== 'ready') {
      return { status: 'pending', series };
    }
    return readyRow(series, whole, ranged);
  });
  return { rows };
}

export function selectedTrendsPending(
  series: readonly SeriesIntent[],
  ranged: ReadonlyMap<string, SeriesTrendState>,
): boolean {
  return series.some((item) => ranged.get(item.id)?.status !== 'ready'
    && ranged.get(item.id)?.status !== 'error');
}
