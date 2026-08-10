import { describe, expect, it } from 'vitest';
import type { CorpusSnapshotV1 } from '../src/snapshot/compose.ts';
import type { ResolvedSelection } from '../src/snapshot/selection.ts';
import type { NumericOccurrences } from '../src/ops/occurrences.ts';
import { occurrenceStep, validateOccurrenceOrder } from '../src/ops/occurrence-step.ts';

const snapshot = {
  id: 'snap',
  docs: [
    { doc: 'a', sequenceTokenBase: 0, tokenCount: 10 },
    { doc: 'b', sequenceTokenBase: 10, tokenCount: 8 },
  ],
} as unknown as CorpusSnapshotV1;

const selection = {
  snapshot: 'snap',
  hash: 'all',
  spec: { docs: ['a', 'b'] },
} as unknown as ResolvedSelection;

const occurrences = {
  snapshot: 'snap',
  selection: 'all',
  docOrdinal: Uint32Array.from([0, 0, 1, 1]),
  pos: Uint32Array.from([2, 7, 1, 6]),
  spanTokens: Uint32Array.from([1, 2, 3, 1]),
  memberOffsets: Uint32Array.from([0, 1, 3, 4, 5]),
  memberOrdinals: Uint32Array.from([0, 1, 2, 3, 4]),
} as NumericOccurrences;

const step = (doc: string, token: number, direction: 1 | -1) => occurrenceStep(
  snapshot,
  selection,
  occurrences,
  { method: 'occurrence-step/1', doc, token, direction },
);

describe('occurrenceStep', () => {
  it('steps strictly by start across document boundaries and preserves span/member identity', () => {
    expect(step('a', 2, 1)).toEqual({
      method: 'occurrence-step/1',
      hit: { doc: 'a', token: 7, spanTokens: 2, members: [1, 2] },
      atEdge: false,
    });
    expect(step('a', 9, 1).hit).toEqual({ doc: 'b', token: 1, spanTokens: 3, members: [3] });
    expect(step('b', 1, -1).hit).toEqual({ doc: 'a', token: 7, spanTokens: 2, members: [1, 2] });
  });

  it('returns an exact total and a bounded edge result without wrapping', () => {
    expect(step('a', 0, -1)).toEqual({
      method: 'occurrence-step/1', hit: null, atEdge: true,
    });
    expect(step('b', 7, 1)).toEqual({
      method: 'occurrence-step/1', hit: null, atEdge: true,
    });
  });

  it('coalesces duplicate starts into stable reachable stops in both directions', () => {
    const overlapping = {
      ...occurrences,
      docOrdinal: Uint32Array.from([0, 0, 0, 1]),
      pos: Uint32Array.from([2, 2, 7, 1]),
      spanTokens: Uint32Array.from([1, 2, 1, 1]),
      memberOffsets: Uint32Array.from([0, 1, 3, 4, 5]),
      memberOrdinals: Uint32Array.from([2, 1, 2, 0, 3]),
    };
    const run = (doc: string, token: number, direction: 1 | -1) => occurrenceStep(
      snapshot,
      selection,
      overlapping,
      { method: 'occurrence-step/1', doc, token, direction },
    );
    const first = run('a', 0, 1);
    expect(first.hit).toEqual({ doc: 'a', token: 2, spanTokens: 2, members: [1, 2] });
    const second = run('a', 2, 1);
    expect(second.hit).toEqual({ doc: 'a', token: 7, spanTokens: 1, members: [0] });
    expect(run('a', 7, -1)).toEqual(first);
  });

  it('handles an empty occurrence set and rejects range-scoped or stale coordinates', () => {
    const empty = {
      ...occurrences,
      docOrdinal: new Uint32Array(),
      pos: new Uint32Array(),
      spanTokens: new Uint32Array(),
      memberOffsets: Uint32Array.of(0),
      memberOrdinals: new Uint32Array(),
    };
    expect(occurrenceStep(snapshot, selection, empty, {
      method: 'occurrence-step/1', doc: 'a', token: 3, direction: 1,
    })).toEqual({
      method: 'occurrence-step/1', hit: null, atEdge: true,
    });
    expect(() => occurrenceStep(snapshot, {
      ...selection,
      spec: { docs: ['a', 'b'], ranges: [{ doc: 'a', tokens: { start: 0, end: 5 } }] },
    } as unknown as ResolvedSelection, occurrences, {
      method: 'occurrence-step/1', doc: 'a', token: 3, direction: 1,
    })).toThrow(/full corpus/);
    expect(() => occurrenceStep(snapshot, selection, {
      ...occurrences,
      snapshot: 'old',
    } as unknown as NumericOccurrences, {
      method: 'occurrence-step/1', doc: 'a', token: 3, direction: 1,
    })).toThrow(/different snapshot/);
  });

  it('validates ordering once before an occurrence value enters the cache', () => {
    expect(() => validateOccurrenceOrder(snapshot, occurrences)).not.toThrow();
    expect(() => validateOccurrenceOrder(snapshot, {
      ...occurrences,
      pos: Uint32Array.from([7, 2, 1, 6]),
    })).toThrow(/declared corpus order/);
  });
});
