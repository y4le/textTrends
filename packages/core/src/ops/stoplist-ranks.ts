import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import {
  STOPLIST_EN_ID,
  STOPLIST_EN_VERSION,
  STOPLIST_MAX_TOP_N,
  type StoplistResultV1,
  type StoplistSpecV1,
} from './stoplist-contract.ts';

/** Snapshot-bound lookup material supplied by the worker-only reference
 * builder. Keeping this contract separate prevents the 2,000-word payload
 * from entering main-thread bundles through the general core barrel. */
export interface StoplistRanksV1 {
  readonly snapshot: CorpusSnapshotV1['id'];
  /** Corpus type id -> one-based reference rank, or zero for no match. */
  readonly ranks: Uint16Array;
  /** Ranked reference words, used to report the selected prefix boundary. */
  readonly referenceWords: readonly string[];
}

export function validateStoplistRanks(
  snapshot: CorpusSnapshotV1,
  value: StoplistRanksV1,
): void {
  if (
    value.snapshot !== snapshot.id
    || value.ranks.length !== snapshot.vocabulary.keys.length
    || value.referenceWords.length !== STOPLIST_MAX_TOP_N
  ) {
    throw new RangeError('common-word ranks are bound to a different snapshot');
  }
}

export function stoplistResult(
  spec: StoplistSpecV1,
  ranks: StoplistRanksV1,
  removedRows: number,
): StoplistResultV1 {
  return {
    id: STOPLIST_EN_ID,
    version: STOPLIST_EN_VERSION,
    topN: spec.topN,
    removedRows,
    boundaryKey: ranks.referenceWords[spec.topN - 1]!,
  };
}
