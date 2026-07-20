/**
 * Trend kernel — Phase 1 Milestone 3; method `trend/1` (statistics.md).
 *
 * Semantics (fixing plan §d.7's open edges):
 * - Bins RESTART per document in every coordinate. `document-relative` and
 *   `declared-sequence` both partition each selected document into
 *   `binsPerDoc` equal-token bins; `declared-sequence` differs only in the
 *   echoed sequence bases (the x-coordinate offset). `document-token` (fixed
 *   width) is deferred.
 * - An occurrence is assigned to a bin by its START token (plan decision).
 * - When the selection has token ranges, `binTokens` counts only SELECTED
 *   tokens within the bin's span — the denominator never claims unselected
 *   text. Bins with zero selected tokens report rate 0 with binTokens 0.
 * - Output is unsmoothed raw counts + per-10k rates with true denominators;
 *   smoothing is a presentation-layer overlay (synthesis §8.7).
 */

import type { NumericOccurrences } from './occurrences.ts';
import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { ResolvedSelection } from '../snapshot/selection.ts';

export type TrendCoordinate = 'document-relative' | 'declared-sequence';

export interface TrendRequest {
  readonly coordinate: TrendCoordinate;
  readonly binsPerDoc: number;
}

export interface NumericTrend {
  readonly coordinate: TrendCoordinate;
  /** Parallel arrays: one entry per (selected doc, bin). */
  readonly docOrdinal: Uint32Array;
  readonly binIndex: Uint32Array;
  readonly binStartToken: Uint32Array;   // document-local
  readonly binTokens: Uint32Array;       // SELECTED tokens in the bin (true denominator)
  readonly count: Uint32Array;
  readonly ratePer10k: Float64Array;
  readonly order: readonly string[];
  /** Present ONLY for declared-sequence — the coordinate's semantic difference
   *  is exactly these x-offset bases; document-relative has none. */
  readonly sequenceBases: readonly number[] | null;
  /** Parallel to `order`: each document's full token extent. binTokens is the
   *  SELECTED denominator and cannot reconstruct coordinate geometry under
   *  ranged selections; sequence layouts need the true extent. */
  readonly docTokenCount: readonly number[];
}

export function trend(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  occ: NumericOccurrences,
  request: TrendRequest,
): NumericTrend {
  if (selection.snapshot !== snapshot.id) {
    throw new RangeError('selection is bound to a different snapshot');
  }
  if (occ.snapshot !== snapshot.id) {
    throw new RangeError('occurrences were computed under a different snapshot');
  }
  if (occ.selection !== selection.hash) {
    throw new RangeError('occurrences were computed under a different selection');
  }
  const bins = request.binsPerDoc;
  if (!Number.isInteger(bins) || bins <= 0) {
    throw new RangeError('binsPerDoc must be a positive integer');
  }
  if (request.coordinate !== 'document-relative' && request.coordinate !== 'declared-sequence') {
    throw new RangeError(`unknown trend coordinate '${String(request.coordinate)}'`);
  }

  const selectedRanges = new Map<string, readonly { start: number; end: number }[]>();
  for (const r of selection.spec.ranges ?? []) {
    const list = selectedRanges.get(r.doc) ?? [];
    selectedRanges.set(r.doc, [...list, { start: r.tokens.start, end: r.tokens.end }]);
  }
  const selectedTokensIn = (doc: string, from: number, to: number, tokenCount: number): number => {
    const ranges = selectedRanges.get(doc);
    if (!ranges) return Math.max(0, Math.min(to, tokenCount) - from);
    let n = 0;
    for (const r of ranges) {
      n += Math.max(0, Math.min(to, r.end) - Math.max(from, r.start));
    }
    return n;
  };

  const docOrdinal: number[] = [];
  const binIndex: number[] = [];
  const binStartToken: number[] = [];
  const binTokens: number[] = [];
  const count: number[] = [];
  const order: string[] = [];
  const sequenceBases: number[] = [];
  const docTokenCount: number[] = [];

  // Row layout per selected document, then per bin — declared order.
  const rowBase = new Map<number, number>(); // snapshot doc ordinal -> first row
  for (let ord = 0; ord < snapshot.docs.length; ord++) {
    const ref = snapshot.docs[ord]!;
    if (!selection.spec.docs.includes(ref.doc)) continue;
    order.push(ref.doc);
    sequenceBases.push(ref.sequenceTokenBase);
    docTokenCount.push(ref.tokenCount);
    rowBase.set(ord, docOrdinal.length);
    const tokens = ref.tokenCount;
    const width = tokens === 0 ? 0 : Math.ceil(tokens / bins);
    for (let b = 0; b < bins; b++) {
      const from = b * width;
      const to = Math.min(tokens, (b + 1) * width);
      docOrdinal.push(ord);
      binIndex.push(b);
      binStartToken.push(Math.min(from, tokens));
      binTokens.push(width === 0 ? 0 : selectedTokensIn(ref.doc, from, to, tokens));
      count.push(0);
    }
  }

  // Assign occurrences by start token.
  for (let i = 0; i < occ.pos.length; i++) {
    const ord = occ.docOrdinal[i] as number;
    const base = rowBase.get(ord);
    if (base === undefined) continue; // occurrence outside the selection's docs
    const ref = snapshot.docs[ord]!;
    const tokens = ref.tokenCount;
    const width = tokens === 0 ? 0 : Math.ceil(tokens / bins);
    if (width === 0) continue;
    const b = Math.min(bins - 1, Math.floor((occ.pos[i] as number) / width));
    const row = base + b;
    count[row] = (count[row] as number) + 1;
  }

  const ratePer10k = Float64Array.from(count, (c, i) => {
    const denom = binTokens[i] as number;
    return denom === 0 ? 0 : (c / denom) * 10_000;
  });

  return {
    coordinate: request.coordinate,
    docOrdinal: Uint32Array.from(docOrdinal),
    binIndex: Uint32Array.from(binIndex),
    binStartToken: Uint32Array.from(binStartToken),
    binTokens: Uint32Array.from(binTokens),
    count: Uint32Array.from(count),
    ratePer10k,
    order,
    sequenceBases: request.coordinate === 'declared-sequence' ? sequenceBases : null,
    docTokenCount,
  };
}
