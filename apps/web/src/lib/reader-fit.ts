import type { ReaderPageResultV1 } from '../shared/analysis-contract.ts';

export type ReaderFitCursor =
  | { readonly kind: 'from'; readonly token: number }
  | { readonly kind: 'before'; readonly token: number }
  | { readonly kind: 'around'; readonly token: number };

export interface ReaderFitSearch {
  readonly limit: number;
  readonly low: number;
  readonly high: number | null;
  readonly probe: number;
}
export type ReaderFitAdvance =
  | { readonly done: false; readonly search: ReaderFitSearch }
  | { readonly done: true; readonly count: number; readonly saturated: boolean };

/** A nested token range for one real-DOM fit probe. */
export function readerProbeRange(
  source: Pick<ReaderPageResultV1, 'tokens'>,
  cursor: ReaderFitCursor,
  requestedCount: number,
): { readonly start: number; readonly end: number } {
  const limit = source.tokens.end - source.tokens.start;
  const count = Math.max(1, Math.min(limit, Math.trunc(requestedCount)));
  if (cursor.kind === 'from') {
    const start = Math.max(source.tokens.start, Math.min(cursor.token, source.tokens.end - 1));
    return { start, end: Math.min(source.tokens.end, start + count) };
  }
  if (cursor.kind === 'before') {
    const end = Math.min(source.tokens.end, Math.max(cursor.token, source.tokens.start + 1));
    return { start: Math.max(source.tokens.start, end - count), end };
  }
  const anchor = Math.max(source.tokens.start, Math.min(cursor.token, source.tokens.end - 1));
  let start = anchor - Math.floor((count - 1) / 2);
  let end = start + count;
  if (start < source.tokens.start) {
    end += source.tokens.start - start;
    start = source.tokens.start;
  }
  if (end > source.tokens.end) {
    start = Math.max(source.tokens.start, start - (end - source.tokens.end));
    end = source.tokens.end;
  }
  return { start, end };
}

/** Seeded exponential search followed by bisection over a monotone fit. */
export function startReaderFit(limit: number, seed: number): ReaderFitSearch {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('fit limit must be positive');
  const probe = Math.max(1, Math.min(limit, Math.trunc(seed)));
  return { limit, low: 0, high: null, probe };
}

export function advanceReaderFit(
  search: ReaderFitSearch,
  fits: boolean,
): ReaderFitAdvance {
  if (fits) {
    const low = Math.max(search.low, search.probe);
    if (low === search.limit) return { done: true, count: low, saturated: true };
    if (search.high === null) {
      const probe = Math.min(search.limit, Math.max(low + 1, low * 2));
      return { done: false, search: { ...search, low, probe } };
    }
    if (low + 1 >= search.high) {
      return { done: true, count: low, saturated: false };
    }
    return {
      done: false,
      search: {
        ...search,
        low,
        probe: Math.floor((low + search.high) / 2),
      },
    };
  }

  const high = Math.min(search.high ?? search.probe, search.probe);
  if (high <= 1) return { done: true, count: 1, saturated: false };
  if (search.low + 1 >= high) {
    return { done: true, count: Math.max(1, search.low), saturated: false };
  }
  return {
    done: false,
    search: {
      ...search,
      high,
      probe: Math.floor((search.low + high) / 2),
    },
  };
}
