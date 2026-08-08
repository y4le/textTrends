/**
 * Pure geometry for the trend views — kept worker- and DOM-free so the edge
 * cases (zero-token books, sub-gap spans, label collisions) are testable
 * without rendering.
 */

import type { NumericTrend } from '@texttrends/core';

/** Horizontal space reserved for direct labels beside the plot. Shared with
 * pointer-driven browser tests so gesture coordinates cannot drift silently. */
export const TREND_LABEL_SPACE = 130;

/** Selected trends retain the full document bin geometry, but bins with no
 * selected denominator are GAPS rather than fabricated zero observations.
 * A one-bin run receives a near-zero horizontal tail so SVG paints the mark. */
export function selectedTrendPathData(
  trend: NumericTrend,
  doc: string,
  values: ArrayLike<number>,
  xAt: (bin: number) => number,
  yAt: (value: number) => number,
): string[] {
  const d = trend.order.indexOf(doc);
  if (d < 0) return [];
  const start = trend.rowOffsets[d] ?? 0;
  const end = trend.rowOffsets[d + 1] ?? start;
  const paths: string[] = [];
  let points: string[] = [];
  const flush = () => {
    if (points.length === 0) return;
    const [first, ...rest] = points;
    paths.push(`M${first}${rest.map((p) => ` L${p}`).join('')}${rest.length === 0 ? ' l0.01,0' : ''}`);
    points = [];
  };
  for (let i = start; i < end; i++) {
    const b = i - start;
    if ((trend.binTokens[i] as number) === 0) {
      flush();
      continue;
    }
    points.push(`${xAt(b).toFixed(1)},${yAt(values[i] as number).toFixed(1)}`);
  }
  flush();
  return paths;
}

/** Two-point linear map [d0,d1] → [r0,r1] — the only thing the charts ever
 *  asked of d3-scale. Matches d3's degenerate-domain behavior: when d0 === d1
 *  every input maps to the range midpoint (returning r0 instead would be a
 *  silent semantic change). No clamping. */
export function linearMap(
  d0: number,
  d1: number,
  r0: number,
  r1: number,
): (v: number) => number {
  if (d0 === d1) {
    const mid = (r0 + r1) / 2;
    return () => mid;
  }
  return (v) => r0 + ((v - d0) * (r1 - r0)) / (d1 - d0);
}

/** Exact token span of one result row. Fixed-token layouts have a variable
 * number of rows per document, so the next row offset (or the document extent)
 * is the only honest end boundary. */
export function trendBinSpan(
  trend: NumericTrend,
  docOrdinal: number,
  localBin: number,
): { readonly start: number; readonly end: number } {
  const rowStart = trend.rowOffsets[docOrdinal] ?? 0;
  const rowEnd = trend.rowOffsets[docOrdinal + 1] ?? rowStart;
  const row = rowStart + localBin;
  if (row < rowStart || row >= rowEnd) return { start: 0, end: 0 };
  const extent = trend.docTokenCount[docOrdinal] ?? 0;
  const start = Math.min(trend.binStartToken[row] ?? 0, extent);
  const rawEnd = row + 1 < rowEnd
    ? trend.binStartToken[row + 1] ?? start
    : extent;
  return { start, end: Math.max(start, Math.min(rawEnd, extent)) };
}

export function trendRowsForDoc(
  trend: NumericTrend,
  docOrdinal: number,
): { readonly start: number; readonly end: number; readonly count: number } {
  const start = trend.rowOffsets[docOrdinal] ?? 0;
  const end = trend.rowOffsets[docOrdinal + 1] ?? start;
  return { start, end, count: Math.max(0, end - start) };
}

export function trendBinAtToken(
  trend: NumericTrend,
  docOrdinal: number,
  token: number,
): { readonly row: number; readonly span: { readonly start: number; readonly end: number } } | null {
  const rows = trendRowsForDoc(trend, docOrdinal);
  for (let local = 0; local < rows.count; local++) {
    const span = trendBinSpan(trend, docOrdinal, local);
    if (token >= span.start && token < span.end) {
      return { row: rows.start + local, span };
    }
  }
  return null;
}

/** Clamp a point into its book's pixel span [x0, x1], applying the requested
 *  boundary gaps only when the span can contain them — a narrower span
 *  collapses to its midpoint rather than letting the bounds cross and eject
 *  the point into a neighboring book (empty documents are valid input). */
export function clampToSpan(
  px: number,
  x0: number,
  x1: number,
  leadingGap: number,
  trailingGap: number,
): number {
  let lo = x0 + leadingGap;
  let hi = x1 - trailingGap;
  if (hi < lo) {
    lo = hi = (x0 + x1) / 2;
  }
  return Math.min(hi, Math.max(lo, px));
}

/** Declared-sequence layout: per-doc bases and extents (empty docs valid). */
export interface SequenceLayout {
  readonly bases: readonly number[];
  readonly tokenCounts: readonly number[];
  readonly totalTokens: number;
}

export interface DocumentTokenTarget {
  readonly doc: string;
  readonly token: number;
}

export type TrendStageHit =
  | { readonly d: number; readonly token: number; readonly zone: 'plot' }
  | { readonly d: number; readonly token: number; readonly zone: 'barcode'; readonly trackRow: number };

interface BarcodeBandSpec {
  readonly trackCount: number;
  readonly trackHeight: number;
  readonly trackGap: number;
}

export type TrendStageSpec =
  | {
      readonly view: 'series';
      readonly plotWidth: number;
      readonly plotHeight: number;
      readonly barcodeBandGap: number;
      readonly barcodeHeight: number;
      readonly band: BarcodeBandSpec;
      readonly layout: SequenceLayout;
    }
  | {
      readonly view: 'by-book';
      readonly plotWidth: number;
      readonly rowHeight: number;
      readonly rowGap: number;
      readonly barcodeBandGap: number;
      readonly barcodeHeight: number;
      readonly band: BarcodeBandSpec;
      readonly tokenCounts: readonly number[];
    };

export function barcodeBandHeight(
  trackCount: number,
  trackHeight: number,
  trackGap: number,
): number {
  return Math.max(0, trackCount) * (trackHeight + trackGap);
}

export function barcodeBandExtent(barcodeBandGap: number, barcodeHeight: number): number {
  return barcodeHeight > 0 ? barcodeBandGap + barcodeHeight : 0;
}

/** One by-book stage row is plot + embedded barcode + breathing room. Keep
 * this centralized so painting, pointer hit-testing, cursors and SVG rows can
 * never drift apart. */
export function byBookRowPitch(
  rowHeight: number,
  rowGap: number,
  barcodeBandGap: number,
  barcodeHeight: number,
): number {
  return rowHeight + barcodeBandExtent(barcodeBandGap, barcodeHeight) + rowGap;
}

function barcodeTrackRow(
  localY: number,
  trackCount: number,
  trackHeight: number,
  trackGap: number,
): number | null {
  const stride = trackHeight + trackGap;
  if (stride <= 0 || localY < 0) return null;
  const row = Math.floor(localY / stride);
  return row >= 0 && row < trackCount ? row : null;
}

/** Explicit stage hit zones prevent the new band from silently broadening
 * the existing plot hit area. Axis gaps and labels continue to reject. */
export function trendStageHit(
  px: number,
  py: number,
  stage: TrendStageSpec,
): TrendStageHit | null {
  if (px < 0 || px >= stage.plotWidth || py < 0) return null;
  if (stage.view === 'series') {
    const at = seriesTokenFromX(px, stage.plotWidth, stage.layout);
    if (!at) return null;
    if (py <= stage.plotHeight) return { ...at, zone: 'plot' };
    const barcodeTop = stage.plotHeight + stage.barcodeBandGap;
    if (py < barcodeTop || py >= barcodeTop + stage.barcodeHeight) return null;
    const trackRow = barcodeTrackRow(
      py - barcodeTop,
      stage.band.trackCount,
      stage.band.trackHeight,
      stage.band.trackGap,
    );
    return trackRow === null ? null : { ...at, zone: 'barcode', trackRow };
  }

  const pitch = byBookRowPitch(
    stage.rowHeight,
    stage.rowGap,
    stage.barcodeBandGap,
    stage.barcodeHeight,
  );
  const d = Math.floor(py / pitch);
  if (d < 0 || d >= stage.tokenCounts.length) return null;
  const localY = py - d * pitch;
  const token = bookTokenFromX(px, stage.plotWidth, stage.tokenCounts[d] ?? 0);
  if (token === null) return null;
  if (localY <= stage.rowHeight) return { d, token, zone: 'plot' };
  const barcodeTop = stage.rowHeight + stage.barcodeBandGap;
  if (localY < barcodeTop || localY >= barcodeTop + stage.barcodeHeight) return null;
  const trackRow = barcodeTrackRow(
    localY - barcodeTop,
    stage.band.trackCount,
    stage.band.trackHeight,
    stage.band.trackGap,
  );
  return trackRow === null ? null : { d, token, zone: 'barcode', trackRow };
}

/** Resolve a global sequence token to (doc ordinal, document-local token).
 *  Empty documents own no positions. Clamps to the corpus ends. */
export function seriesDocFromGlobal(
  g: number,
  layout: SequenceLayout,
): { d: number; token: number } | null {
  if (layout.totalTokens <= 0) return null;
  const clamped = Math.max(0, Math.min(layout.totalTokens - 1, Math.floor(g)));
  for (let d = 0; d < layout.bases.length; d++) {
    const tc = layout.tokenCounts[d] ?? 0;
    if (tc === 0) continue;
    const base = layout.bases[d] ?? 0;
    if (clamped >= base && clamped < base + tc) return { d, token: clamped - base };
  }
  return null;
}

/** Map a plot-relative x pixel to (doc ordinal, document-local token) on the
 *  concatenated axis. Empty documents own no positions; a boundary position
 *  belongs to the next non-empty document. Returns null off every doc. */
export function seriesTokenFromX(
  px: number,
  plotWidth: number,
  layout: SequenceLayout,
): { d: number; token: number } | null {
  if (plotWidth <= 0) return null;
  return seriesDocFromGlobal((px / plotWidth) * layout.totalTokens, layout);
}

/** Center-of-token x pixel on the concatenated axis. */
export function seriesXFromToken(
  d: number,
  token: number,
  plotWidth: number,
  layout: SequenceLayout,
): number {
  if (layout.totalTokens <= 0) return 0;
  return (((layout.bases[d] ?? 0) + token + 0.5) / layout.totalTokens) * plotWidth;
}

/** Token-START edge x pixel on the concatenated axis — a boundary line, NOT a
 *  scrubber (which centers on the token via `seriesXFromToken`). Used for
 *  chapter boundary rules so a mark sits exactly where the section begins. */
export function seriesXFromTokenEdge(
  d: number,
  token: number,
  plotWidth: number,
  layout: SequenceLayout,
): number {
  if (layout.totalTokens <= 0) return 0;
  return (((layout.bases[d] ?? 0) + token) / layout.totalTokens) * plotWidth;
}

/** Map x to a document-local token on a single 0..tokenCount row. */
export function bookTokenFromX(px: number, plotWidth: number, tokenCount: number): number | null {
  if (plotWidth <= 0 || tokenCount <= 0) return null;
  return Math.max(0, Math.min(tokenCount - 1, Math.floor((px / plotWidth) * tokenCount)));
}

/** Center-of-token x pixel on a single 0..tokenCount row. */
export function bookXFromToken(token: number, plotWidth: number, tokenCount: number): number {
  if (tokenCount <= 0) return 0;
  return ((token + 0.5) / tokenCount) * plotWidth;
}

/** Token-START edge x pixel on a single 0..tokenCount row — a boundary line,
 *  NOT a scrubber center. Used for chapter boundary rules in the by-book view. */
export function bookXFromTokenEdge(token: number, plotWidth: number, tokenCount: number): number {
  if (tokenCount <= 0) return 0;
  return (token / tokenCount) * plotWidth;
}

/** Step a scrub position by `delta` tokens along the declared sequence,
 *  crossing document boundaries and skipping empty documents. Clamps at the
 *  corpus ends. Returns null only when no document has tokens. */
export function stepAlongSequence(
  d: number,
  token: number,
  delta: number,
  layout: SequenceLayout,
): { d: number; token: number } | null {
  return seriesDocFromGlobal((layout.bases[d] ?? 0) + token + delta, layout);
}

/** Resolve direct-label y-positions with a minimum vertical gap, preserving
 *  the input order of ties by rank; positions stay within [min, max]. */
export function spreadLabels(
  desired: readonly number[],
  min: number,
  max: number,
  gap: number,
): number[] {
  const order = desired.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const placed: number[] = [];
  for (const { y } of order) {
    const lo = placed.length === 0 ? min : placed[placed.length - 1]! + gap;
    placed.push(Math.min(Math.max(y, lo), max));
  }
  // Push overflow back up if we ran past max.
  for (let i = placed.length - 2; i >= 0; i--) {
    placed[i] = Math.min(placed[i]!, placed[i + 1]! - gap);
  }
  const out: number[] = new Array(desired.length);
  order.forEach(({ i }, k) => {
    out[i] = placed[k]!;
  });
  return out;
}
