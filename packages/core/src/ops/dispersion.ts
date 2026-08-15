/**
 * dispersion/1 — the barcode's bounded numeric result (slice-2 ruling §1/§C).
 *
 * A dispersion result is a VISUALIZATION projection over the same
 * `NumericOccurrences` the trend/Matches branches consume — it never resolves
 * members or interprets overlap semantics itself, and it never exposes an
 * unbounded "dump every occurrence" transport. Representation is adaptive
 * PER TRACK:
 *
 * - EXACT (≤ DISPERSION_EXACT_MAX occurrences): document-local start
 *   positions AND spans, CSR-grouped by selected document — a clicked
 *   phrase/merged occurrence is an exact span, not a point.
 * - DENSITY (above the threshold): HONEST bucket counts over a shared
 *   geometry — never sampled, never silently dropped; bucket sums equal the
 *   exact total. One bucket is never renderable as one occurrence.
 *
 * Bucket geometry stays in FULL document coordinates even for a ranged
 *   selection (counts reflect only selected occurrences), so a selected
 *   layer aligns with the unchanged overview axis. The budget
 *   (DISPERSION_BUCKET_BUDGET) is allocated across the selected documents —
 *   ≥1 bucket per nonempty document, remainder token-proportional; the
 *   selection width is bounded by the 64-doc project cap, so the geometry is
 *   bounded by construction.
 *
 * Packing is STEPPED: `packDispersion` awaits the injected checkpoint every
 * `DISPERSION_PACK_CHUNK` occurrences, preserving the cancellation
 * discipline over million-occurrence tracks. All output arrays are FRESH —
 * a caller may transfer them without detaching any cache's buffers.
 */

import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { ResolvedSelection } from '../snapshot/selection.ts';
import type { NumericOccurrences } from './occurrences.ts';

/** A track at or under this many occurrences returns exact positions. */
export const DISPERSION_EXACT_MAX = 50_000;
/** Total density buckets allocated across the selected documents. */
export const DISPERSION_BUCKET_BUDGET = 4_096;
/** Checkpoint cadence while packing density counts. */
export const DISPERSION_PACK_CHUNK = 65_536;

export interface DispersionGeometryV1 {
  /** Selected documents, selection order — the axis row order. */
  readonly order: readonly string[];
  /** FULL per-document token extents (never range-clipped). */
  readonly docTokenCount: Uint32Array;
  /** CSR: bucket index range per document (length = order.length + 1). */
  readonly bucketOffsets: Uint32Array;
  /** Per-bucket document-local start token. A document's bucket b spans
   *  [start[b], start[b+1]) — its last bucket ends at the doc extent. */
  readonly bucketStartToken: Uint32Array;
}

export type DispersionTrackDataV1 =
  | {
      readonly kind: 'exact';
      /** CSR: occurrence index range per selected doc (order-aligned). */
      readonly docOffsets: Uint32Array;
      /** Document-local start tokens, source order/multiplicity preserved. */
      readonly starts: Uint32Array;
      readonly spanTokens: Uint32Array;
    }
  | {
      readonly kind: 'density';
      /** Per-bucket counts aligned to the shared geometry axis. */
      readonly counts: Uint32Array;
    };

export interface DispersionTrackV1 {
  readonly seriesId: string;
  readonly groupId: string;
  /** The EXACT occurrence total regardless of representation. */
  readonly total: number;
  readonly data: DispersionTrackDataV1;
}

export interface DispersionResultV1 {
  /** The versioned method/result discriminator (ruling: the operation is
   *  dispersion/1 on BOTH the request and the result, so future revisions
   *  never need to change the outer op). */
  readonly method: 'dispersion/1';
  /** Present when ANY track is density-represented; exact-only results carry
   *  no geometry (the strip derives layout from doc extents alone). */
  readonly geometry: DispersionGeometryV1 | null;
  readonly tracks: readonly DispersionTrackV1[];
}

/** The shared bucket geometry for a selection: ≥1 bucket per nonempty
 *  selected document, remainder token-proportional (largest-remainder), in
 *  FULL document coordinates. Pure and deterministic. */
export function planDispersionGeometry(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
): DispersionGeometryV1 {
  const order = selection.spec.docs;
  const extents = order.map((doc) => {
    const ref = snapshot.docs.find((r) => r.doc === doc);
    if (!ref) throw new RangeError(`'${doc}' is not a member of the snapshot`);
    return ref.tokenCount;
  });
  const nonempty = extents.filter((t) => t > 0).length;
  const budget = Math.max(DISPERSION_BUCKET_BUDGET, nonempty);
  // CONSTRAINED largest-remainder apportionment (review-C round 2): after the
  // 1-per-nonempty-doc minimum, the remaining budget is apportioned token-
  // proportionally among the docs that still have CAPACITY (extent − assigned),
  // weighted by their FULL extents; a pass that saturates a document frees its
  // overflow for the next pass. Terminates in ≤ docs passes; the final total
  // is exactly min(budget, total selected tokens).
  const buckets: number[] = extents.map((t) => (t > 0 ? 1 : 0));
  let remaining = budget - nonempty;
  while (remaining > 0) {
    const active: number[] = [];
    let activeTokens = 0;
    for (let i = 0; i < extents.length; i++) {
      if ((extents[i] as number) - (buckets[i] as number) > 0) { active.push(i); activeTokens += extents[i] as number; }
    }
    if (active.length === 0 || activeTokens === 0) break; // every doc saturated
    // Largest-remainder over the ACTIVE docs only.
    const shares = active.map((i) => (remaining * (extents[i] as number)) / activeTokens);
    const floors = shares.map(Math.floor);
    let assigned = floors.reduce((s, f) => s + f, 0);
    const byRemainder = shares
      .map((s, k) => ({ k, frac: s - (floors[k] as number) }))
      .sort((a, b) => b.frac - a.frac || a.k - b.k);
    for (const { k } of byRemainder) {
      if (assigned >= remaining) break;
      floors[k] = (floors[k] as number) + 1;
      assigned++;
    }
    let placed = 0;
    for (let k = 0; k < active.length; k++) {
      const i = active[k]!;
      const capacity = (extents[i] as number) - (buckets[i] as number);
      const give = Math.min(floors[k] as number, capacity);
      buckets[i] = (buckets[i] as number) + give;
      placed += give;
    }
    if (placed === 0) {
      // Sub-unit shares everywhere: place one-by-one by remainder order.
      for (const { k } of byRemainder) {
        if (remaining - placed === 0) break;
        const i = active[k]!;
        if ((extents[i] as number) - (buckets[i] as number) > 0) { buckets[i] = (buckets[i] as number) + 1; placed++; }
      }
      if (placed === 0) break;
    }
    remaining -= placed;
  }

  const bucketOffsets = new Uint32Array(order.length + 1);
  let totalBuckets = 0;
  for (let i = 0; i < order.length; i++) {
    totalBuckets += buckets[i] as number;
    bucketOffsets[i + 1] = totalBuckets;
  }
  const bucketStartToken = new Uint32Array(totalBuckets);
  for (let d = 0; d < order.length; d++) {
    const n = buckets[d] as number;
    const extent = extents[d] as number;
    const base = bucketOffsets[d] as number;
    for (let b = 0; b < n; b++) {
      // Equal-token partition (integer): bucket b starts at ⌊b·extent/n⌋.
      bucketStartToken[base + b] = Math.floor((b * extent) / n);
    }
  }
  return { order, docTokenCount: Uint32Array.from(extents), bucketOffsets, bucketStartToken };
}

/** `NumericOccurrences.docOrdinal` indexes SNAPSHOT documents; the barcode's
 *  CSR axes index SELECTED documents. This map bridges them — a subset
 *  selection of a later snapshot doc must land in slot 0, not out of bounds
 *  (review-C round 1, HIGH). -1 marks an unselected snapshot doc; an
 *  occurrence carrying one is an invariant fault (occurrences filters by the
 *  selection's docSet), surfaced loudly rather than miscounted. */
export function selectionSlotMap(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
): Int32Array {
  const map = new Int32Array(snapshot.docs.length).fill(-1);
  for (let ord = 0; ord < snapshot.docs.length; ord++) {
    const slot = selection.spec.docs.indexOf(snapshot.docs[ord]!.doc);
    if (slot >= 0) map[ord] = slot;
  }
  return map;
}

const slotOf = (slotMap: Int32Array, snapshotOrdinal: number): number => {
  const slot = slotMap[snapshotOrdinal];
  if (slot === undefined || slot < 0) {
    throw new RangeError('occurrence outside the selection — snapshot/selection mismatch');
  }
  return slot;
};

/** Exact representation: fresh CSR arrays over the source occurrences —
 *  order, multiplicity, and span preserved verbatim; CSR slots are SELECTED
 *  document positions via `slotMap`. */
export function packExactTrack(occ: NumericOccurrences, slotMap: Int32Array, docCount: number): DispersionTrackDataV1 {
  const n = occ.pos.length;
  const docOffsets = new Uint32Array(docCount + 1);
  for (let i = 0; i < n; i++) {
    const slot = slotOf(slotMap, occ.docOrdinal[i] as number) + 1;
    docOffsets[slot] = (docOffsets[slot] as number) + 1;
  }
  for (let d = 0; d < docCount; d++) docOffsets[d + 1] = (docOffsets[d + 1] as number) + (docOffsets[d] as number);
  // Occurrences are (docOrdinal, pos)-sorted by contract and selection slots
  // preserve snapshot order (both are snapshot-relative subsequences), so a
  // straight copy is CSR-aligned; fresh buffers, never the cache's.
  return {
    kind: 'exact',
    docOffsets,
    starts: Uint32Array.from(occ.pos),
    spanTokens: Uint32Array.from(occ.spanTokens),
  };
}

/** Density representation: stepped bucket counting over the shared geometry.
 *  Bucket sums equal the exact total; nothing is sampled or dropped. */
export async function packDensityTrack(
  occ: NumericOccurrences,
  geometry: DispersionGeometryV1,
  slotMap: Int32Array,
  checkpoint: () => Promise<void>,
): Promise<DispersionTrackDataV1> {
  const counts = new Uint32Array(geometry.bucketStartToken.length);
  const n = occ.pos.length;
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % DISPERSION_PACK_CHUNK === 0) await checkpoint();
    const d = slotOf(slotMap, occ.docOrdinal[i] as number);
    const from = geometry.bucketOffsets[d] as number;
    const to = geometry.bucketOffsets[d + 1] as number;
    if (to === from) continue; // empty doc cannot carry occurrences anyway
    // Binary search the doc's bucket whose start ≤ pos (last such bucket).
    const pos = occ.pos[i] as number;
    let lo = from, hi = to - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((geometry.bucketStartToken[mid] as number) <= pos) lo = mid;
      else hi = mid - 1;
    }
    counts[lo] = (counts[lo] as number) + 1;
  }
  return { kind: 'density', counts };
}

/** Fresh transferable buffers of a packed result (transfer-list support). */
export function dispersionTransferBuffers(result: DispersionResultV1): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  if (result.geometry) {
    buffers.push(
      result.geometry.docTokenCount.buffer as ArrayBuffer,
      result.geometry.bucketOffsets.buffer as ArrayBuffer,
      result.geometry.bucketStartToken.buffer as ArrayBuffer,
    );
  }
  for (const t of result.tracks) {
    if (t.data.kind === 'exact') {
      buffers.push(t.data.docOffsets.buffer as ArrayBuffer, t.data.starts.buffer as ArrayBuffer, t.data.spanTokens.buffer as ArrayBuffer);
    } else {
      buffers.push(t.data.counts.buffer as ArrayBuffer);
    }
  }
  return buffers;
}
