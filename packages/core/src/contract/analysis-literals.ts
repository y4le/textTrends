/** One authority for closed analytical vocabularies at kernel, wire and save boundaries. */
import { exactRecord } from './guards.ts';

export const FREQUENCY_TOKEN_CLASSES_V1 = ['lexical', 'numeral'] as const;
export const FREQUENCY_SORT_FIELDS_V1 = ['count', 'docFreq', 'dp', 'dpNorm', 'ratePer10k', 'class', 'key'] as const;
export const KEYNESS_SORT_FIELDS_V1 = ['logRatio', 'logRatioLow', 'g2', 'countA', 'countB'] as const;
export const TREND_COORDINATES = ['document-relative', 'declared-sequence'] as const;
export const TREND_BIN_MODES = ['per-doc', 'fixed-tokens'] as const;
export type FrequencyTokenClassV1 = typeof FREQUENCY_TOKEN_CLASSES_V1[number];
export type FrequencySortFieldV1 = typeof FREQUENCY_SORT_FIELDS_V1[number];
export type KeynessSortFieldV1 = typeof KEYNESS_SORT_FIELDS_V1[number];
export type TrendCoordinate = typeof TREND_COORDINATES[number];
export type TrendBinMode = typeof TREND_BIN_MODES[number];

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}
export const isFrequencyTokenClass = (value: unknown): value is FrequencyTokenClassV1 => member(FREQUENCY_TOKEN_CLASSES_V1, value);
export const isFrequencySortField = (value: unknown): value is FrequencySortFieldV1 => member(FREQUENCY_SORT_FIELDS_V1, value);
export const isKeynessSortField = (value: unknown): value is KeynessSortFieldV1 => member(KEYNESS_SORT_FIELDS_V1, value);
export const isTrendCoordinate = (value: unknown): value is TrendCoordinate => member(TREND_COORDINATES, value);

export const TREND_PER_DOC_MIN = 4;
export const TREND_PER_DOC_MAX = 200;
export const TREND_FIXED_TOKENS_MIN = 250;
export const TREND_FIXED_TOKENS_MAX = 50_000;
export interface TrendBinsSpecV1 {
  readonly mode: TrendBinMode;
  readonly count: number;
}
export function isTrendBins(value: unknown): value is TrendBinsSpecV1 {
  if (!exactRecord(value, ['mode', 'count']) || !Number.isSafeInteger(value.count)) return false;
  return value.mode === 'per-doc'
    ? (value.count as number) >= TREND_PER_DOC_MIN && (value.count as number) <= TREND_PER_DOC_MAX
    : value.mode === 'fixed-tokens' && (value.count as number) >= TREND_FIXED_TOKENS_MIN && (value.count as number) <= TREND_FIXED_TOKENS_MAX;
}
