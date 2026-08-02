import type { NumericTrend } from '@texttrends/core';
import type {
  InventoryState,
  SeriesTrendState,
} from './store.ts';

export interface DocTokenSources {
  /** Snapshot-bound extents retained when the visible inventory becomes
   * range-scoped. This cache is authoritative for documents it contains. */
  readonly corpusTokenCounts?: ReadonlyMap<string, number>;
  readonly inventory: InventoryState | null;
  readonly trends: ReadonlyMap<string, SeriesTrendState>;
}

function validTokenCount(value: number | undefined): value is number {
  return value !== undefined
    && Number.isSafeInteger(value)
    && value >= 0;
}

function countFromTrend(doc: string, trend: NumericTrend): number | null {
  const ordinal = trend.order.indexOf(doc);
  if (ordinal < 0) return null;
  const count = trend.docTokenCount[ordinal];
  return validTokenCount(count) ? count : null;
}

/**
 * Resolve a document's full token extent without confusing a range-scoped
 * inventory row's `selectedTokens` with its selection-independent
 * `fullTokens`. Any resident row is authoritative for its document; retained
 * baseline trend geometry supplies extents for documents omitted by a
 * range-scoped inventory.
 */
export function fullTokensByDoc(
  doc: string,
  sources: DocTokenSources,
): number | null {
  const retained = sources.corpusTokenCounts?.get(doc);
  if (validTokenCount(retained)) return retained;

  const inventory = sources.inventory;
  if (
    inventory !== null
    && inventory.state.status === 'ready'
  ) {
    const row = inventory.state.result.documents.find((candidate) => candidate.doc === doc);
    if (row && validTokenCount(row.fullTokens)) return row.fullTokens;
  }

  for (const state of sources.trends.values()) {
    if (state.status !== 'ready') continue;
    const count = countFromTrend(doc, state.trend);
    if (count !== null) return count;
  }
  return null;
}

/** Resolve one ordered corpus geometry atomically. A partial answer is not
 * safe for aggregate row-cap validation, so any missing extent yields null. */
export function fullTokenCountsForDocs(
  docs: readonly string[],
  sources: DocTokenSources,
): readonly number[] | null {
  const counts = docs.map((doc) => fullTokensByDoc(doc, sources));
  return counts.some((count) => count === null)
    ? null
    : counts as readonly number[];
}
