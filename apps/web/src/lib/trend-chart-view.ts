import type { NumericTrend } from '@texttrends/core';
import type { SeriesIntent } from './app-state.ts';

export interface ReadySeries {
  readonly intent: SeriesIntent;
  readonly trend: NumericTrend;
  readonly ghost?: boolean;
}

export interface DisplayedSeries extends ReadySeries {
  readonly values: Float64Array;
  readonly rawValues: Float64Array;
}
