/**
 * Trend kernel — Phase 1 Milestone 3; method `trend/1` (statistics.md).
 *
 * Semantics (fixing plan §d.7's open edges):
 * - Bins RESTART per document in every coordinate. `document-relative` and
 *   `declared-sequence` both partition each selected document into
 *   equal-token bins; `declared-sequence` differs only in the echoed sequence
 *   bases (the x-coordinate offset). The bin partition is an orthogonal
 *   request: either a fixed number of bins per document or a fixed token span.
 * - An occurrence is assigned to a bin by its START token (plan decision).
 * - When the selection has token ranges, `binTokens` counts only SELECTED
 *   tokens within the bin's span — the denominator never claims unselected
 *   text. Bins with zero selected tokens report rate 0 with binTokens 0.
 * - Output is unsmoothed raw counts + per-10k rates with true denominators;
 *   smoothing is a presentation-layer overlay (statistics.md §Smoothing).
 */

import type { NumericOccurrences } from './occurrences.ts';
import type { ProjectDocId } from '../contract/brands.ts';
import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { ResolvedSelection } from '../snapshot/selection.ts';

export type TrendCoordinate = 'document-relative' | 'declared-sequence';

export type TrendBinMode = 'per-doc' | 'fixed-tokens';

export interface TrendBinsSpecV1 {
  readonly mode: TrendBinMode;
  /** Bins per document under `per-doc`; tokens per bin under `fixed-tokens`. */
  readonly count: number;
}

export const TREND_PER_DOC_MIN = 4;
export const TREND_PER_DOC_MAX = 200;
export const TREND_FIXED_TOKENS_MIN = 250;
export const TREND_FIXED_TOKENS_MAX = 50_000;
/** Bound SVG point count, not merely typed-array memory. */
export const TREND_MAX_ROWS = 4_000;

export interface TrendRequest {
  readonly coordinate: TrendCoordinate;
  readonly bins: TrendBinsSpecV1;
}

export interface NumericTrend {
  readonly coordinate: TrendCoordinate;
  /** Verbatim, owned echo of the partition that produced this result. */
  readonly bins: TrendBinsSpecV1;
  /** Length `order.length + 1`; rows for document d are the half-open span
   *  `[rowOffsets[d], rowOffsets[d + 1])`. */
  readonly rowOffsets: Uint32Array;
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
  if (request.coordinate !== 'document-relative' && request.coordinate !== 'declared-sequence') {
    throw new RangeError(`unknown trend coordinate '${String(request.coordinate)}'`);
  }
  const bins = request.bins;
  if (bins.mode !== 'per-doc' && bins.mode !== 'fixed-tokens') {
    throw new RangeError(`unknown trend bin mode '${String(bins.mode)}'`);
  }
  const min = bins.mode === 'per-doc' ? TREND_PER_DOC_MIN : TREND_FIXED_TOKENS_MIN;
  const max = bins.mode === 'per-doc' ? TREND_PER_DOC_MAX : TREND_FIXED_TOKENS_MAX;
  if (!Number.isInteger(bins.count) || bins.count < min || bins.count > max) {
    const unit = bins.mode === 'per-doc' ? 'bins per document' : 'tokens per bin';
    throw new RangeError(`${unit} must be an integer from ${min} to ${max}`);
  }

  const selectedTokensIn = (doc: ProjectDocId, from: number, to: number, tokenCount: number): number => {
    const ranges = selection.rangesByDoc.get(doc);
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
  const rowOffsets: number[] = [0];
  const sequenceBases: number[] = [];
  const docTokenCount: number[] = [];

  let requestedRows = 0;
  for (const ref of snapshot.docs) {
    if (!selection.docSet.has(ref.doc) || ref.tokenCount === 0) continue;
    requestedRows += bins.mode === 'per-doc'
      ? bins.count
      : Math.ceil(ref.tokenCount / bins.count);
  }
  if (requestedRows > TREND_MAX_ROWS) {
    throw new RangeError(
      `trend request would produce ${requestedRows} rows; the limit is ${TREND_MAX_ROWS}`,
    );
  }

  // Row layout per selected document, then per bin — declared order.
  const rowBase = new Map<number, number>(); // snapshot doc ordinal -> first row
  const rowsByOrdinal = new Map<number, number>();
  const widthByOrdinal = new Map<number, number>();
  for (let ord = 0; ord < snapshot.docs.length; ord++) {
    const ref = snapshot.docs[ord]!;
    if (!selection.docSet.has(ref.doc)) continue;
    order.push(ref.doc);
    sequenceBases.push(ref.sequenceTokenBase);
    docTokenCount.push(ref.tokenCount);
    rowBase.set(ord, docOrdinal.length);
    const tokens = ref.tokenCount;
    const rows = tokens === 0
      ? 0
      : bins.mode === 'per-doc'
        ? bins.count
        : Math.ceil(tokens / bins.count);
    const width = tokens === 0
      ? 0
      : bins.mode === 'per-doc'
        ? Math.ceil(tokens / bins.count)
        : bins.count;
    rowsByOrdinal.set(ord, rows);
    widthByOrdinal.set(ord, width);
    for (let b = 0; b < rows; b++) {
      const from = b * width;
      const to = Math.min(tokens, (b + 1) * width);
      docOrdinal.push(ord);
      binIndex.push(b);
      binStartToken.push(Math.min(from, tokens));
      binTokens.push(width === 0 ? 0 : selectedTokensIn(ref.doc, from, to, tokens));
      count.push(0);
    }
    rowOffsets.push(docOrdinal.length);
  }

  // Assign occurrences by start token.
  for (let i = 0; i < occ.pos.length; i++) {
    const ord = occ.docOrdinal[i] as number;
    const base = rowBase.get(ord);
    if (base === undefined) continue; // occurrence outside the selection's docs
    const rows = rowsByOrdinal.get(ord) ?? 0;
    const width = widthByOrdinal.get(ord) ?? 0;
    if (width === 0 || rows === 0) continue;
    const b = Math.min(rows - 1, Math.floor((occ.pos[i] as number) / width));
    const row = base + b;
    count[row] = (count[row] as number) + 1;
  }

  const ratePer10k = Float64Array.from(count, (c, i) => {
    const denom = binTokens[i] as number;
    return denom === 0 ? 0 : (c / denom) * 10_000;
  });

  return {
    coordinate: request.coordinate,
    bins: Object.freeze({ mode: bins.mode, count: bins.count }),
    rowOffsets: Uint32Array.from(rowOffsets),
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
