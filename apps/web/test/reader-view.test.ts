import { describe, expect, it } from 'vitest';
import type { ReaderPageResultV1 } from '../src/shared/analysis-contract.ts';
import { readerRangeLabel, readerSelectionChars } from '../src/lib/reader-view.ts';

const page = (): ReaderPageResultV1 => ({
  method: 'reader-page/1',
  doc: 'a',
  tokens: { start: 10, end: 13 },
  docCharsUtf16: { start: 100, end: 113 },
  text: 'one two three',
  tokenStartsUtf16: [0, 4, 8],
  tokenEndsUtf16: [3, 7, 13],
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

describe('reader view geometry', () => {
  it('clips a snapshot-bound token selection to authenticated page offsets', () => {
    expect(readerSelectionChars(page(), {
      snapshot: 's1',
      doc: 'a',
      tokens: { start: 9, end: 12 },
    }, 's1')).toEqual({
      start: 0,
      end: 7,
      clippedStart: true,
      clippedEnd: false,
    });
    expect(readerSelectionChars(page(), {
      snapshot: 's1',
      doc: 'a',
      tokens: { start: 12, end: 20 },
    }, 's1')).toEqual({
      start: 8,
      end: 13,
      clippedStart: false,
      clippedEnd: true,
    });
  });

  it('rejects another snapshot/document and a non-overlap', () => {
    const selection = { snapshot: 's1', doc: 'a', tokens: { start: 0, end: 3 } };
    expect(readerSelectionChars(page(), selection, 's1')).toBeNull();
    expect(readerSelectionChars(page(), { ...selection, doc: 'b', tokens: { start: 10, end: 11 } }, 's1')).toBeNull();
    expect(readerSelectionChars(page(), { ...selection, tokens: { start: 10, end: 11 } }, 's2')).toBeNull();
  });

  it('labels half-open page ranges for people with a 1-based inclusive end', () => {
    expect(readerRangeLabel(page())).toBe('tokens 11–13 of 40');
  });
});
