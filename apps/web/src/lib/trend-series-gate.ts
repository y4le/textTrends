/** Shared readiness policy for trend lines that contribute to one y-scale. */

interface TrendSeriesState {
  readonly status: 'pending' | 'ready' | 'error';
}

/**
 * A comparison can paint only after every series contributing to its shared
 * scale settles and at least one foreground series is ready. Context failures
 * are omitted; a foreground-only failure leaves the graph unavailable.
 */
export function trendSeriesGate(
  foreground: readonly (TrendSeriesState | undefined)[],
  context: readonly (TrendSeriesState | undefined)[],
): 'pending' | 'unavailable' | 'ready' {
  if ([...foreground, ...context].some((state) => !state || state.status === 'pending')) {
    return 'pending';
  }
  return foreground.some((state) => state?.status === 'ready') ? 'ready' : 'unavailable';
}
