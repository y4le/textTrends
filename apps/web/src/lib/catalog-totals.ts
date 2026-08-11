import { TREND_RATE_DENOMINATOR, type NumericTrend } from '@texttrends/core';
import { trendRowsForDoc } from './trend-geometry.ts';
import type { SeriesIntent, SeriesTrendState } from './store.ts';

export type CatalogTotalsScope = 'full' | 'range';

export type CatalogTotalValue =
  | { readonly status: 'ready'; readonly count: number; readonly rate: number }
  | { readonly status: 'pending' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'unavailable' };

export interface CatalogTotalRow {
  readonly doc: string;
  readonly tokens: number;
  readonly values: ReadonlyMap<string, CatalogTotalValue>;
}

export interface CatalogTotalsVM {
  readonly scope: CatalogTotalsScope;
  readonly series: readonly SeriesIntent[];
  readonly rows: readonly CatalogTotalRow[];
  readonly missingDocs: readonly string[];
  readonly corpus: {
    readonly tokens: number;
    readonly values: ReadonlyMap<string, CatalogTotalValue>;
  };
}

function countForDocument(trend: NumericTrend, doc: string): number | null {
  const ordinal = trend.order.indexOf(doc);
  if (ordinal < 0) return null;
  const rows = trendRowsForDoc(trend, ordinal);
  let count = 0;
  for (let row = rows.start; row < rows.end; row++) {
    count += trend.count[row] as number;
  }
  return count;
}

function valueFor(
  state: SeriesTrendState | undefined,
  doc: string,
  tokens: number,
): CatalogTotalValue {
  if (!state || state.status === 'pending') return { status: 'pending' };
  if (state.status === 'error') return { status: 'error', message: state.message };
  const count = countForDocument(state.trend, doc);
  if (count === null) return { status: 'unavailable' };
  return {
    status: 'ready',
    count,
    rate: tokens === 0 ? 0 : (count / tokens) * TREND_RATE_DENOMINATOR,
  };
}

/**
 * Project resident trend lanes into exact per-book totals. The scope
 * discriminant selects both numerator lane and token denominator so a
 * baseline count can never be paired with a selected-range denominator.
 */
export function catalogTotals(input: {
  readonly scope: CatalogTotalsScope;
  readonly docs: readonly string[];
  readonly series: readonly SeriesIntent[];
  readonly baseline: ReadonlyMap<string, SeriesTrendState>;
  readonly ranged: ReadonlyMap<string, SeriesTrendState>;
  readonly fullTokens: ReadonlyMap<string, number>;
  readonly rangeTokens: ReadonlyMap<string, number>;
}): CatalogTotalsVM {
  const lane = input.scope === 'range' ? input.ranged : input.baseline;
  const tokenSource = input.scope === 'range' ? input.rangeTokens : input.fullTokens;
  const inScopeDocs = input.scope === 'range'
    ? input.docs.filter((doc) => input.rangeTokens.has(doc))
    : input.docs;
  const docs = inScopeDocs.filter((doc) => tokenSource.has(doc));
  const missingDocs = inScopeDocs.filter((doc) => !tokenSource.has(doc));
  const rows = docs.map((doc): CatalogTotalRow => {
    const tokens = tokenSource.get(doc) ?? 0;
    return {
      doc,
      tokens,
      values: new Map(input.series.map((term) => [
        term.id,
        valueFor(lane.get(term.id), doc, tokens),
      ])),
    };
  });
  const corpusTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const corpusValues = new Map<string, CatalogTotalValue>();
  for (const term of input.series) {
    if (rows.length === 0) {
      corpusValues.set(term.id, { status: 'unavailable' });
      continue;
    }
    const values = rows.map((row) => row.values.get(term.id));
    const error = values.find(
      (value): value is Extract<CatalogTotalValue, { status: 'error' }> => value?.status === 'error',
    );
    if (error) {
      corpusValues.set(term.id, error);
      continue;
    }
    if (values.some((value) => value?.status === 'pending')) {
      corpusValues.set(term.id, { status: 'pending' });
      continue;
    }
    if (values.some((value) => !value || value.status === 'unavailable')) {
      corpusValues.set(term.id, { status: 'unavailable' });
      continue;
    }
    const count = values.reduce(
      (sum, value) => sum + (value?.status === 'ready' ? value.count : 0),
      0,
    );
    corpusValues.set(term.id, {
      status: 'ready',
      count,
      rate: corpusTokens === 0
        ? 0
        : (count / corpusTokens) * TREND_RATE_DENOMINATOR,
    });
  }
  return {
    scope: input.scope,
    series: input.series,
    rows,
    missingDocs,
    corpus: { tokens: corpusTokens, values: corpusValues },
  };
}
