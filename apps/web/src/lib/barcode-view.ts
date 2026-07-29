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
  /** Index into the track's exact arrays — the click-through evidence id. */
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
  readonly segments: readonly (BarcodeTickVM | BarcodeCellVM)[];
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
      for (let d = 0; d < docsInOrder.length; d++) {
        const doc = docsInOrder[d]!;
        const from = docOffsets[d] ?? 0;
        const to = docOffsets[d + 1] ?? from;
        for (let i = from; i < to; i++) {
          const t0 = starts[i] as number;
          segments.push({ kind: 'tick', doc, t0, t1: t0 + Math.max(1, spanTokens[i] as number), ordinal: i });
        }
      }
      return { seriesId: track.seriesId, groupId: track.groupId, representation: 'exact' as const, total: track.total, segments };
    }
    const geometry = result.geometry;
    if (!geometry) throw new Error('density track without geometry — the wire contract forbids this');
    const counts = track.data.counts;
    let max = 0;
    for (let i = 0; i < counts.length; i++) if ((counts[i] as number) > max) max = counts[i] as number;
    const segments: BarcodeCellVM[] = [];
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
        segments.push({
          kind: 'cell', doc, t0, t1, count,
          intensity: max === 0 ? 0 : count / max,
          midToken: t0 + ((t1 - t0) >> 1),
        });
      }
    }
    return { seriesId: track.seriesId, groupId: track.groupId, representation: 'density' as const, total: track.total, segments };
  });
}

/** The exact occurrence (if any) covering a clicked token. TIE RULE: among
 *  covering spans the GREATEST start wins — under countOverlaps an earlier
 *  phrase span can cover a later tick's token, and the later (more specific,
 *  painted-on-top) occurrence is the one the user aimed at. Returns null when
 *  nothing covers (caller falls back to nearest-tick semantics). */
export function tickAtToken(track: BarcodeTrackVM, doc: string, token: number): BarcodeTickVM | null {
  if (track.representation !== 'exact') return null;
  let best: BarcodeTickVM | null = null;
  for (const seg of track.segments) {
    if (seg.kind !== 'tick' || seg.doc !== doc) continue;
    if (seg.t0 <= token && token < seg.t1 && (best === null || seg.t0 > best.t0)) best = seg;
  }
  return best;
}

/** The evidence a barcode activation at (doc, token) targets — the ONE
 *  authoritative resolver for canvas clicks and keyboard actions (review-D:
 *  the component must never re-derive this from pixels).
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

export function resolveBarcodeActivation(
  track: BarcodeTrackVM,
  doc: string,
  token: number,
): BarcodeActivation | null {
  if (track.representation === 'exact') {
    const covering = tickAtToken(track, doc, token);
    if (covering) return { kind: 'occurrence', doc, token: covering.t0 };
    let best: BarcodeTickVM | null = null;
    let bestDist = Infinity;
    for (const seg of track.segments) {
      if (seg.kind !== 'tick' || seg.doc !== doc) continue;
      const dist = Math.abs(seg.t0 - token);
      if (dist < bestDist || (dist === bestDist && best !== null && seg.t0 < best.t0)) { best = seg; bestDist = dist; }
    }
    return best ? { kind: 'occurrence', doc: best.doc, token: best.t0 } : null;
  }
  for (const seg of track.segments) {
    if (seg.kind !== 'cell' || seg.doc !== doc) continue;
    if (seg.t0 <= token && token < seg.t1) return { kind: 'bucket', doc, token: seg.midToken, bucketCount: seg.count };
  }
  return null;
}

/** Walk a track's evidence RELATIVE to the current center, in reading order
 *  across `docs`: exact tracks step ticks; density tracks step NONZERO
 *  buckets (kind 'bucket', midpoint targets) — the keyboard path for both
 *  representations (review-D: density must be operable without a pointer). */
export function stepTarget(
  track: BarcodeTrackVM,
  docs: readonly string[],
  center: { readonly doc: string; readonly token: number } | null,
  dir: 1 | -1,
): BarcodeActivation | null {
  const kind = track.representation === 'exact' ? ('occurrence' as const) : ('bucket' as const);
  const points = track.segments
    .map((s) => (s.kind === 'tick'
      ? { doc: s.doc, token: s.t0 }
      : { doc: s.doc, token: s.midToken, count: s.count }))
    .sort((a, b) => (docs.indexOf(a.doc) - docs.indexOf(b.doc)) || (a.token - b.token));
  if (points.length === 0) return null;
  // No center: enter at the first/last point. With a center: the next/prev
  // point in reading order, SATURATING at the edge in the step direction
  // (stepping back past the first stays at the first — never a wraparound).
  let target = dir === 1 ? points[0] : points[points.length - 1];
  if (center) {
    const ord = (doc: string) => docs.indexOf(doc);
    const found = dir === 1
      ? points.find((t) => ord(t.doc) > ord(center.doc) || (t.doc === center.doc && t.token > center.token))
      : [...points].reverse().find((t) => ord(t.doc) < ord(center.doc) || (t.doc === center.doc && t.token < center.token));
    target = found ?? (dir === 1 ? points[points.length - 1] : points[0]);
  }
  if (!target) return null;
  const count = (target as { count?: number }).count;
  return count !== undefined ? { kind, doc: target.doc, token: target.token, bucketCount: count } : { kind, doc: target.doc, token: target.token };
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

/** The accessible per-track summary text — pure, so the announced content
 *  is pinned by unit test, not only rendered JSX. */
export function trackSummaryText(track: BarcodeTrackVM, label: string): string {
  const occ = `${track.total.toLocaleString()} occurrence${track.total === 1 ? '' : 's'}`;
  return track.representation === 'density'
    ? `${label}: ${occ} in ${track.segments.length.toLocaleString()} density buckets`
    : `${label}: ${occ}`;
}

/** The concordance caption for a served center — PURE so the announced text
 *  is unit-pinned. A bucket center names its honest hit count and, when the
 *  first served row is off the midpoint, the distance (synthesis evidence
 *  rule: evidence for the indicated position is never silently swapped). */
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
