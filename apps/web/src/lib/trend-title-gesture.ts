export const TREND_TITLE_DRAG_PX = 4;

export type TrendTitleFocusMove = 'previous' | 'next' | 'first' | 'last';

/** Resolve one roving-tabstop move while skipping texts that cannot be
 * selected. Focus does not wrap: reading-order boundaries stay meaningful. */
export function nextTrendTitleFocus(
  current: number,
  move: TrendTitleFocusMove,
  enabled: readonly boolean[],
): number | null {
  if (enabled.length === 0) return null;
  if (move === 'first') {
    const first = enabled.findIndex(Boolean);
    return first >= 0 ? first : null;
  }
  if (move === 'last') {
    const last = enabled.findLastIndex(Boolean);
    return last >= 0 ? last : null;
  }
  const delta = move === 'previous' ? -1 : 1;
  for (let ordinal = current + delta; ordinal >= 0 && ordinal < enabled.length; ordinal += delta) {
    if (enabled[ordinal]) return ordinal;
  }
  return enabled[current] ? current : null;
}

export type TrendTitleGesture =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'pressed';
      readonly pointerId: number;
      readonly anchor: number;
      readonly head: number;
      readonly downX: number;
      readonly downY: number;
      readonly dragging: boolean;
    };

export type TrendTitleEffect =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'preview';
      readonly anchor: number;
      readonly head: number;
    }
  | {
      readonly kind: 'commit';
      readonly anchor: number;
      readonly head: number;
      readonly dragged: boolean;
    }
  | { readonly kind: 'cancel' };

export interface TrendTitleTransition {
  readonly state: TrendTitleGesture;
  readonly effect: TrendTitleEffect;
}

export const idleTrendTitleGesture = (): TrendTitleGesture => ({ phase: 'idle' });

export function trendTitleDown(
  pointerId: number,
  ordinal: number,
  clientX: number,
  clientY: number,
): TrendTitleTransition {
  return {
    state: {
      phase: 'pressed',
      pointerId,
      anchor: ordinal,
      head: ordinal,
      downX: clientX,
      downY: clientY,
      dragging: false,
    },
    effect: { kind: 'none' },
  };
}

export function trendTitleMove(
  state: TrendTitleGesture,
  input: {
    readonly pointerId: number;
    readonly ordinal: number | null;
    readonly clientX: number;
    readonly clientY: number;
  },
): TrendTitleTransition {
  if (state.phase !== 'pressed' || state.pointerId !== input.pointerId) {
    return { state, effect: { kind: 'none' } };
  }
  const dragging = state.dragging || Math.hypot(
    input.clientX - state.downX,
    input.clientY - state.downY,
  ) >= TREND_TITLE_DRAG_PX;
  const next: TrendTitleGesture = {
    ...state,
    head: input.ordinal ?? state.head,
    dragging,
  };
  return {
    state: next,
    effect: dragging
      ? { kind: 'preview', anchor: next.anchor, head: next.head }
      : { kind: 'none' },
  };
}

export function trendTitleUp(
  state: TrendTitleGesture,
  pointerId: number,
): TrendTitleTransition {
  if (state.phase !== 'pressed' || state.pointerId !== pointerId) {
    return { state, effect: { kind: 'none' } };
  }
  return {
    state: idleTrendTitleGesture(),
    effect: {
      kind: 'commit',
      anchor: state.anchor,
      head: state.head,
      dragged: state.dragging,
    },
  };
}

export function resetTrendTitleGesture(
  state: TrendTitleGesture,
): TrendTitleTransition {
  return {
    state: idleTrendTitleGesture(),
    effect: state.phase === 'pressed' ? { kind: 'cancel' } : { kind: 'none' },
  };
}
