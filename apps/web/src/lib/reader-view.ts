/** Pure reader presentation geometry. Token-range selection is converted to
 * page-relative UTF-16 boundaries using only authenticated page offsets. */

import type { ReaderPageResultV1 } from '../shared/analysis-contract.ts';
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
