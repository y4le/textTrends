import { describe, expect, it } from 'vitest';
import {
  idleTrendTitleGesture,
  resetTrendTitleGesture,
  trendTitleDown,
  trendTitleMove,
  trendTitleUp,
} from '../src/lib/trend-title-gesture.ts';

const move = (
  state: Parameters<typeof trendTitleMove>[0],
  overrides: Partial<Parameters<typeof trendTitleMove>[1]> = {},
) => trendTitleMove(state, {
  pointerId: 7,
  ordinal: 2,
  clientX: 20,
  clientY: 10,
  ...overrides,
});

describe('trend title selection gesture', () => {
  it('commits a stationary title press as a whole-text selection', () => {
    const pressed = trendTitleDown(7, 1, 10, 10);
    expect(pressed).toMatchObject({
      state: { phase: 'pressed', anchor: 1, head: 1, dragging: false },
      effect: { kind: 'none' },
    });
    expect(trendTitleUp(pressed.state, 7)).toEqual({
      state: { phase: 'idle' },
      effect: { kind: 'commit', anchor: 1, head: 1, dragged: false },
    });
  });

  it('previews forward and reverse drags after four pixels', () => {
    const forward = move(trendTitleDown(7, 0, 10, 10).state);
    expect(forward).toMatchObject({
      state: { phase: 'pressed', anchor: 0, head: 2, dragging: true },
      effect: { kind: 'preview', anchor: 0, head: 2 },
    });
    expect(trendTitleUp(forward.state, 7).effect)
      .toEqual({ kind: 'commit', anchor: 0, head: 2, dragged: true });

    const reverse = move(trendTitleDown(7, 3, 30, 10).state, {
      ordinal: 1,
      clientX: 20,
    });
    expect(reverse.effect).toEqual({ kind: 'preview', anchor: 3, head: 1 });
  });

  it('retains the last valid title while crossing an empty or invalid band', () => {
    const pressed = trendTitleDown(7, 1, 10, 10).state;
    const valid = move(pressed, { ordinal: 2 });
    const invalid = move(valid.state, { ordinal: null, clientX: 30 });
    expect(invalid).toMatchObject({
      state: { head: 2, dragging: true },
      effect: { kind: 'preview', anchor: 1, head: 2 },
    });
  });

  it('ignores unrelated pointers and cancels a live gesture', () => {
    const pressed = trendTitleDown(7, 1, 10, 10).state;
    expect(move(pressed, { pointerId: 8 })).toEqual({
      state: pressed,
      effect: { kind: 'none' },
    });
    expect(resetTrendTitleGesture(pressed)).toEqual({
      state: { phase: 'idle' },
      effect: { kind: 'cancel' },
    });
    expect(resetTrendTitleGesture(idleTrendTitleGesture()).effect).toEqual({ kind: 'none' });
  });
});
