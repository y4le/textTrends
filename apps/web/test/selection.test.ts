/**
 * The pure linked-selection model (slice-2 commit E): the detailSelection
 * builder's load-bearing `[doc]`, range commitment, and validity rules.
 */
import { describe, expect, it } from 'vitest';
import { commitRange, detailSelection, isValidSelection, type TokenRangeSelectionV1 } from '../src/lib/selection.ts';

const sel = (over: Partial<TokenRangeSelectionV1> = {}): TokenRangeSelectionV1 => ({
  snapshot: 's1',
  doc: 'b',
  tokens: { start: 10, end: 20 },
  ...over,
});

describe('detailSelection — the ONE analytical-detail selection builder', () => {
  it('no selection → every ready doc, no ranges', () => {
    expect(detailSelection(['a', 'b'], null)).toEqual({ docs: ['a', 'b'] });
  });

  it('THE RULING TRAP: a selection names ONLY its document — never every ready doc plus one range', () => {
    // ranges scope only the docs they name; an absent per-doc range means
    // "whole document". docs: ['a','b'] + one range on b would silently mean
    // "b's range AND ALL OF a" (recorded ruling §2, round-1 named trap).
    const wire = detailSelection(['a', 'b'], sel());
    expect(wire.docs).toEqual(['b']); // the [doc] is load-bearing
    expect(wire.ranges).toEqual([{ doc: 'b', tokens: { start: 10, end: 20 } }]);
    expect(wire.docs).not.toContain('a');
  });
});

describe('commitRange — inclusive endpoints to half-open, one document', () => {
  it('orders endpoints either direction and converts to half-open', () => {
    expect(commitRange('s1', 'a', 5, 9, 100)!.tokens).toEqual({ start: 5, end: 10 });
    expect(commitRange('s1', 'a', 9, 5, 100)!.tokens).toEqual({ start: 5, end: 10 }); // backwards drag
    expect(commitRange('s1', 'a', 7, 7, 100)!.tokens).toEqual({ start: 7, end: 8 }); // single token is nonempty
  });

  it('clamps endpoints to the document extent; empty docs commit nothing', () => {
    expect(commitRange('s1', 'a', -5, 500, 100)!.tokens).toEqual({ start: 0, end: 100 });
    expect(commitRange('s1', 'a', 1, 2, 0)).toBeNull();
  });
});

describe('isValidSelection — snapshot-bound, ready-doc, nonempty half-open', () => {
  it('accepts a live, ready, nonempty range and rejects each broken facet', () => {
    expect(isValidSelection(sel(), 's1', ['a', 'b'])).toBe(true);
    expect(isValidSelection(sel(), 's2', ['a', 'b'])).toBe(false); // superseded snapshot
    expect(isValidSelection(sel(), null, ['a', 'b'])).toBe(false); // no snapshot
    expect(isValidSelection(sel(), 's1', ['a'])).toBe(false); // doc departed
    expect(isValidSelection(sel({ tokens: { start: 5, end: 5 } }), 's1', ['a', 'b'])).toBe(false); // empty
    expect(isValidSelection(sel({ tokens: { start: -1, end: 3 } }), 's1', ['a', 'b'])).toBe(false);
    expect(isValidSelection(sel({ tokens: { start: 0, end: Number.MAX_SAFE_INTEGER + 2 } }), 's1', ['a', 'b'])).toBe(false);
  });
});
