import type { ReaderPageResultV1 } from '../shared/analysis-contract.ts';
import type { ReaderPlace } from './reader-intent.ts';
import { readerCursorToken } from './reader-intent.ts';
import { readerProgress } from './reader-progress.ts';
import type { ReaderVisibleRangeV1 } from './store.ts';

export interface ReaderPositionInput {
  readonly place: ReaderPlace | null;
  readonly page: ReaderPageResultV1 | null;
  readonly visible: ReaderVisibleRangeV1 | null;
  readonly explicitCursor: number | null;
  readonly order: readonly string[];
  readonly titleOf: (doc: string) => string;
  readonly fallbackTokenCount: number | undefined;
}

export interface ReaderPosition {
  readonly doc: string;
  readonly title: string;
  readonly ordinal: number;
  readonly textCount: number;
  readonly token: number;
  readonly tokenCount: number;
  readonly percent: number | null;
  readonly pageRange: { readonly start: number; readonly end: number } | null;
  readonly source: 'explicit' | 'anchor' | 'page' | 'place';
}

function tokenInside(
  token: number | null | undefined,
  range: { readonly start: number; readonly end: number } | null,
): token is number {
  return range !== null
    && token !== null
    && token !== undefined
    && Number.isSafeInteger(token)
    && token >= range.start
    && token < range.end;
}

export function readerPosition(input: ReaderPositionInput): ReaderPosition | null {
  const place = input.place;
  if (place === null) return null;
  const page = input.page?.doc === place.doc ? input.page : null;
  const visible = input.visible?.snapshot === place.snapshot
    && input.visible.doc === place.doc
    ? input.visible
    : null;
  const pageRange = visible?.tokens ?? null;
  const resolved = tokenInside(input.explicitCursor, pageRange)
    ? { token: input.explicitCursor, source: 'explicit' as const }
    : tokenInside(page?.anchor?.token, pageRange)
      ? { token: page.anchor.token, source: 'anchor' as const }
      : pageRange !== null
        ? { token: pageRange.start, source: 'page' as const }
        : { token: readerCursorToken(place.cursor), source: 'place' as const };
  const readyCount = page?.docTokenCount;
  const fallbackCount = input.fallbackTokenCount;
  const tokenCount = typeof readyCount === 'number'
      && Number.isSafeInteger(readyCount)
      && readyCount >= 1
    ? readyCount
    : typeof fallbackCount === 'number'
        && Number.isSafeInteger(fallbackCount)
        && fallbackCount >= 1
      ? fallbackCount
      : 0;
  const title = input.titleOf(place.doc);
  const progress = readerProgress(resolved.token, tokenCount, title);
  const index = input.order.indexOf(place.doc);
  return {
    doc: place.doc,
    title,
    ordinal: index < 0 ? 0 : index + 1,
    textCount: input.order.length,
    token: resolved.token,
    tokenCount,
    percent: progress?.percent ?? null,
    pageRange,
    source: resolved.source,
  };
}
