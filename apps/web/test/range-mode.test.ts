import { describe, expect, it } from 'vitest';
import {
  armRange,
  cancelRange,
  commitRangeDraft,
  draftRanges,
  moveRangeHandle,
  setRangeEnd,
  stepRangeHandle,
} from '../src/lib/range-mode.ts';

const docs = ['a', 'b', 'c'];
const counts = [10, 4, 8];

describe('explicit range mode', () => {
  it('arms at the reading cursor and commits one half-open selection', () => {
    const armed = armRange({ doc: 'a', token: 4 });
    expect(draftRanges(armed, docs, counts)).toEqual([
      { doc: 'a', tokens: { start: 4, end: 5 } },
    ]);
    const ended = setRangeEnd(armed, { doc: 'a', token: 9 });
    expect(commitRangeDraft('snapshot-1', ended, docs, counts)).toEqual({
      snapshot: 'snapshot-1',
      ranges: [{ doc: 'a', tokens: { start: 4, end: 10 } }],
    });
  });

  it('accepts an endpoint in another book and includes intermediate books', () => {
    const draft = setRangeEnd(armRange({ doc: 'a', token: 7 }), {
      doc: 'c',
      token: 2,
    });
    expect(draftRanges(draft, docs, counts)).toEqual([
      { doc: 'a', tokens: { start: 7, end: 10 } },
      { doc: 'b', tokens: { start: 0, end: 4 } },
      { doc: 'c', tokens: { start: 0, end: 3 } },
    ]);
  });

  it('moves handles across book boundaries with token-step precision', () => {
    let draft = setRangeEnd(armRange({ doc: 'a', token: 8 }), { doc: 'b', token: 1 });
    draft = stepRangeHandle(draft, 'start', 3, docs, counts);
    expect(draft.start).toEqual({ doc: 'b', token: 1 });
    draft = stepRangeHandle(draft, 'end', -3, docs, counts);
    expect(draft.end).toEqual({ doc: 'a', token: 8 });
  });

  it('moves either handle and supports crossed endpoints', () => {
    const draft = setRangeEnd(armRange({ doc: 'a', token: 2 }), { doc: 'b', token: 1 });
    expect(moveRangeHandle(draft, 'start', { doc: 'c', token: 4 })).toMatchObject({
      start: { doc: 'c', token: 4 },
      end: { doc: 'b', token: 1 },
    });
    expect(draftRanges(moveRangeHandle(draft, 'start', { doc: 'c', token: 4 }), docs, counts))
      .toEqual([
        { doc: 'b', tokens: { start: 1, end: 4 } },
        { doc: 'c', tokens: { start: 0, end: 5 } },
      ]);
  });

  it('cancel discards the local draft without producing a selection', () => {
    expect(cancelRange()).toBeNull();
  });
});
