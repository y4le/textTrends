import { describe, expect, it } from 'vitest';
import {
  TOUCH_RANGE_MIN_PX,
  TOUCH_RANGE_HOLD_MOVE_PX,
  beginTouchRangeGesture,
  resetTouchRangeGesture,
  touchRangeCancel,
  touchRangeDown,
  touchRangeHold,
  touchRangeMove,
  touchRangeUp,
} from '../src/lib/touch-range-gesture.ts';

const sample = (
  pointerId: number,
  clientX: number,
  doc = 'a',
  token = Math.round(clientX),
) => ({ pointerId, clientX, clientY: 20, point: { doc, token } });

describe('two-touch range gesture', () => {
  it('promotes the current first touch and second touch into a live preview', () => {
    let state = touchRangeDown(beginTouchRangeGesture(), sample(1, 20)).state;
    state = touchRangeMove(state, sample(1, 40)).state;
    const ranged = touchRangeDown(state, sample(2, 90));
    expect(ranged.state.phase).toBe('ranging');
    expect(ranged.effect).toEqual({
      kind: 'preview',
      origin: { doc: 'a', token: 40 },
      head: { doc: 'a', token: 90 },
    });
  });

  it('updates either endpoint and commits exactly once on the first lift', () => {
    let state = touchRangeDown(beginTouchRangeGesture(), sample(1, 20)).state;
    state = touchRangeDown(state, sample(2, 100)).state;
    const moved = touchRangeMove(state, sample(2, 140));
    expect(moved.effect).toMatchObject({ kind: 'preview', head: { token: 140 } });
    const committed = touchRangeUp(moved.state, sample(1, 20));
    expect(committed.effect).toEqual({
      kind: 'commit',
      origin: { doc: 'a', token: 20 },
      head: { doc: 'a', token: 140 },
    });
    expect(committed.state.phase).toBe('spent');
    const finalLift = touchRangeUp(committed.state, sample(2, 140));
    expect(finalLift.effect.kind).toBe('none');
    expect(finalLift.state.phase).toBe('idle');
  });

  it('cancels a below-floor gesture without committing', () => {
    let state = touchRangeDown(beginTouchRangeGesture(), sample(1, 20)).state;
    state = touchRangeDown(state, sample(2, 20 + TOUCH_RANGE_MIN_PX - 1)).state;
    expect(touchRangeUp(state, sample(1, 20)).effect.kind).toBe('cancel');
  });

  it('allows cross-document endpoints regardless of horizontal separation', () => {
    let state = touchRangeDown(beginTouchRangeGesture(), sample(1, 20, 'a', 5)).state;
    state = touchRangeDown(state, sample(2, 21, 'b', 2)).state;
    expect(touchRangeUp(state, sample(2, 21, 'b', 2)).effect.kind).toBe('commit');
  });

  it('ignores a third touch without stealing either endpoint', () => {
    let state = touchRangeDown(beginTouchRangeGesture(), sample(1, 20)).state;
    state = touchRangeDown(state, sample(2, 100)).state;
    state = touchRangeDown(state, sample(3, 180)).state;
    const thirdMove = touchRangeMove(state, sample(3, 220));
    expect(thirdMove.effect.kind).toBe('none');
    const thirdUp = touchRangeUp(thirdMove.state, sample(3, 220));
    expect(thirdUp.state.phase).toBe('ranging');
  });

  it('cancels on endpoint cancellation and remains spent until all contacts lift', () => {
    let state = touchRangeDown(beginTouchRangeGesture(), sample(1, 20)).state;
    state = touchRangeDown(state, sample(2, 100)).state;
    const canceled = touchRangeCancel(state, 1);
    expect(canceled.effect.kind).toBe('cancel');
    expect(canceled.state.phase).toBe('spent');
    expect(touchRangeUp(canceled.state, sample(2, 100)).state.phase).toBe('idle');
  });

  it('resets an active preview without producing a commit', () => {
    let state = touchRangeDown(beginTouchRangeGesture(), sample(1, 20)).state;
    state = touchRangeDown(state, sample(2, 100)).state;
    const reset = resetTouchRangeGesture(state);
    expect(reset.effect.kind).toBe('cancel');
    expect(reset.state.phase).toBe('spent');
    state = touchRangeUp(reset.state, sample(1, 20)).state;
    expect(state.phase).toBe('spent');
    expect(touchRangeUp(state, sample(2, 100)).state.phase).toBe('idle');
  });

  it('anchors after a stationary hold and commits with the next tap', () => {
    let state = touchRangeDown(beginTouchRangeGesture(), sample(1, 20)).state;
    const held = touchRangeHold(state, 1);
    expect(held.state.phase).toBe('anchored');
    expect(held.effect).toEqual({ kind: 'anchor', point: { doc: 'a', token: 20 } });
    state = touchRangeUp(held.state, sample(1, 20)).state;
    expect(state.phase).toBe('anchored');
    const endpoint = touchRangeDown(state, sample(2, 60));
    expect(endpoint.effect).toEqual({
      kind: 'preview',
      origin: { doc: 'a', token: 20 },
      head: { doc: 'a', token: 60 },
    });
    const committed = touchRangeUp(endpoint.state, sample(2, 60));
    expect(committed.state.phase).toBe('idle');
    expect(committed.effect).toEqual({
      kind: 'commit',
      origin: { doc: 'a', token: 20 },
      head: { doc: 'a', token: 60 },
    });
  });

  it('applies the same minimum extent to the hold-and-tap alternative', () => {
    let state = touchRangeDown(beginTouchRangeGesture(), sample(1, 20)).state;
    state = touchRangeHold(state, 1).state;
    state = touchRangeUp(state, sample(1, 20)).state;
    state = touchRangeDown(state, sample(2, 20 + TOUCH_RANGE_MIN_PX - 1)).state;
    const canceled = touchRangeUp(state, sample(2, 20 + TOUCH_RANGE_MIN_PX - 1));
    expect(canceled.state.phase).toBe('idle');
    expect(canceled.effect.kind).toBe('cancel');
  });

  it('does not arm a hold after the contact moves beyond its tolerance', () => {
    let state = touchRangeDown(beginTouchRangeGesture(), sample(1, 20)).state;
    state = touchRangeMove(
      state,
      sample(1, 20 + TOUCH_RANGE_HOLD_MOVE_PX + 1),
    ).state;
    expect(touchRangeHold(state, 1).effect.kind).toBe('none');
    expect(touchRangeHold(state, 1).state.phase).toBe('reading');
  });

  it('cancels an anchored alternative without committing', () => {
    let state = touchRangeDown(beginTouchRangeGesture(), sample(1, 20)).state;
    state = touchRangeHold(state, 1).state;
    state = touchRangeUp(state, sample(1, 20)).state;
    const canceled = resetTouchRangeGesture(state);
    expect(canceled.state.phase).toBe('idle');
    expect(canceled.effect.kind).toBe('cancel');
  });

  it('keeps the ordinary two-touch path when the second contact lands during a hold', () => {
    let state = touchRangeDown(beginTouchRangeGesture(), sample(1, 20)).state;
    state = touchRangeHold(state, 1).state;
    const ranged = touchRangeDown(state, sample(2, 100));
    expect(ranged.state.phase).toBe('ranging');
    expect(ranged.effect.kind).toBe('preview');
  });
});
