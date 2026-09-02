import { describe, expect, it } from 'vitest';
import {
  clampPositionHistoryExtents,
  EMPTY_POSITION_HISTORY,
  POSITION_HISTORY_MAX_ENTRIES,
  POSITION_HISTORY_NEAR_TOKENS,
  POSITION_HISTORY_REFIT_TOLERANCE_TOKENS,
  nextPosition,
  previousPosition,
  reconcilePositionHistory,
  recordPositionJump,
  recordPositionSettle,
  traversePositionHistory,
  type PositionHistory,
  type PositionHistoryEntry,
  type PositionHistoryOrigin,
} from '../src/lib/position-history.ts';

const at = (
  token: number,
  doc = 'a',
  origin: PositionHistoryOrigin = 'scrub',
  snapshot = 's1',
): PositionHistoryEntry => ({ snapshot, doc, token, origin });

function jump(
  history: PositionHistory,
  from: number | null,
  to: number,
): PositionHistory {
  return recordPositionJump(history, from === null ? null : at(from), at(to, 'a', 'find'));
}

describe('reading position history', () => {
  it('captures a jump departure and traverses backward and forward without recording', () => {
    const visited = jump(EMPTY_POSITION_HISTORY, 10, 400);
    expect(visited.entries).toEqual([at(10), at(400, 'a', 'find')]);
    expect(previousPosition(visited)).toEqual(at(10));
    expect(nextPosition(visited)).toBeNull();

    const back = traversePositionHistory(visited, -1)!;
    expect(back.target).toEqual(at(10));
    expect(back.history.entries).toEqual(visited.entries);
    expect(nextPosition(back.history)).toEqual(at(400, 'a', 'find'));
    const forward = traversePositionHistory(back.history, 1)!;
    expect(forward.target).toEqual(at(400, 'a', 'find'));
    expect(forward.history.entries).toEqual(visited.entries);
  });

  it('retains one origin and one mutable destination through repeated drift settles', () => {
    let history = recordPositionSettle(EMPTY_POSITION_HISTORY, at(0));
    for (let token = 100; token <= 2_000; token += 100) {
      history = recordPositionSettle(history, at(token));
    }
    expect(history.entries).toEqual([at(0), at(2_000)]);
    expect(history.tail).toBe('provisional');
  });

  it('absorbs one surface refit after traversal but branches after material movement', () => {
    const visited = jump(jump(EMPTY_POSITION_HISTORY, 0, 5_000), 5_000, 10_000);
    const back = traversePositionHistory(visited, -1)!;
    const refit = recordPositionSettle(
      back.history,
      at(5_000 + POSITION_HISTORY_REFIT_TOLERANCE_TOKENS),
    );
    expect(refit.entries).toHaveLength(3);
    expect(refit.index).toBe(1);
    expect(nextPosition(refit)?.token).toBe(10_000);

    const branch = recordPositionSettle(
      refit,
      at(refit.entries[refit.index]!.token + POSITION_HISTORY_NEAR_TOKENS + 1),
    );
    expect(branch.entries.map((entry) => entry.token)).toEqual([
      0,
      5_000 + POSITION_HISTORY_REFIT_TOLERANCE_TOKENS,
      5_000 + POSITION_HISTORY_REFIT_TOLERANCE_TOKENS + POSITION_HISTORY_NEAR_TOKENS + 1,
    ]);
    expect(nextPosition(branch)).toBeNull();
  });

  it('a push truncates forward while a near amendment preserves it', () => {
    const visited = jump(jump(EMPTY_POSITION_HISTORY, 0, 1_000), 1_000, 2_000);
    const back = traversePositionHistory(visited, -1)!;
    const amended = recordPositionSettle(back.history, at(1_001));
    expect(nextPosition(amended)?.token).toBe(2_000);

    const branched = recordPositionJump(amended, at(1_001), at(4_000, 'a', 'barcode'));
    expect(branched.entries.map((entry) => entry.token)).toEqual([0, 1_001, 4_000]);
    expect(nextPosition(branched)).toBeNull();
  });

  it('coalesces near duplicates only inside the same document', () => {
    const near = jump(EMPTY_POSITION_HISTORY, 0, POSITION_HISTORY_NEAR_TOKENS);
    expect(near.entries).toHaveLength(1);
    const crossDocument = recordPositionJump(near, at(POSITION_HISTORY_NEAR_TOKENS), at(0, 'b'));
    expect(crossDocument.entries.map((entry) => entry.doc)).toEqual(['a', 'b']);
  });

  it('caps old entries while retaining the current destination', () => {
    let history = EMPTY_POSITION_HISTORY;
    for (let index = 0; index < POSITION_HISTORY_MAX_ENTRIES + 8; index += 1) {
      history = recordPositionJump(
        history,
        index === 0 ? null : at((index - 1) * 1_000),
        at(index * 1_000, 'a', 'occurrence'),
      );
    }
    expect(history.entries).toHaveLength(POSITION_HISTORY_MAX_ENTRIES);
    expect(history.index).toBe(POSITION_HISTORY_MAX_ENTRIES - 1);
    expect(history.entries.at(-1)?.token).toBe((POSITION_HISTORY_MAX_ENTRIES + 7) * 1_000);
  });

  it('reconciles surviving documents, clamps tokens, deduplicates, and adjusts the index', () => {
    let history = recordPositionJump(EMPTY_POSITION_HISTORY, at(0, 'a'), at(1_000, 'b'));
    history = recordPositionJump(history, at(1_000, 'b'), at(1_020, 'b'));
    history = recordPositionJump(history, at(1_020, 'b'), at(8_000, 'c'));
    const back = traversePositionHistory(history, -1)!;
    const reconciled = reconcilePositionHistory(
      back.history,
      's2',
      ['b', 'c'],
      new Map([['b', 1_010], ['c', 100]]),
    );
    expect(reconciled.entries).toEqual([
      at(1_009, 'b', 'scrub', 's2'),
      at(99, 'c', 'scrub', 's2'),
    ]);
    expect(reconciled.index).toBe(0);
    expect(reconciled.tail).toBe('hardened');
  });

  it('retains a ready document until its replacement extent is known', () => {
    const history = jump(EMPTY_POSITION_HISTORY, 10, 1_000);
    const unresolved = reconcilePositionHistory(history, 's2', ['a'], new Map());
    expect(unresolved.entries.map((entry) => ({ snapshot: entry.snapshot, token: entry.token })))
      .toEqual([
        { snapshot: 's2', token: 10 },
        { snapshot: 's2', token: 1_000 },
      ]);

    const measured = reconcilePositionHistory(
      unresolved,
      's2',
      ['a'],
      new Map([['a', 500]]),
    );
    expect(measured.entries.map((entry) => entry.token)).toEqual([10, 499]);
  });

  it('clamps measured extents without hardening a traversal landing', () => {
    const visited = jump(jump(EMPTY_POSITION_HISTORY, 0, 5_000), 5_000, 10_000);
    const back = traversePositionHistory(visited, -1)!;
    const clamped = clampPositionHistoryExtents(
      back.history,
      new Map([['a', 6_000]]),
    );
    expect(clamped.entries.map((entry) => entry.token)).toEqual([0, 5_000, 5_999]);
    expect(clamped.tail).toBe('settling');
    expect(nextPosition(clamped)?.token).toBe(5_999);
  });

  it('returns no traversal at either edge and empties when no document survives', () => {
    const only = recordPositionSettle(EMPTY_POSITION_HISTORY, at(4));
    expect(traversePositionHistory(only, -1)).toBeNull();
    expect(traversePositionHistory(only, 1)).toBeNull();
    expect(reconcilePositionHistory(only, 's2', [], new Map()))
      .toBe(EMPTY_POSITION_HISTORY);
  });
});
