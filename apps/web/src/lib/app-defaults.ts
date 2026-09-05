import {
  TREND_RATE_DENOMINATOR,
  type TrendBinsSpecV1,
  type WorkspaceTrendMeasureV1,
} from '@texttrends/core';
import type { KeynessViewV1 } from './app-state.ts';

export const DEFAULT_TREND_BINS: TrendBinsSpecV1 = Object.freeze({
  mode: 'per-doc',
  count: 40,
});

export const DEFAULT_TREND_MEASURE: WorkspaceTrendMeasureV1 = Object.freeze({
  kind: 'rate',
  denominator: TREND_RATE_DENOMINATOR,
  smoothing: 0,
  showRaw: false,
});

export const DEFAULT_KEYNESS_VIEW: KeynessViewV1 = Object.freeze({
  schema: 'texttrends/keyness-view/1',
  mode: 'document-rest',
  documentA: null,
  documentB: null,
  restOn: 'b',
  minCountTotal: 5,
  minDocFreqTotal: 2,
  classes: Object.freeze(['lexical'] as const),
  stoplistTopN: 0,
  sort: Object.freeze({
    by: 'logRatio' as const,
    dirA: -1 as const,
    dirB: 1 as const,
  }),
  showConfidenceIntervals: false,
  pageLimit: 100,
});
