/** Pure reader presentation geometry. Token-range selection is converted to
 * page-relative UTF-16 boundaries using only authenticated page offsets. */

import type { ReaderPageMarkV1, ReaderPageResultV1 } from '../shared/analysis-contract.ts';
import { selectionRangeForDoc, type TokenRangeSelectionV1 } from './selection.ts';

export interface ReaderSelectionChars {
  readonly start: number;
  readonly end: number;
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
}

export function readerSelectionChars(
  page: ReaderPageResultV1,
  selection: TokenRangeSelectionV1 | null,
  pageSnapshot: string,
): ReaderSelectionChars | null {
  if (!selection || selection.snapshot !== pageSnapshot) return null;
  const range = selectionRangeForDoc(selection, page.doc);
  if (range === null) return null;
  const rangeOrdinal = selection.ranges.indexOf(range);
  const tokenStart = Math.max(page.tokens.start, range.tokens.start);
  const tokenEnd = Math.min(page.tokens.end, range.tokens.end);
  if (tokenStart >= tokenEnd) return null;
  const relStart = tokenStart - page.tokens.start;
  const relLast = tokenEnd - page.tokens.start - 1;
  const start = page.tokenStartsUtf16[relStart];
  const end = page.tokenEndsUtf16[relLast];
  if (start === undefined || end === undefined || start >= end) return null;
  return {
    start,
    end,
    clippedStart: rangeOrdinal > 0 || range.tokens.start < page.tokens.start,
    clippedEnd: rangeOrdinal < selection.ranges.length - 1
      || range.tokens.end > page.tokens.end,
  };
}

export function readerRangeLabel(page: ReaderPageResultV1): string {
  if (page.tokens.start >= page.tokens.end) return 'empty document';
  return `tokens ${(page.tokens.start + 1).toLocaleString()}–${page.tokens.end.toLocaleString()} of ${page.docTokenCount.toLocaleString()}`;
}

/** Project an authenticated source slice onto the smaller token range that
 * the browser proved fits. Text and marks remain source-derived; no source
 * HTML or client-side tokenization enters the Reader. */
export function sliceReaderPage(
  source: ReaderPageResultV1,
  tokens: { readonly start: number; readonly end: number },
): ReaderPageResultV1 {
  if (
    !Number.isSafeInteger(tokens.start)
    || !Number.isSafeInteger(tokens.end)
    || tokens.start < source.tokens.start
    || tokens.end > source.tokens.end
    || tokens.start >= tokens.end
  ) {
    throw new RangeError('visible reader range must be a non-empty source subrange');
  }
  const relStart = tokens.start - source.tokens.start;
  const relEnd = tokens.end - source.tokens.start;
  const charStart = source.tokenStartsUtf16[relStart];
  const charEnd = source.tokenEndsUtf16[relEnd - 1];
  if (charStart === undefined || charEnd === undefined || charStart >= charEnd) {
    throw new RangeError('visible reader range has invalid source offsets');
  }
  const marks: ReaderPageMarkV1[] = [];
  for (const mark of source.marks) {
    if (mark.charsUtf16.start >= charEnd || mark.charsUtf16.end <= charStart) continue;
    marks.push({
      ...mark,
      charsUtf16: {
        start: Math.max(mark.charsUtf16.start, charStart) - charStart,
        end: Math.min(mark.charsUtf16.end, charEnd) - charStart,
      },
      clippedStart: mark.clippedStart || mark.tokens.start < tokens.start,
      clippedEnd: mark.clippedEnd || mark.tokens.end > tokens.end,
    });
  }
  const anchor = source.anchor !== null
    && source.anchor.token >= tokens.start
    && source.anchor.token < tokens.end
    ? {
        token: source.anchor.token,
        relToken: source.anchor.token - tokens.start,
        charsUtf16: {
          start: source.anchor.charsUtf16.start - charStart,
          end: source.anchor.charsUtf16.end - charStart,
        },
      }
    : null;
  return {
    ...source,
    tokens: { ...tokens },
    docCharsUtf16: {
      start: source.docCharsUtf16.start + charStart,
      end: source.docCharsUtf16.start + charEnd,
    },
    text: source.text.slice(charStart, charEnd),
    tokenStartsUtf16: source.tokenStartsUtf16
      .slice(relStart, relEnd)
      .map((offset) => offset - charStart),
    tokenEndsUtf16: source.tokenEndsUtf16
      .slice(relStart, relEnd)
      .map((offset) => offset - charStart),
    sentenceBounds: source.sentenceBounds
      .filter((boundary) => boundary >= relStart && boundary <= relEnd)
      .map((boundary) => boundary - relStart),
    paragraphBounds: source.paragraphBounds
      .filter((boundary) => boundary >= relStart && boundary <= relEnd)
      .map((boundary) => boundary - relStart),
    anchor,
    previous: tokens.start === 0 ? null : { kind: 'before', token: tokens.start },
    next: tokens.end === source.docTokenCount ? null : { kind: 'from', token: tokens.end },
    atStart: tokens.start === 0,
    atEnd: tokens.end === source.docTokenCount,
    cappedBy: tokens.end === source.docTokenCount ? null : 'tokens',
    marks,
  };
}
