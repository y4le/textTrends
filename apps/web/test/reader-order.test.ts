import { describe, expect, it } from 'vitest';
import {
  adjacentReadableDocumentAtRelativePosition,
  adjacentReadableDocument,
  readerRelativeToken,
  readyReaderDocumentOrder,
} from '../src/lib/reader-order.ts';

describe('readyReaderDocumentOrder', () => {
  it('keeps declared ready documents first and appends metadata misses', () => {
    expect(readyReaderDocumentOrder(
      ['c', 'a', 'not-ready', 'a'],
      ['a', 'b', 'c', 'b'],
    )).toEqual(['c', 'a', 'b']);
  });

  it('uses ready order when declared metadata is unavailable', () => {
    expect(readyReaderDocumentOrder(undefined, ['b', 'a', 'b']))
      .toEqual(['b', 'a']);
  });
});

describe('adjacentReadableDocument', () => {
  const order = ['a', 'empty', 'unknown', 'b', 'c'];
  const counts = new Map<string, number>([
    ['a', 12],
    ['empty', 0],
    ['b', 20],
    ['c', 3],
  ]);
  const adjacent = (doc: string, direction: 1 | -1) =>
    adjacentReadableDocument(order, doc, direction, (candidate) => counts.get(candidate));

  it('skips empty and unresolved documents in either direction', () => {
    expect(adjacent('a', 1)).toEqual({
      doc: 'b',
      cursor: { kind: 'from', token: 0 },
    });
    expect(adjacent('b', -1)).toEqual({
      doc: 'a',
      cursor: { kind: 'before', token: 12 },
    });
  });

  it('uses fitted-page boundary cursors and stops at corpus edges', () => {
    expect(adjacent('b', 1)).toEqual({
      doc: 'c',
      cursor: { kind: 'from', token: 0 },
    });
    expect(adjacent('c', -1)).toEqual({
      doc: 'b',
      cursor: { kind: 'before', token: 20 },
    });
    expect(adjacent('a', -1)).toBeNull();
    expect(adjacent('c', 1)).toBeNull();
    expect(adjacent('missing', 1)).toBeNull();
  });
});

describe('relative Reader text movement', () => {
  it('maps endpoints and midpoints across differently sized texts', () => {
    expect(readerRelativeToken(0, 101, 11)).toBe(0);
    expect(readerRelativeToken(50, 101, 11)).toBe(5);
    expect(readerRelativeToken(100, 101, 11)).toBe(10);
    expect(readerRelativeToken(500, 101, 11)).toBe(10);
    expect(readerRelativeToken(0, 1, 11)).toBe(0);
  });

  it('skips empty and unknown extents without changing declared order', () => {
    const counts = new Map([['a', 101], ['empty', 0], ['c', 11]]);
    const count = (doc: string) => counts.get(doc);
    expect(adjacentReadableDocumentAtRelativePosition(
      ['a', 'unknown', 'empty', 'c'], 'a', 1, 50, count,
    )).toEqual({ doc: 'c', token: 5 });
    expect(adjacentReadableDocumentAtRelativePosition(
      ['a', 'unknown', 'empty', 'c'], 'c', -1, 5, count,
    )).toEqual({ doc: 'a', token: 50 });
    expect(adjacentReadableDocumentAtRelativePosition(
      ['a', 'unknown', 'empty', 'c'], 'a', -1, 50, count,
    )).toBeNull();
  });

  it('rejects invalid source extents and tokens', () => {
    expect(readerRelativeToken(0, 0, 10)).toBeNull();
    expect(readerRelativeToken(Number.NaN, 10, 10)).toBeNull();
    expect(adjacentReadableDocumentAtRelativePosition(
      ['a', 'b'], 'a', 1, 0, () => undefined,
    )).toBeNull();
  });
});
