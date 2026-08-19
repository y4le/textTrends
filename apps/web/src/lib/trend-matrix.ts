import {
  TREND_RATE_DENOMINATOR,
  dpNorm,
  type NumericTrend,
} from '@texttrends/core';
import type { SeriesIntent, SeriesTrendState } from './store.ts';
import { termBookTotals } from './term-book-totals.ts';
import { trendBinSpan } from './trend-geometry.ts';

export type TrendMatrixDispersion = 'even' | 'varied' | 'clumped';
export type TrendMatrixPosition = 'beginning' | 'middle' | 'end';

export interface TrendMatrixBin {
  readonly start: number;
  readonly end: number;
  readonly rate: number;
  readonly count: number;
}

export type TrendMatrixCell =
  | {
      readonly status: 'ready';
      readonly doc: string;
      readonly count: number;
      readonly tokens: number;
      readonly rate: number;
      readonly profile: readonly TrendMatrixBin[];
      readonly dpNorm: number | null;
      readonly dispersion: TrendMatrixDispersion | null;
      readonly position: TrendMatrixPosition | null;
      readonly relativeToPeak: number;
    }
  | { readonly status: 'empty'; readonly doc: string }
  | { readonly status: 'pending'; readonly doc: string }
  | { readonly status: 'error'; readonly doc: string; readonly message: string }
  | { readonly status: 'unavailable'; readonly doc: string };

export interface TrendMatrixRow {
  readonly series: SeriesIntent;
  readonly status: 'ready' | 'pending' | 'error';
  readonly cells: readonly TrendMatrixCell[];
  readonly peakDoc: string | null;
  /** Shared raw-bin rate scale for every micro-histogram in this term row. */
  readonly microScale: number;
}

export interface TrendMatrixVM {
  readonly docs: readonly string[];
  readonly rows: readonly TrendMatrixRow[];
}

export function trendMatrixDispersionLabel(
  value: number | null,
): TrendMatrixDispersion | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value <= 0.2) return 'even';
  if (value <= 0.5) return 'varied';
  return 'clumped';
}

function massPosition(profile: readonly TrendMatrixBin[]): TrendMatrixPosition | null {
  let count = 0;
  let weighted = 0;
  for (const bin of profile) {
    count += bin.count;
    weighted += bin.count * ((bin.start + bin.end) / 2);
  }
  if (count === 0) return null;
  const centre = weighted / count;
  if (centre < 1 / 3) return 'beginning';
  if (centre > 2 / 3) return 'end';
  return 'middle';
}

function readyCell(trend: NumericTrend, doc: string): TrendMatrixCell {
  const totals = termBookTotals(trend, doc);
  if (totals === null) return { status: 'unavailable', doc };
  if (totals.extent === 0 || totals.tokens === 0) return { status: 'empty', doc };
  const ordinal = trend.order.indexOf(doc);
  const profile: TrendMatrixBin[] = [];
  const occurrences: number[] = [];
  const partSizes: number[] = [];
  for (let row = totals.rowStart; row < totals.rowEnd; row++) {
    const span = trendBinSpan(trend, ordinal, row - totals.rowStart);
    const tokens = trend.binTokens[row] as number;
    const count = trend.count[row] as number;
    occurrences.push(count);
    partSizes.push(tokens);
    if (span.end <= span.start) continue;
    profile.push({
      start: span.start / totals.extent,
      end: span.end / totals.extent,
      rate: tokens === 0 ? 0 : (count / tokens) * TREND_RATE_DENOMINATOR,
      count,
    });
  }
  const positiveParts = partSizes.filter((tokens) => tokens > 0).length;
  const dispersion = totals.count > 0 && positiveParts >= 2
    ? dpNorm(occurrences, partSizes)
    : null;
  return {
    status: 'ready',
    doc,
    count: totals.count,
    tokens: totals.tokens,
    rate: (totals.count / totals.tokens) * TREND_RATE_DENOMINATOR,
    profile,
    dpNorm: dispersion,
    dispersion: trendMatrixDispersionLabel(dispersion),
    position: massPosition(profile),
    relativeToPeak: 0,
  };
}

function unresolvedCells(
  docs: readonly string[],
  state: SeriesTrendState | undefined,
): readonly TrendMatrixCell[] {
  if (state?.status === 'error') {
    return docs.map((doc) => ({ status: 'error', doc, message: state.message }));
  }
  return docs.map((doc) => ({ status: 'pending', doc }));
}

/**
 * Project resident, unsmoothed trend bins into a qualitative term × book
 * shape matrix. Every term receives its own shared rate scale: comparison is
 * honest across books within a row, while rare terms remain visible.
 */
export function trendMatrix(input: {
  readonly docs: readonly string[];
  readonly series: readonly SeriesIntent[];
  readonly trends: ReadonlyMap<string, SeriesTrendState>;
}): TrendMatrixVM {
  const rows = input.series.map((series): TrendMatrixRow => {
    const state = input.trends.get(series.id);
    if (state?.status !== 'ready') {
      return {
        series,
        status: state?.status === 'error' ? 'error' : 'pending',
        cells: unresolvedCells(input.docs, state),
        peakDoc: null,
        microScale: 0,
      };
    }
    const draft = input.docs.map((doc) => readyCell(state.trend, doc));
    const ready = draft.filter(
      (cell): cell is Extract<TrendMatrixCell, { status: 'ready' }> => cell.status === 'ready',
    );
    const peakRate = ready.reduce((maximum, cell) => Math.max(maximum, cell.rate), 0);
    const peakDoc = peakRate === 0
      ? null
      : ready.find((cell) => cell.rate === peakRate)?.doc ?? null;
    const microScale = ready.reduce(
      (maximum, cell) => cell.profile.reduce(
        (cellMaximum, bin) => Math.max(cellMaximum, bin.rate),
        maximum,
      ),
      0,
    );
    const cells = draft.map((cell): TrendMatrixCell => cell.status === 'ready'
      ? { ...cell, relativeToPeak: peakRate === 0 ? 0 : cell.rate / peakRate }
      : cell);
    return {
      series,
      status: 'ready',
      cells,
      peakDoc,
      microScale,
    };
  });
  return { docs: input.docs, rows };
}

export function trendMatrixRateLabel(relativeToPeak: number, count: number): string {
  if (count === 0) return 'no occurrences';
  if (relativeToPeak >= 0.999) return 'highest rate in this term row';
  if (relativeToPeak >= 2 / 3) return 'high relative rate';
  if (relativeToPeak >= 1 / 3) return 'moderate relative rate';
  return 'low relative rate';
}
