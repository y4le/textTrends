import { describe, expect, it } from 'vitest';
import type { ReaderPageResultV1 } from '../src/shared/analysis-contract.ts';
import type { ReaderPlace } from '../src/lib/reader-intent.ts';
import { readerPosition, type ReaderPositionInput } from '../src/lib/reader-position.ts';

const place: ReaderPlace = {
  snapshot: 'snapshot-1',
  doc: 'study',
  cursor: { kind: 'around', token: 3 },
  from: 'footer',
  anchor: 'position',
};

const page: ReaderPageResultV1 = {
  method: 'reader-page/1',
  doc: 'study',
  tokens: { start: 0, end: 20 },
  docCharsUtf16: { start: 0, end: 20 },
  text: 'abcdefghijklmnopqrst',
  tokenStartsUtf16: Array.from({ length: 20 }, (_, index) => index),
  tokenEndsUtf16: Array.from({ length: 20 }, (_, index) => index + 1),
  sentenceBounds: [0, 20],
  paragraphBounds: [0, 20],
  anchor: { token: 7, relToken: 7, charsUtf16: { start: 7, end: 8 } },
  previous: null,
  next: null,
  atStart: true,
  atEnd: true,
  docTokenCount: 20,
  cappedBy: null,
  marks: [],
  marksTruncated: false,
};

const base: ReaderPositionInput = {
  place,
  page,
  visible: {
    snapshot: 'snapshot-1',
    doc: 'study',
    tokens: { start: 5, end: 12 },
    geometry: '390x500:0:tracks',
  },
  explicitCursor: 9,
  order: ['study', 'sign'],
  titleOf: (doc) => doc === 'study' ? 'A Study in Scarlet' : 'The Sign of Four',
  fallbackTokenCount: 99,
};

describe('reader position', () => {
  it('prefers an explicit visible cursor and ready-page token count', () => {
    expect(readerPosition(base)).toEqual({
      doc: 'study',
      title: 'A Study in Scarlet',
      ordinal: 1,
      textCount: 2,
      token: 9,
      tokenCount: 20,
      percent: 47,
      pageRange: { start: 5, end: 12 },
      source: 'explicit',
    });
  });

  it('falls through authenticated anchor, fitted page, then place', () => {
    expect(readerPosition({ ...base, explicitCursor: 19 })).toMatchObject({
      token: 7,
      source: 'anchor',
    });
    expect(readerPosition({
      ...base,
      explicitCursor: null,
      page: { ...page, anchor: null },
    })).toMatchObject({ token: 5, source: 'page' });
    expect(readerPosition({
      ...base,
      explicitCursor: null,
      page: { ...page, anchor: null },
      visible: null,
    })).toMatchObject({ token: 3, source: 'place', pageRange: null });
  });

  it('uses corpus count only when an authenticated ready-page count is absent', () => {
    expect(readerPosition({
      ...base,
      page: { ...page, doc: 'other' },
    })).toMatchObject({ tokenCount: 99 });
    expect(readerPosition({
      ...base,
      page: null,
      fallbackTokenCount: undefined,
    })).toMatchObject({ tokenCount: 0, percent: null });
  });

  it('resolves a before-boundary place to the preceding token', () => {
    expect(readerPosition({
      ...base,
      place: { ...place, cursor: { kind: 'before', token: 10 } },
      page: null,
      visible: null,
      explicitCursor: null,
    })).toMatchObject({ token: 9, source: 'place' });
  });

  it('reports absent and undeclared positions honestly', () => {
    expect(readerPosition({ ...base, place: null })).toBeNull();
    expect(readerPosition({ ...base, order: ['sign'] })).toMatchObject({ ordinal: 0 });
  });
});
