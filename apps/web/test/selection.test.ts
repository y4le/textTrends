import { describe, expect, it } from 'vitest';
import {
  commitRange,
  detailSelection,
  isValidSelection,
  selectionComplement,
  selectionContains,
  selectionTokenCount,
  type TokenRangeSelectionV1,
} from '../src/lib/selection.ts';

const sel = (over: Partial<TokenRangeSelectionV1> = {}): TokenRangeSelectionV1 => ({
  snapshot: 's1',
  ranges: [{ doc: 'b', tokens: { start: 10, end: 20 } }],
  ...over,
});

describe('selectionComplement — the outside-selection comparison side', () => {
  const docs = ['a', 'b', 'c'];
  const counts = new Map([
    ['a', 10],
    ['b', 6],
    ['c', 8],
  ]);
  const complement = (ranges: TokenRangeSelectionV1['ranges']) =>
    selectionComplement(
      { snapshot: 's1', ranges },
      docs,
      (doc) => counts.get(doc),
    );

  it('keeps untouched documents whole and emits a suffix after a head selection', () => {
    expect(complement([
      { doc: 'a', tokens: { start: 0, end: 4 } },
    ])).toEqual({
      docs: ['a', 'b', 'c'],
      ranges: [{ doc: 'a', tokens: { start: 4, end: 10 } }],
    });
  });

  it('emits a prefix before a tail selection', () => {
    expect(complement([
      { doc: 'c', tokens: { start: 3, end: 8 } },
    ])).toEqual({
      docs: ['a', 'b', 'c'],
      ranges: [{ doc: 'c', tokens: { start: 0, end: 3 } }],
    });
  });

  it('emits two disjoint ranges around a selection in one document', () => {
    expect(complement([
      { doc: 'b', tokens: { start: 2, end: 4 } },
    ])).toEqual({
      docs: ['a', 'b', 'c'],
      ranges: [
        { doc: 'b', tokens: { start: 0, end: 2 } },
        { doc: 'b', tokens: { start: 4, end: 6 } },
      ],
    });
  });

  it('omits fully selected documents, including whole interior books', () => {
    expect(complement([
      { doc: 'a', tokens: { start: 7, end: 10 } },
      { doc: 'b', tokens: { start: 0, end: 6 } },
      { doc: 'c', tokens: { start: 0, end: 3 } },
    ])).toEqual({
      docs: ['a', 'c'],
      ranges: [
        { doc: 'a', tokens: { start: 0, end: 7 } },
        { doc: 'c', tokens: { start: 3, end: 8 } },
      ],
    });
  });

  it('returns only whole untouched documents when one book is fully selected', () => {
    expect(complement([
      { doc: 'b', tokens: { start: 0, end: 6 } },
    ])).toEqual({ docs: ['a', 'c'] });
  });

  it('returns null for a whole-corpus selection or unavailable geometry', () => {
    expect(complement([
      { doc: 'a', tokens: { start: 0, end: 10 } },
      { doc: 'b', tokens: { start: 0, end: 6 } },
      { doc: 'c', tokens: { start: 0, end: 8 } },
    ])).toBeNull();
    expect(selectionComplement(
      { snapshot: 's1', ranges: [{ doc: 'b', tokens: { start: 2, end: 4 } }] },
      docs,
      () => undefined,
    )).toBeNull();
  });

  it('refuses stale bounds and malformed selection records', () => {
    expect(complement([
      { doc: 'b', tokens: { start: 0, end: 99 } },
    ])).toBeNull();
    expect(complement([
      { doc: 'b', tokens: { start: 1.5, end: 4 } },
    ])).toBeNull();
    expect(complement([
      { doc: 'b', tokens: { start: 0, end: 2 } },
      { doc: 'b', tokens: { start: 4, end: 6 } },
    ])).toBeNull();
    expect(complement([
      { doc: 'missing', tokens: { start: 0, end: 1 } },
    ])).toBeNull();
    expect(complement([])).toBeNull();
  });
});

describe('detailSelection — the one analytical-detail selection builder', () => {
  it('uses every ready document when there is no linked selection', () => {
    expect(detailSelection(['a', 'b'], null)).toEqual({ docs: ['a', 'b'] });
  });

  it('projects explicit document ranges in declared order', () => {
    const selection = sel({
      ranges: [
        { doc: 'a', tokens: { start: 5, end: 10 } },
        { doc: 'b', tokens: { start: 0, end: 7 } },
      ],
    });
    expect(detailSelection(['a', 'b'], selection)).toEqual({
      docs: ['a', 'b'],
      ranges: selection.ranges,
    });
  });

  it('keeps a partial selection narrow and refuses a departed document', () => {
    expect(detailSelection(['a', 'b'], sel())).toEqual({
      docs: ['b'],
      ranges: [{ doc: 'b', tokens: { start: 10, end: 20 } }],
    });
    expect(() => detailSelection(['a'], sel())).toThrow(RangeError);
  });
});

describe('commitRange — inclusive endpoints across declared books', () => {
  const docs = ['a', 'empty', 'b', 'c'];
  const counts = [10, 0, 6, 8];

  it('orders endpoints either direction and converts a same-book span to half-open', () => {
    expect(commitRange('s1', { doc: 'a', token: 5 }, { doc: 'a', token: 9 }, docs, counts)?.ranges)
      .toEqual([{ doc: 'a', tokens: { start: 5, end: 10 } }]);
    expect(commitRange('s1', { doc: 'a', token: 9 }, { doc: 'a', token: 5 }, docs, counts)?.ranges)
      .toEqual([{ doc: 'a', tokens: { start: 5, end: 10 } }]);
    expect(commitRange('s1', { doc: 'a', token: 7 }, { doc: 'a', token: 7 }, docs, counts)?.ranges)
      .toEqual([{ doc: 'a', tokens: { start: 7, end: 8 } }]);
  });

  it('selects the first tail, intermediate books in full, and the last head', () => {
    const forward = commitRange(
      's1',
      { doc: 'a', token: 7 },
      { doc: 'c', token: 2 },
      docs,
      counts,
    );
    expect(forward?.ranges).toEqual([
      { doc: 'a', tokens: { start: 7, end: 10 } },
      { doc: 'b', tokens: { start: 0, end: 6 } },
      { doc: 'c', tokens: { start: 0, end: 3 } },
    ]);
    expect(commitRange(
      's1',
      { doc: 'c', token: 2 },
      { doc: 'a', token: 7 },
      docs,
      counts,
    )).toEqual(forward);
    expect(selectionTokenCount(forward!)).toBe(12);
  });

  it('clamps endpoints and refuses absent or empty endpoint books', () => {
    expect(commitRange('s1', { doc: 'a', token: -5 }, { doc: 'a', token: 500 }, docs, counts)?.ranges)
      .toEqual([{ doc: 'a', tokens: { start: 0, end: 10 } }]);
    expect(commitRange('s1', { doc: 'empty', token: 0 }, { doc: 'b', token: 2 }, docs, counts))
      .toBeNull();
    expect(commitRange('s1', { doc: 'missing', token: 0 }, { doc: 'b', token: 2 }, docs, counts))
      .toBeNull();
  });
});

describe('selection validity and membership', () => {
  it('accepts live ordered ranges and rejects stale, missing, repeated, reversed, or empty ranges', () => {
    expect(isValidSelection(sel(), 's1', ['a', 'b'])).toBe(true);
    expect(isValidSelection(sel(), 's2', ['a', 'b'])).toBe(false);
    expect(isValidSelection(sel(), null, ['a', 'b'])).toBe(false);
    expect(isValidSelection(sel(), 's1', ['a'])).toBe(false);
    expect(isValidSelection(sel({ ranges: [] }), 's1', ['a', 'b'])).toBe(false);
    expect(isValidSelection(sel({
      ranges: [
        { doc: 'b', tokens: { start: 0, end: 2 } },
        { doc: 'a', tokens: { start: 0, end: 2 } },
      ],
    }), 's1', ['a', 'b'])).toBe(false);
    expect(isValidSelection(sel({ ranges: [{ doc: 'b', tokens: { start: 5, end: 5 } }] }), 's1', ['a', 'b']))
      .toBe(false);
    expect(isValidSelection(sel({ ranges: [{ doc: 'b', tokens: { start: -1, end: 3 } }] }), 's1', ['a', 'b']))
      .toBe(false);
    expect(isValidSelection(sel({
      ranges: [{ doc: 'b', tokens: { start: 0, end: Number.MAX_SAFE_INTEGER + 2 } }],
    }), 's1', ['a', 'b'])).toBe(false);
  });

  it('tests membership against the matching document range', () => {
    expect(selectionContains(sel(), 'b', 10)).toBe(true);
    expect(selectionContains(sel(), 'b', 20)).toBe(false);
    expect(selectionContains(sel(), 'a', 15)).toBe(false);
  });
});
