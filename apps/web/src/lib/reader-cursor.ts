import type { ReaderPageResultV1 } from '../shared/analysis-contract.ts';
import type { ReaderPlace } from './reader-intent.ts';

type ReaderTokenOffsets = Pick<
  ReaderPageResultV1,
  'tokens' | 'text' | 'tokenStartsUtf16' | 'tokenEndsUtf16'
>;

export interface ReaderCursorChars {
  readonly start: number;
  readonly end: number;
}

function validOffsets(page: ReaderTokenOffsets): boolean {
  const count = page.tokens.end - page.tokens.start;
  return count > 0
    && page.tokenStartsUtf16.length === count
    && page.tokenEndsUtf16.length === count;
}

/** Map one authenticated, page-relative UTF-16 position to the nearest token. */
export function readerTokenAtChar(
  page: ReaderTokenOffsets,
  charRel: number,
): number | null {
  if (
    !validOffsets(page)
    || !Number.isSafeInteger(charRel)
    || charRel < 0
    || charRel > page.text.length
  ) return null;

  let low = 0;
  let high = page.tokenStartsUtf16.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((page.tokenStartsUtf16[middle] ?? Number.POSITIVE_INFINITY) <= charRel) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const previous = low - 1;
  const next = low;
  if (previous < 0) return page.tokens.start;
  const previousEnd = page.tokenEndsUtf16[previous];
  if (previousEnd === undefined) return null;
  if (charRel < previousEnd || next >= page.tokenStartsUtf16.length) {
    return page.tokens.start + previous;
  }

  const nextStart = page.tokenStartsUtf16[next];
  if (nextStart === undefined) return null;
  return page.tokens.start + (
    nextStart - charRel <= charRel - previousEnd ? next : previous
  );
}

export function readerCursorChars(
  page: ReaderTokenOffsets,
  token: number | null,
): ReaderCursorChars | null {
  if (
    token === null
    || !Number.isSafeInteger(token)
    || token < page.tokens.start
    || token >= page.tokens.end
    || !validOffsets(page)
  ) return null;
  const relative = token - page.tokens.start;
  const start = page.tokenStartsUtf16[relative];
  const end = page.tokenEndsUtf16[relative];
  return start === undefined || end === undefined || start >= end
    ? null
    : { start, end };
}

/** Return the authenticated source text for one Reader token. */
export function readerCursorWord(
  page: ReaderTokenOffsets,
  token: number | null,
): string | null {
  const chars = readerCursorChars(page, token);
  if (chars === null) return null;
  const word = page.text.slice(chars.start, chars.end).trim();
  return word.length > 0 ? word : null;
}

export function readerSpeedEntryLabel(word: string | null): string {
  return word === null
    ? 'Open Speed reader paused at the reading cursor'
    : `Open Speed reader paused from “${word}”`;
}

export function preservedReadingCursor(
  cursor: number | null,
  range: { readonly start: number; readonly end: number },
): number | null {
  return cursor !== null
    && Number.isSafeInteger(cursor)
    && cursor >= range.start
    && cursor < range.end
    ? cursor
    : null;
}

export function publishedReadingToken(
  explicit: number | null,
  cursor: ReaderPlace['cursor'],
  range: { readonly start: number; readonly end: number },
): number {
  const preserved = preservedReadingCursor(explicit, range);
  if (preserved !== null) return preserved;
  return cursor.kind === 'around'
    && cursor.token >= range.start
    && cursor.token < range.end
    ? cursor.token
    : range.start;
}
