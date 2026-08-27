import { describe, expect, it } from 'vitest';
import { TOUCH_RANGE_HOLD_MS } from '../src/lib/touch-range-gesture.ts';
import {
  TREND_DOUBLE_TAP_MS,
  TREND_DOUBLE_TAP_SLOP_PX,
  TREND_TAP_MOVE_PX,
  idleTrendDoubleTap,
  trendDoubleTapDown,
  trendDoubleTapMove,
  trendDoubleTapUp,
  type TrendDoubleTapState,
} from '../src/lib/trend-double-tap.ts';

const down = (
  state: TrendDoubleTapState,
  overrides: Partial<Parameters<typeof trendDoubleTapDown>[1]> = {},
) => trendDoubleTapDown(state, {
  pointerId: 2,
  clientX: 22,
  clientY: 20,
  at: 200,
  zone: 'plot',
  clearable: true,
  interactiveTarget: false,
  touchPhase: 'idle',
  ...overrides,
});

const primed = (): TrendDoubleTapState => {
  const first = down(idleTrendDoubleTap(), {
    pointerId: 1,
    clientX: 20,
    at: 0,
  }).state;
  return trendDoubleTapUp(first, 1, 40);
};

describe('Trends graph double tap', () => {
  it('clears only for a timely nearby second plot tap', () => {
    expect(down(primed())).toMatchObject({
      state: { phase: 'consuming', pointerId: 2 },
      effect: { kind: 'clear' },
    });
    expect(down(primed(), { at: 40 + TREND_DOUBLE_TAP_MS + 1 }).effect)
      .toEqual({ kind: 'none', reason: 'no-double' });
    expect(down(primed(), { clientX: 20 + TREND_DOUBLE_TAP_SLOP_PX + 1 }).effect)
      .toEqual({ kind: 'none', reason: 'no-double' });
  });

  it('does not prime after a touch moves beyond the tap tolerance', () => {
    const tracking = down(idleTrendDoubleTap(), {
      pointerId: 1,
      clientX: 20,
      at: 0,
    }).state;
    const moved = trendDoubleTapMove(tracking, {
      pointerId: 1,
      clientX: 20 + TREND_TAP_MOVE_PX + 1,
      clientY: 20,
    });
    expect(moved.phase).toBe('idle');
    expect(trendDoubleTapUp(moved, 1, 40).phase).toBe('idle');
    expect(down(moved).effect).toEqual({ kind: 'none', reason: 'first-tap' });
  });

  it('does not consume a double tap when no selection can be cleared', () => {
    expect(down(primed(), { clearable: false })).toMatchObject({
      state: { phase: 'tracking', pointerId: 2 },
      effect: { kind: 'none', reason: 'no-selection' },
    });
  });

  it('rejects barcode, interactive, and non-idle touch states', () => {
    expect(down(primed(), { zone: 'other' }).effect)
      .toEqual({ kind: 'none', reason: 'not-plot' });
    expect(down(primed(), { interactiveTarget: true }).effect)
      .toEqual({ kind: 'none', reason: 'interactive' });
    for (const touchPhase of ['reading', 'anchored', 'ranging', 'spent'] as const) {
      expect(down(primed(), { touchPhase }).effect)
        .toEqual({ kind: 'none', reason: 'not-idle' });
    }
  });

  it('keeps the double-tap window below the range-hold threshold', () => {
    expect(TREND_DOUBLE_TAP_MS).toBeLessThan(TOUCH_RANGE_HOLD_MS);
  });
});
