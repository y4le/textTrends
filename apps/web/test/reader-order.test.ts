import { describe, expect, it } from 'vitest';
import {
  adjacentReadableDocument,
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
