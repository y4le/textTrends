import { describe, expect, it } from 'vitest';
import {
  FOOTER_TOUCH_INTENT_PX,
  beginFooterTouchGesture,
  footerTouchCancel,
  footerTouchDown,
  footerTouchMove,
  footerTouchUp,
} from '../src/lib/footer-touch-gesture.ts';

const sample = (
  pointerId: number,
  clientX: number,
  clientY = 20,
  token = Math.round(clientX),
) => ({ pointerId, clientX, clientY, point: { doc: 'a', token } });

describe('footer direct-touch gesture', () => {
  it('jumps on a tap without entering drag mode', () => {
    const down = footerTouchDown(beginFooterTouchGesture(), sample(1, 20));
    const up = footerTouchUp(down.state, sample(1, 21));
    expect(up.state.phase).toBe('idle');
    expect(up.effect).toEqual({ kind: 'jump', point: { doc: 'a', token: 21 } });
  });

  it('locks a horizontal drag to absolute direct scrubbing', () => {
    let state = footerTouchDown(beginFooterTouchGesture(), sample(1, 20)).state;
    const moved = footerTouchMove(
      state,
      sample(1, 20 + FOOTER_TOUCH_INTENT_PX, 21),
    );
    expect(moved.state.phase).toBe('scrubbing');
    expect(moved.effect).toEqual({
      kind: 'scrub',
      point: { doc: 'a', token: 20 + FOOTER_TOUCH_INTENT_PX },
    });
    state = moved.state;
    const farther = footerTouchMove(state, sample(1, 90, 22));
    expect(farther.effect).toEqual({ kind: 'scrub', point: { doc: 'a', token: 90 } });
    expect(footerTouchUp(farther.state, sample(1, 100, 22)).effect)
      .toEqual({ kind: 'scrub', point: { doc: 'a', token: 100 } });
  });

  it('yields a vertical drag without jumping on release', () => {
    let state = footerTouchDown(beginFooterTouchGesture(), sample(1, 20)).state;
    const moved = footerTouchMove(state, sample(1, 22, 20 + FOOTER_TOUCH_INTENT_PX));
    expect(moved.state.phase).toBe('spent');
    expect(moved.effect.kind).toBe('none');
    state = footerTouchUp(moved.state, sample(1, 22, 80)).state;
    expect(state.phase).toBe('idle');
  });

  it('spends every contact after a second touch and resumes only after all lift', () => {
    let state = footerTouchDown(beginFooterTouchGesture(), sample(1, 20)).state;
    state = footerTouchDown(state, sample(2, 80)).state;
    expect(state.phase).toBe('spent');
    expect(footerTouchMove(state, sample(1, 100)).effect.kind).toBe('none');
    state = footerTouchUp(state, sample(2, 80)).state;
    expect(state.phase).toBe('spent');
    expect(footerTouchUp(state, sample(1, 100)).state.phase).toBe('idle');
  });

  it('cancels without changing the reading position', () => {
    const state = footerTouchDown(beginFooterTouchGesture(), sample(1, 20)).state;
    const canceled = footerTouchCancel(state, 1);
    expect(canceled.state.phase).toBe('idle');
    expect(canceled.effect.kind).toBe('none');
  });
});
