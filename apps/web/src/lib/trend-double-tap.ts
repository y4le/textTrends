export const TREND_DOUBLE_TAP_MS = 300;
export const TREND_DOUBLE_TAP_SLOP_PX = 24;
export const TREND_TAP_MOVE_PX = 8;

export type TrendDoubleTapState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'tracking';
      readonly pointerId: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly phase: 'primed'; readonly at: number; readonly x: number; readonly y: number }
  | { readonly phase: 'consuming'; readonly pointerId: number };

export type TrendDoubleTapEffect =
  | { readonly kind: 'clear' }
  | {
      readonly kind: 'none';
      readonly reason:
        | 'first-tap'
        | 'no-double'
        | 'no-selection'
        | 'not-plot'
        | 'interactive'
        | 'not-idle';
    };

export interface TrendDoubleTapTransition {
  readonly state: TrendDoubleTapState;
  readonly effect: TrendDoubleTapEffect;
}

export const idleTrendDoubleTap = (): TrendDoubleTapState => ({ phase: 'idle' });

export function trendDoubleTapDown(
  state: TrendDoubleTapState,
  input: {
    readonly pointerId: number;
    readonly clientX: number;
    readonly clientY: number;
    readonly at: number;
    readonly zone: 'plot' | 'other';
    readonly clearable: boolean;
    readonly interactiveTarget: boolean;
    readonly touchPhase: 'idle' | 'reading' | 'anchored' | 'ranging' | 'spent';
  },
): TrendDoubleTapTransition {
  if (input.zone !== 'plot') {
    return { state: idleTrendDoubleTap(), effect: { kind: 'none', reason: 'not-plot' } };
  }
  if (input.interactiveTarget) {
    return { state: idleTrendDoubleTap(), effect: { kind: 'none', reason: 'interactive' } };
  }
  if (input.touchPhase !== 'idle') {
    return { state: idleTrendDoubleTap(), effect: { kind: 'none', reason: 'not-idle' } };
  }
  const doubleTap = state.phase === 'primed'
    && input.at - state.at >= 0
    && input.at - state.at <= TREND_DOUBLE_TAP_MS
    && Math.hypot(input.clientX - state.x, input.clientY - state.y)
      <= TREND_DOUBLE_TAP_SLOP_PX;
  if (doubleTap && input.clearable) {
    return {
      state: { phase: 'consuming', pointerId: input.pointerId },
      effect: { kind: 'clear' },
    };
  }
  return {
    state: {
      phase: 'tracking',
      pointerId: input.pointerId,
      x: input.clientX,
      y: input.clientY,
    },
    effect: {
      kind: 'none',
      reason: doubleTap
        ? 'no-selection'
        : state.phase === 'primed' ? 'no-double' : 'first-tap',
    },
  };
}

export function trendDoubleTapMove(
  state: TrendDoubleTapState,
  input: { readonly pointerId: number; readonly clientX: number; readonly clientY: number },
): TrendDoubleTapState {
  if (state.phase !== 'tracking' || state.pointerId !== input.pointerId) return state;
  return Math.hypot(input.clientX - state.x, input.clientY - state.y) > TREND_TAP_MOVE_PX
    ? idleTrendDoubleTap()
    : state;
}

export function trendDoubleTapUp(
  state: TrendDoubleTapState,
  pointerId: number,
  at: number,
): TrendDoubleTapState {
  if (state.phase === 'tracking' && state.pointerId === pointerId) {
    return { phase: 'primed', at, x: state.x, y: state.y };
  }
  if (state.phase === 'consuming' && state.pointerId === pointerId) {
    return idleTrendDoubleTap();
  }
  return state;
}

export function trendDoubleTapCancel(
  state: TrendDoubleTapState,
  pointerId: number,
): TrendDoubleTapState {
  return (
    (state.phase === 'tracking' || state.phase === 'consuming')
    && state.pointerId === pointerId
  )
    ? idleTrendDoubleTap()
    : state;
}
