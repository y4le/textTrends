import { exactRecord, isNonNegSafeInt } from '../contract/guards.ts';

export const STOPLIST_EN_ID = 'english-common-words/1' as const;
export const STOPLIST_EN_VERSION = 1 as const;
export const STOPLIST_MAX_TOP_N = 2_000;

export interface StoplistSpecV1 {
  readonly id: typeof STOPLIST_EN_ID;
  readonly version: typeof STOPLIST_EN_VERSION;
  /** One-based ranked prefix depth. Absence of the spec means the filter is off. */
  readonly topN: number;
}

export interface StoplistResultV1 extends StoplistSpecV1 {
  /** Rows that passed every other row filter but matched the ranked prefix. */
  readonly removedRows: number;
  /** The reference word at rank `topN`. */
  readonly boundaryKey: string;
}

export function isStoplistSpecV1(value: unknown): value is StoplistSpecV1 {
  return exactRecord(value, ['id', 'version', 'topN'])
    && value.id === STOPLIST_EN_ID
    && value.version === STOPLIST_EN_VERSION
    && isNonNegSafeInt(value.topN)
    && value.topN >= 1
    && value.topN <= STOPLIST_MAX_TOP_N;
}
