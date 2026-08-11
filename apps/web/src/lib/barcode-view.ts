/**
 * Pure view-model for the dispersion barcode (slice-2 commit D). Maps a
 * `DispersionResultV1` into token-space draw segments the canvas component
 * projects through the SAME token→pixel scales as the trend chart — the
 * barcode and the chart must place an occurrence identically (ruling §D).
 *
 * Honesty rules (ruling §1):
 * - An EXACT tick is one occurrence (spans kept — a phrase tick covers its
 *   whole span, and a click identifies the exact occurrence ordinal).
 * - A DENSITY cell is a labeled bucket count, NEVER renderable as one
 *   occurrence; intensity is count/maxCount over the track's own buckets.
 * - Rendering never issues queries: resize/redraw operate on this resident
 *   projection alone.
 */

import type { DispersionResultV1 } from '@texttrends/core';

export interface BarcodeTickVM {
  readonly kind: 'tick';
  readonly doc: string;
  /** Document-local token span [t0, t1) — t1 ≥ t0 + 1. */
  readonly t0: number;
  readonly t1: number;
  /** Index into the track's exact arrays — the click-through occurrence id. */
  readonly ordinal: number;
}

export interface BarcodeCellVM {
  readonly kind: 'cell';
  readonly doc: string;
  readonly t0: number;
  readonly t1: number;
  readonly count: number;
  /** count / max nonzero bucket count for the track (0..1]; 0 cells are
   *  omitted entirely. */
  readonly intensity: number;
  /** Bucket midpoint token — the KWIC center a cell click targets. */
  readonly midToken: number;
}

export interface BarcodeTrackVM {
  readonly seriesId: string;
  readonly groupId: string;
  readonly representation: 'exact' | 'density';
  readonly total: number;
  /** Reading order under which this track was projected. */
  readonly docOrder: readonly string[];
  readonly segments: readonly BarcodeSegmentVM[];
  /** The same segments bucketed once for by-book painting and stepping. */
  readonly segmentsByDocOrdinal: readonly (readonly BarcodeSegmentVM[])[];
}

export type BarcodeSegmentVM = BarcodeTickVM | BarcodeCellVM;

/** Keep the selected-window total honest while its linked detail request is
 * unresolved. This stays pure so pending/error/zero cannot regress into the
 * same visible value without a unit test noticing. */
export function barcodeLegendTotalText({
  linkedSelection,
  selectedStatus,
  selectedTotal,
  corpusTotal,
}: {
  readonly linkedSelection: boolean;
  readonly selectedStatus: 'pending' | 'ready' | 'error' | null;
  readonly selectedTotal: number | undefined;
  readonly corpusTotal: number;
}): string {
  if (!linkedSelection) return corpusTotal.toLocaleString();
  if (selectedStatus === 'pending') return '…';
  if (selectedStatus === 'error') return 'unavailable';
  return (selectedTotal ?? 0).toLocaleString();
}

/** Project one dispersion result into per-track token-space segments.
 *  `docsInOrder` is the SELECTION order the result was computed under (the
 *  exact CSR doc axis); the caller passes the same order it laid the chart
 *  out with, so ticks can never land in the wrong lane. */
export function barcodeTracks(
  result: DispersionResultV1,
  docsInOrder: readonly string[],
): BarcodeTrackVM[] {
  return result.tracks.map((track) => {
    if (track.data.kind === 'exact') {
      const { docOffsets, starts, spanTokens } = track.data;
      const segments: BarcodeTickVM[] = [];
      const segmentsByDocOrdinal: BarcodeTickVM[][] = docsInOrder.map(() => []);
      for (let d = 0; d < docsInOrder.length; d++) {
        const doc = docsInOrder[d]!;
        const from = docOffsets[d] ?? 0;
        const to = docOffsets[d + 1] ?? from;
        for (let i = from; i < to; i++) {
          const t0 = starts[i] as number;
          const segment = { kind: 'tick' as const, doc, t0, t1: t0 + Math.max(1, spanTokens[i] as number), ordinal: i };
          segments.push(segment);
          segmentsByDocOrdinal[d]!.push(segment);
        }
      }
      return {
        seriesId: track.seriesId,
        groupId: track.groupId,
        representation: 'exact' as const,
        total: track.total,
        docOrder: [...docsInOrder],
        segments,
        segmentsByDocOrdinal,
      };
    }
    const geometry = result.geometry;
    if (!geometry) throw new Error('density track without geometry — the wire contract forbids this');
    const counts = track.data.counts;
    let max = 0;
    for (let i = 0; i < counts.length; i++) if ((counts[i] as number) > max) max = counts[i] as number;
    const segments: BarcodeCellVM[] = [];
    const segmentsByDocOrdinal: BarcodeCellVM[][] = geometry.order.map(() => []);
    for (let d = 0; d < geometry.order.length; d++) {
      const doc = geometry.order[d]!;
      const from = geometry.bucketOffsets[d] as number;
      const to = geometry.bucketOffsets[d + 1] as number;
      const extent = geometry.docTokenCount[d] as number;
      for (let b = from; b < to; b++) {
        const count = counts[b] as number;
        if (count === 0) continue; // an empty bucket paints nothing
        const t0 = geometry.bucketStartToken[b] as number;
        const t1 = b + 1 < to ? (geometry.bucketStartToken[b + 1] as number) : extent;
        const segment = {
          kind: 'cell', doc, t0, t1, count,
          intensity: max === 0 ? 0 : count / max,
          midToken: t0 + ((t1 - t0) >> 1),
        } as const;
        segments.push(segment);
        segmentsByDocOrdinal[d]!.push(segment);
      }
    }
    return {
      seriesId: track.seriesId,
      groupId: track.groupId,
      representation: 'density' as const,
      total: track.total,
      docOrder: [...geometry.order],
      segments,
      segmentsByDocOrdinal,
    };
  });
}

/** The occurrence a token-space barcode activation targets. Exact fine-pointer
 *  clicks first use the bounded snap index above; this resolver remains
 *  authoritative for density cells and token-addressed consumers.
 *  - exact: the covering tick (tie rule above), else the NEAREST tick in the
 *    doc by start distance (earlier wins a tie) — clicking dead space centers
 *    the closest occurrence;
 *  - density: the covering cell → its bucket MIDPOINT, kind 'bucket' so the
 *    UI labels it "nearest occurrence to this bucket", never an occurrence. */
export interface BarcodeActivation {
  readonly kind: 'occurrence' | 'bucket';
  readonly doc: string;
  readonly token: number;
  /** The bucket's HONEST hit count — present exactly when kind='bucket', so
   *  the caption can announce what the bucket represents (review-D round 2). */
  readonly bucketCount?: number;
}

/** Reader may claim an exact occurrence anchor, never a density midpoint. */
export function barcodeReaderActivation(
  activation: BarcodeActivation | null,
): BarcodeActivation | null {
  return activation?.kind === 'occurrence' ? activation : null;
}

/** Width-independent index used by the graph's hover pipeline. It is built
 * only for exact tracks: density cells are aggregates and must never
 * masquerade as a snap target. Pixel projection happens during lookup, so a
 * resize never rebuilds every occurrence entry. */
export interface BarcodeSnapEntry {
  readonly activation: BarcodeActivation;
  readonly t0: number;
  readonly t1: number;
}

export interface BarcodeSnapIndex {
  readonly docOrdinal: number;
  readonly entries: readonly BarcodeSnapEntry[];
  /** Greatest token end through each entry, used to reject earlier spans
   * after projecting one prefix extent through the current scale. */
  readonly prefixMaxEndToken: readonly number[];
}

function finalizeBarcodeSnapEntries(
  docOrdinal: number,
  entries: BarcodeSnapEntry[],
): BarcodeSnapIndex {
  entries.sort((a, b) => a.t0 - b.t0);
  const prefixMaxEndToken: number[] = [];
  let maxEndToken = -Infinity;
  for (const entry of entries) {
    maxEndToken = Math.max(maxEndToken, entry.t1);
    prefixMaxEndToken.push(maxEndToken);
  }
  return { docOrdinal, entries, prefixMaxEndToken };
}

/** Build every document lane in one token-space pass over a track. The track
 * carries its projection order, so a caller cannot silently supply a
 * different document order. */
export function buildBarcodeSnapIndexes(
  track: BarcodeTrackVM,
): readonly (BarcodeSnapIndex | null)[] {
  if (track.representation !== 'exact') return track.docOrder.map(() => null);
  const entriesByDoc: BarcodeSnapEntry[][] = track.docOrder.map(() => []);
  for (let d = 0; d < track.segmentsByDocOrdinal.length; d++) {
    for (const segment of track.segmentsByDocOrdinal[d] ?? []) {
      if (segment.kind !== 'tick') continue;
      entriesByDoc[d]!.push({
        activation: { kind: 'occurrence', doc: segment.doc, token: segment.t0 },
        t0: segment.t0,
        t1: segment.t1,
      });
    }
  }
  return entriesByDoc.map((entries, d) => finalizeBarcodeSnapEntries(d, entries));
}

/** Snap to the closest painted exact interval when it lies within
 * `maxDistance` horizontal pixels. Covering overlaps choose the greatest
 * token start (the same painted-on-top rule as click activation); equal
 * non-covering distances choose the earlier occurrence. */
export function snapBarcodeIndex(
  index: BarcodeSnapIndex | null,
  px: number,
  xAtEdge: (docOrdinal: number, token: number) => number,
  maxDistance = 8,
): BarcodeActivation | null {
  if (!index || index.entries.length === 0) return null;
  const { docOrdinal, entries, prefixMaxEndToken } = index;
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xAtEdge(docOrdinal, entries[mid]!.t0) <= px + maxDistance) lo = mid + 1;
    else hi = mid;
  }

  let best: BarcodeSnapEntry | null = null;
  let bestDistance = Infinity;
  for (let i = lo - 1; i >= 0; i--) {
    const entry = entries[i]!;
    // The painted interval is [x0, max(x0 + 1, edge(t1))]. Because entries
    // are sorted by t0 and the scale is monotone, the prefix's greatest
    // possible right edge is exactly max(edge(max t1), current x0 + 1).
    const x0 = xAtEdge(docOrdinal, entry.t0);
    const prefixRight = Math.max(
      xAtEdge(docOrdinal, prefixMaxEndToken[i] ?? entry.t1),
      x0 + 1,
    );
    if (prefixRight < px - maxDistance) break;
    const x1 = Math.max(x0 + 1, xAtEdge(docOrdinal, entry.t1));
    const distance = px < x0
      ? x0 - px
      : px > x1
        ? px - x1
        : 0;
    if (distance > maxDistance) continue;
    if (
      distance < bestDistance
      || (
        distance === bestDistance
        && best !== null
        && (distance === 0 ? entry.t0 > best.t0 : entry.t0 < best.t0)
      )
    ) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best?.activation ?? null;
}

/** Density-only token activation. Exact pointer activation is owned by the
 * projected snap index; keeping the addressing spaces separate prevents two
 * subtly different exact-hit authorities. */
export function bucketActivationAt(
  track: BarcodeTrackVM,
  doc: string,
  token: number,
): BarcodeActivation | null {
  if (track.representation !== 'density') return null;
  const d = track.docOrder.indexOf(doc);
  if (d < 0) return null;
  for (const seg of track.segmentsByDocOrdinal[d] ?? []) {
    if (seg.kind !== 'cell') continue;
    if (seg.t0 <= token && token < seg.t1) return { kind: 'bucket', doc, token: seg.midToken, bucketCount: seg.count };
  }
  return null;
}

/** Stable occurrence identity captured at pointer-down. The current track list
 * may be presentation-reordered before pointer-up, so resolution is by
 * series id rather than the row ordinal that happened to be under the
 * pointer. */
export interface CapturedBarcodeTarget {
  readonly trackId: string;
  readonly doc: string;
  readonly rawToken: number;
  readonly exactActivation: BarcodeActivation | null;
}

export interface BarcodePointerSample {
  readonly trackRow: number;
  readonly docOrdinal: number;
  readonly doc: string;
  readonly rawToken: number;
  readonly px: number;
}

/** Capture the stable, token-space identity used by the Trends barcode before
 * activation. Both rendered barcodes call this authority so exact proximity,
 * document-boundary ownership, and later density resolution cannot drift. */
export function captureBarcodePointerTarget(
  tracks: readonly BarcodeTrackVM[],
  snapIndexes: readonly (readonly (BarcodeSnapIndex | null)[])[],
  sample: BarcodePointerSample,
  xAtEdge: (docOrdinal: number, token: number) => number,
  allowExactSnap = true,
): CapturedBarcodeTarget | null {
  const track = tracks[sample.trackRow];
  if (!track || track.docOrder[sample.docOrdinal] !== sample.doc) return null;
  const exactActivation = allowExactSnap && track.representation === 'exact'
    ? snapBarcodeIndex(
        snapIndexes[sample.trackRow]?.[sample.docOrdinal] ?? null,
        sample.px,
        xAtEdge,
      )
    : null;
  return {
    trackId: track.seriesId,
    doc: sample.doc,
    rawToken: sample.rawToken,
    exactActivation,
  };
}

export type CapturedBarcodeResolution =
  | {
      readonly kind: 'activation';
      readonly track: BarcodeTrackVM;
      readonly activation: BarcodeActivation;
    }
  | {
      readonly kind: 'scrub';
      readonly doc: string;
      readonly token: number;
    };

export function resolveCapturedBarcodeTarget(
  tracks: readonly BarcodeTrackVM[],
  captured: CapturedBarcodeTarget,
): CapturedBarcodeResolution {
  const track = tracks.find((candidate) => candidate.seriesId === captured.trackId);
  if (!track) return { kind: 'scrub', doc: captured.doc, token: captured.rawToken };
  const activation = track.representation === 'exact'
    ? captured.exactActivation
    : bucketActivationAt(track, captured.doc, captured.rawToken);
  return activation
    ? { kind: 'activation', track, activation }
    : { kind: 'scrub', doc: captured.doc, token: captured.rawToken };
}

/** Resolve a barcode gesture into an honest Reader coordinate. Exact
 * occurrences may supply their snapped target; density buckets fall back to
 * the raw corpus point because their midpoint is not an occurrence. */
export function barcodeReaderTarget(
  resolution: CapturedBarcodeResolution | null,
  raw: { readonly doc: string; readonly token: number } | null,
): { readonly doc: string; readonly token: number } | null {
  if (resolution?.kind === 'scrub') {
    return { doc: resolution.doc, token: resolution.token };
  }
  if (resolution?.kind === 'activation') {
    return barcodeReaderActivation(resolution.activation) ?? raw;
  }
  return raw;
}

/** Walk a track's occurrences RELATIVE to the current center, in reading order
 *  across the projection order carried by the track: exact tracks step ticks; density tracks step NONZERO
 *  buckets (kind 'bucket', midpoint targets) — the keyboard path for both
 *  representations (review-D: density must be operable without a pointer). */
function activationForSegment(segment: BarcodeSegmentVM): BarcodeActivation {
  return segment.kind === 'tick'
    ? { kind: 'occurrence', doc: segment.doc, token: segment.t0 }
    : { kind: 'bucket', doc: segment.doc, token: segment.midToken, bucketCount: segment.count };
}

function edgeSegment(track: BarcodeTrackVM, direction: 1 | -1): BarcodeSegmentVM | null {
  for (
    let d = direction === 1 ? 0 : track.segmentsByDocOrdinal.length - 1;
    d >= 0 && d < track.segmentsByDocOrdinal.length;
    d += direction
  ) {
    const bucket = track.segmentsByDocOrdinal[d] ?? [];
    const segment = direction === 1 ? bucket[0] : bucket[bucket.length - 1];
    if (segment) return segment;
  }
  return null;
}

export function stepTarget(
  track: BarcodeTrackVM,
  center: { readonly doc: string; readonly token: number } | null,
  dir: 1 | -1,
): BarcodeActivation | null {
  const first = edgeSegment(track, 1);
  const last = edgeSegment(track, -1);
  if (!first || !last) return null;
  if (!center) return activationForSegment(dir === 1 ? first : last);
  const centerDoc = track.docOrder.indexOf(center.doc);
  if (centerDoc < 0) return activationForSegment(dir === 1 ? first : last);
  if (dir === 1) {
    for (let d = centerDoc; d < track.segmentsByDocOrdinal.length; d++) {
      for (const segment of track.segmentsByDocOrdinal[d] ?? []) {
        const token = segment.kind === 'tick' ? segment.t0 : segment.midToken;
        if (d > centerDoc || token > center.token) return activationForSegment(segment);
      }
    }
    return activationForSegment(last);
  }
  for (let d = centerDoc; d >= 0; d--) {
    const bucket = track.segmentsByDocOrdinal[d] ?? [];
    for (let i = bucket.length - 1; i >= 0; i--) {
      const segment = bucket[i]!;
      const token = segment.kind === 'tick' ? segment.t0 : segment.midToken;
      if (d < centerDoc || token < center.token) return activationForSegment(segment);
    }
  }
  return activationForSegment(first);
}

/** Present resident tracks in the CURRENT series order — a query-free
 *  notebook reorder must move the strip's rows with the chart (review-D
 *  round 2); unknown ids keep result order at the end. */
export function orderTracks(
  tracks: readonly BarcodeTrackVM[],
  seriesOrder: readonly string[],
): BarcodeTrackVM[] {
  const pos = (id: string) => {
    const i = seriesOrder.indexOf(id);
    return i < 0 ? seriesOrder.length : i;
  };
  return [...tracks].sort((a, b) => pos(a.seriesId) - pos(b.seriesId));
}

/** The concordance caption for a served center — PURE so the announced text
 *  is unit-pinned. A bucket center names its honest hit count and, when the
 *  first served row is off the midpoint, the distance (the occurrence for the
 *  indicated position is never silently swapped). */
export function kwicCaptionText(
  center: { readonly doc: string; readonly token: number; readonly origin?: 'bucket'; readonly bucketCount?: number } | null,
  firstRowPos: number | null,
  titleOf: (doc: string) => string,
): string {
  if (center === null) return 'reading order';
  const at = `${titleOf(center.doc)} · token ${(center.token + 1).toLocaleString()}`;
  if (center.origin !== 'bucket') return `nearest to ${at}`;
  const hits = center.bucketCount !== undefined
    ? ` (${center.bucketCount.toLocaleString()} hit${center.bucketCount === 1 ? '' : 's'} in this bucket)`
    : '';
  const distance = firstRowPos !== null && Math.abs(firstRowPos - center.token) > 0
    ? ` · first hit ${Math.abs(firstRowPos - center.token).toLocaleString()} tokens away`
    : '';
  return `nearest occurrence to this bucket${hits} · ${at}${distance}`;
}
