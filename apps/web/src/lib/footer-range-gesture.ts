import type { SelectionPoint } from './selection.ts';

export const FOOTER_RANGE_DOUBLE_PRESS_MS = 500;
export const FOOTER_RANGE_DOUBLE_PRESS_SLOP_PX = 6;
export const FOOTER_RANGE_DRAG_PX = 4;
export const FOOTER_RANGE_SUPPRESSION_MS = 500;

export type FooterStripZone = 'graph' | 'barcode' | 'outside';

export interface FooterStripGeometry {
  readonly stripHeight: number;
  readonly stripTop: number;
  readonly seriesHeight: number;
  readonly barcodeBandGap: number;
  readonly trackCount: number;
}

/** The graph owns the strip's top padding and the gap before the first barcode
 * row, keeping the thin sparkline target usable. Without barcode rows the
 * complete strip is graph. */
export function footerStripZone(
  y: number,
  geometry: FooterStripGeometry,
): FooterStripZone {
  if (!Number.isFinite(y) || y < 0 || y >= geometry.stripHeight) return 'outside';
  if (geometry.trackCount <= 0) return 'graph';
  const graphBottom = geometry.stripTop
    + geometry.seriesHeight
    + geometry.barcodeBandGap;
  return y < graphBottom ? 'graph' : 'barcode';
}

export type FooterRangeGesture =
  | { readonly phase: 'idle' }
  | { readonly phase: 'primed'; readonly at: number; readonly x: number; readonly y: number }
  | {
      readonly phase: 'armed';
      readonly pointerId: number;
      readonly origin: SelectionPoint;
      readonly downX: number;
      readonly downY: number;
    }
  | {
      readonly phase: 'brushing';
      readonly pointerId: number;
      readonly origin: SelectionPoint;
      readonly head: SelectionPoint;
    };

export type FooterRangeEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'preview'; readonly origin: SelectionPoint; readonly head: SelectionPoint }
  | { readonly kind: 'commit'; readonly origin: SelectionPoint; readonly head: SelectionPoint }
  | { readonly kind: 'cancel' };

export interface FooterRangeTransition {
  readonly state: FooterRangeGesture;
  readonly effect: FooterRangeEffect;
}

export const idleFooterRangeGesture = (): FooterRangeGesture => ({ phase: 'idle' });

export function primeFooterRangeGesture(
  at: number,
  x: number,
  y: number,
): FooterRangeGesture {
  return { phase: 'primed', at, x, y };
}

export function footerRangeDown(
  state: FooterRangeGesture,
  input: {
    readonly zone: FooterStripZone;
    readonly pointerId: number;
    readonly point: SelectionPoint | null;
    readonly clientX: number;
    readonly clientY: number;
    readonly at: number;
    readonly suppressed: boolean;
    readonly recentDirectPointer: boolean;
  },
): FooterRangeTransition {
  const primed = state.phase === 'primed'
    && input.at - state.at >= 0
    && input.at - state.at <= FOOTER_RANGE_DOUBLE_PRESS_MS
    && Math.hypot(input.clientX - state.x, input.clientY - state.y)
      <= FOOTER_RANGE_DOUBLE_PRESS_SLOP_PX;
  if (
    input.zone !== 'graph'
    || input.point === null
    || input.suppressed
    || input.recentDirectPointer
    || !primed
  ) {
    return { state: idleFooterRangeGesture(), effect: { kind: 'none' } };
  }
  return {
    state: {
      phase: 'armed',
      pointerId: input.pointerId,
      origin: input.point,
      downX: input.clientX,
      downY: input.clientY,
    },
    effect: { kind: 'clear' },
  };
}

export function footerRangeMove(
  state: FooterRangeGesture,
  input: {
    readonly pointerId: number;
    readonly point: SelectionPoint | null;
    readonly clientX: number;
    readonly clientY: number;
  },
): FooterRangeTransition {
  if (
    (state.phase !== 'armed' && state.phase !== 'brushing')
    || state.pointerId !== input.pointerId
    || input.point === null
  ) return { state, effect: { kind: 'none' } };
  if (
    state.phase === 'armed'
    && Math.hypot(input.clientX - state.downX, input.clientY - state.downY)
      < FOOTER_RANGE_DRAG_PX
  ) return { state, effect: { kind: 'none' } };
  const next: FooterRangeGesture = {
    phase: 'brushing',
    pointerId: state.pointerId,
    origin: state.origin,
    head: input.point,
  };
  return {
    state: next,
    effect: { kind: 'preview', origin: next.origin, head: next.head },
  };
}

export function footerRangeUp(
  state: FooterRangeGesture,
  pointerId: number,
): FooterRangeTransition {
  if (
    (state.phase !== 'armed' && state.phase !== 'brushing')
    || state.pointerId !== pointerId
  ) return { state, effect: { kind: 'none' } };
  return state.phase === 'brushing'
    ? {
        state: idleFooterRangeGesture(),
        effect: { kind: 'commit', origin: state.origin, head: state.head },
      }
    : { state: idleFooterRangeGesture(), effect: { kind: 'none' } };
}

export function resetFooterRangeGesture(
  state: FooterRangeGesture,
): FooterRangeTransition {
  return {
    state: idleFooterRangeGesture(),
    effect: state.phase === 'brushing' ? { kind: 'cancel' } : { kind: 'none' },
  };
}
