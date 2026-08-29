export type TrendRowDetentMode = 'above' | 'held' | 'below';

export interface TrendRowDetentState {
  readonly mode: TrendRowDetentMode;
  readonly anchorY: number;
  readonly lastY: number;
}

export interface TrendRowDetentInput {
  readonly clientY: number;
  readonly requestedPitch: number;
  readonly minPitch: number;
  readonly inkPitch: number;
  readonly coarse: boolean;
}

export interface TrendRowDetentTransition {
  readonly state: TrendRowDetentState;
  readonly pitch: number;
  readonly hint: 'hide' | 'restore' | null;
}

/** The collapse commitment scales with the height removed, but stays small
 * enough for deliberate mouse and touch gestures. */
export function trendRowBreakaway(miniExtent: number, coarse: boolean): number {
  const extent = Number.isFinite(miniExtent) ? Math.max(0, miniExtent) : 0;
  return Math.max(
    coarse ? 10 : 6,
    Math.min(coarse ? 24 : 16, extent),
  );
}

export function beginTrendRowDetent(
  rowPitch: number,
  minPitch: number,
  clientY: number,
): TrendRowDetentState {
  return Object.freeze({
    mode: rowPitch <= minPitch ? 'below' : 'above',
    anchorY: clientY,
    lastY: clientY,
  });
}

/**
 * Hold at the miniature barcode stop before removing or restoring the band.
 * Upward pointer travel squeezes rows; downward travel expands them.
 */
export function moveTrendRowDetent(
  state: TrendRowDetentState,
  input: TrendRowDetentInput,
): TrendRowDetentTransition {
  const { clientY, requestedPitch, minPitch, inkPitch, coarse } = input;
  if (inkPitch <= minPitch) {
    return Object.freeze({
      state: beginTrendRowDetent(requestedPitch, minPitch, clientY),
      pitch: requestedPitch,
      hint: null,
    });
  }
  const breakaway = trendRowBreakaway(inkPitch - minPitch, coarse);
  if (state.mode === 'below') {
    const restoring = clientY > state.lastY;
    if (clientY - state.anchorY >= breakaway) {
      return Object.freeze({
        state: Object.freeze({ mode: 'above', anchorY: clientY, lastY: clientY }),
        pitch: inkPitch,
        hint: null,
      });
    }
    return Object.freeze({
      state: Object.freeze({ ...state, lastY: clientY }),
      pitch: minPitch,
      hint: restoring ? 'restore' : null,
    });
  }

  if (state.mode === 'held') {
    if (requestedPitch >= inkPitch || clientY > state.anchorY) {
      return Object.freeze({
        state: Object.freeze({ mode: 'above', anchorY: clientY, lastY: clientY }),
        pitch: Math.max(inkPitch, requestedPitch),
        hint: null,
      });
    }
    if (state.anchorY - clientY >= breakaway) {
      return Object.freeze({
        state: Object.freeze({ mode: 'below', anchorY: clientY, lastY: clientY }),
        pitch: minPitch,
        hint: null,
      });
    }
    return Object.freeze({
      state: Object.freeze({ ...state, lastY: clientY }),
      pitch: inkPitch,
      hint: 'hide',
    });
  }

  if (requestedPitch >= inkPitch) {
    return Object.freeze({
      state: Object.freeze({ ...state, lastY: clientY }),
      pitch: requestedPitch,
      hint: null,
    });
  }
  // After a restoration, continued downward travel must not immediately
  // re-arm the collapse merely because the raw pointer pitch is still inside
  // the sizing authority's unreachable interval.
  if (clientY >= state.lastY) {
    return Object.freeze({
      state: Object.freeze({ ...state, lastY: clientY }),
      pitch: inkPitch,
      hint: null,
    });
  }
  // The caller clamps requestedPitch at minPitch. When a one-frame flick is
  // larger than the reachable mini extent but smaller than breakaway, this
  // deliberately enters held; one further move completes the commitment.
  const crossingY = clientY + inkPitch - requestedPitch;
  if (crossingY - clientY >= breakaway) {
    return Object.freeze({
      state: Object.freeze({ mode: 'below', anchorY: clientY, lastY: clientY }),
      pitch: minPitch,
      hint: null,
    });
  }
  return Object.freeze({
    state: Object.freeze({ mode: 'held', anchorY: crossingY, lastY: clientY }),
    pitch: inkPitch,
    hint: 'hide',
  });
}

export function stepTrendRowPitch(
  currentPitch: number,
  direction: -1 | 1,
  step: number,
  stops: {
    readonly minPitch: number;
    readonly inkPitch: number;
    readonly maxPitch: number;
  },
): number {
  if (direction < 0) {
    if (currentPitch === stops.inkPitch && stops.minPitch < stops.inkPitch) {
      return stops.minPitch;
    }
    const requested = Math.max(stops.minPitch, currentPitch - step);
    if (currentPitch > stops.inkPitch && requested < stops.inkPitch) {
      return stops.inkPitch;
    }
    return requested;
  }
  if (currentPitch === stops.minPitch && stops.minPitch < stops.inkPitch) {
    return stops.inkPitch;
  }
  return Math.min(stops.maxPitch, currentPitch + step);
}
