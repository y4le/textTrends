import { describe, expect, it } from 'vitest';
import type { ReaderPageResultV1 } from '../src/shared/analysis-contract.ts';
import {
  preservedReadingCursor,
  publishedReadingToken,
  readerCursorChars,
  readerTokenAtChar,
} from '../src/lib/reader-cursor.ts';

const page = (): ReaderPageResultV1 => ({
  method: 'reader-page/1',
  doc: 'a',
  tokens: { start: 10, end: 13 },
  docCharsUtf16: { start: 100, end: 113 },
  text: 'one two three',
  tokenStartsUtf16: [0, 4, 8],
  tokenEndsUtf16: [3, 7, 13],
  sentenceBounds: [0, 3],
  paragraphBounds: [0, 3],
  anchor: null,
  previous: { kind: 'before', token: 10 },
  next: { kind: 'from', token: 13 },
  atStart: false,
  atEnd: false,
  docTokenCount: 40,
  cappedBy: 'tokens',
  marks: [],
  marksTruncated: false,
});

describe('Reader reading cursor', () => {
  it('maps source characters and separator gaps to exact tokens', () => {
    const source = page();
    expect(readerTokenAtChar(source, 0)).toBe(10);
    expect(readerTokenAtChar(source, 2)).toBe(10);
    expect(readerTokenAtChar(source, 3)).toBe(10);
    expect(readerTokenAtChar(source, 4)).toBe(11);
    expect(readerTokenAtChar(source, 7)).toBe(11);
    expect(readerTokenAtChar(source, 8)).toBe(12);
    expect(readerTokenAtChar(source, source.text.length)).toBe(12);
  });

  it('rejects invalid offsets and malformed pages', () => {
    expect(readerTokenAtChar(page(), -1)).toBeNull();
    expect(readerTokenAtChar(page(), 14)).toBeNull();
    expect(readerTokenAtChar(page(), 1.5)).toBeNull();
    expect(readerTokenAtChar({ ...page(), tokenEndsUtf16: [] }, 1)).toBeNull();
  });

  it('returns the authenticated character span of the cursor token', () => {
    expect(readerCursorChars(page(), 11)).toEqual({ start: 4, end: 7 });
    expect(readerCursorChars(page(), 9)).toBeNull();
    expect(readerCursorChars(page(), null)).toBeNull();
  });

  it('preserves only a cursor inside the newly visible range', () => {
    expect(preservedReadingCursor(11, { start: 10, end: 13 })).toBe(11);
    expect(preservedReadingCursor(13, { start: 10, end: 13 })).toBeNull();
    expect(preservedReadingCursor(null, { start: 10, end: 13 })).toBeNull();
  });

  it('publishes an explicit cursor, then an around anchor, then page start', () => {
    const range = { start: 10, end: 13 };
    expect(publishedReadingToken(12, { kind: 'around', token: 11 }, range)).toBe(12);
    expect(publishedReadingToken(null, { kind: 'around', token: 11 }, range)).toBe(11);
    expect(publishedReadingToken(null, { kind: 'around', token: 20 }, range)).toBe(10);
    expect(publishedReadingToken(null, { kind: 'from', token: 11 }, range)).toBe(10);
  });
});
