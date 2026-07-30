import { describe, expect, it } from 'vitest';
import {
  armRange,
  cancelRange,
  commitRangeDraft,
  draftRangeTokens,
  moveRangeHandle,
  setRangeEnd,
  stepRangeHandle,
} from '../src/lib/range-mode.ts';

describe('explicit range mode', () => {
  it('arms at the reading cursor and commits one half-open selection', () => {
    const armed = armRange({ doc: 'a', token: 4 });
    expect(draftRangeTokens(armed)).toEqual({ start: 4, end: 5 });
    const ended = setRangeEnd(armed, { doc: 'a', token: 9 });
    expect(draftRangeTokens(ended)).toEqual({ start: 4, end: 10 });
    expect(commitRangeDraft('snapshot-1', ended, 20)).toEqual({
      snapshot: 'snapshot-1',
      doc: 'a',
      tokens: { start: 4, end: 10 },
    });
  });

  it('supports crossing handles and token-step precision', () => {
    let draft = setRangeEnd(armRange({ doc: 'a', token: 5 }), {
      doc: 'a',
      token: 8,
    });
    draft = stepRangeHandle(draft, 'start', 5, 10);
    expect(draftRangeTokens(draft)).toEqual({ start: 8, end: 10 });
    draft = stepRangeHandle(draft, 'end', -20, 10);
    expect(draftRangeTokens(draft)).toEqual({ start: 0, end: 10 });
  });

  it('moves either handle while preserving the owning document', () => {
    const draft = setRangeEnd(armRange({ doc: 'a', token: 2 }), {
      doc: 'a',
      token: 6,
    });
    expect(moveRangeHandle(draft, 'start', { doc: 'a', token: 4 })).toMatchObject({
      start: 4,
      end: 6,
      message: null,
    });
    expect(moveRangeHandle(draft, 'end', { doc: 'a', token: 1 })).toMatchObject({
      start: 2,
      end: 1,
      message: null,
    });
  });

  it('refuses a cross-book endpoint with visible feedback', () => {
    const draft = setRangeEnd(armRange({ doc: 'a', token: 2 }), {
      doc: 'b',
      token: 7,
    });
    expect(draft).toMatchObject({
      doc: 'a',
      start: 2,
      end: 2,
      message: 'A range must stay within one book; the endpoint was not moved.',
    });
  });

  it('cancel discards the local draft without producing a selection', () => {
    const draft = setRangeEnd(armRange({ doc: 'a', token: 1 }), {
      doc: 'a',
      token: 3,
    });
    expect(draftRangeTokens(draft)).toEqual({ start: 1, end: 4 });
    expect(cancelRange()).toBeNull();
  });

  it('commits crossed handles with the same visible half-open range', () => {
    const crossed = moveRangeHandle(
      setRangeEnd(armRange({ doc: 'a', token: 2 }), { doc: 'a', token: 7 }),
      'start',
      { doc: 'a', token: 9 },
    );
    expect(draftRangeTokens(crossed)).toEqual({ start: 7, end: 10 });
    expect(commitRangeDraft('snapshot-1', crossed, 20)?.tokens).toEqual({
      start: 7,
      end: 10,
    });
  });
});
