/**
 * Pure geometry for the trend views — kept worker- and DOM-free so the edge
 * cases (zero-token books, sub-gap spans, label collisions) are testable
 * without rendering.
 */

import type { NumericTrend } from '@texttrends/core';
import { barcodeBandExtent } from './footer-metrics.ts';

export { barcodeBandExtent, barcodeBandHeight } from './footer-metrics.ts';

/** Selected trends retain the full document bin geometry, but bins with no
 * selected denominator are GAPS rather than fabricated zero observations.
 * Supplying bin spans extends each observed run to its measured token edges;
 * without them, a one-bin run receives a near-zero tail so SVG paints it. */
export function selectedTrendPathData(
  trend: NumericTrend,
  doc: string,
  values: ArrayLike<number>,
  xAt: (bin: number) => number,
  yAt: (value: number) => number,
  xSpanAt?: (bin: number) => { readonly start: number; readonly end: number },
): string[] {
  const d = trend.order.indexOf(doc);
  if (d < 0) return [];
  const start = trend.rowOffsets[d] ?? 0;
  const end = trend.rowOffsets[d + 1] ?? start;
  const paths: string[] = [];
  let points: { readonly bin: number; readonly x: number; readonly y: number }[] = [];
  const flush = () => {
    if (points.length === 0) return;
    const coordinate = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`;
    const [first, ...rest] = points;
    const firstCoordinate = coordinate(first!.x, first!.y);
    if (!xSpanAt) {
      paths.push(`M${firstCoordinate}${rest.map((point) => ` L${coordinate(point.x, point.y)}`).join('')}${rest.length === 0 ? ' l0.01,0' : ''}`);
      points = [];
      return;
    }
    const firstSpan = xSpanAt(first!.bin);
    const last = points.at(-1)!;
    const lastSpan = xSpanAt(last.bin);
    const extended = [
      { x: firstSpan.start, y: first!.y },
      ...points,
      { x: lastSpan.end, y: last.y },
    ].filter((point, index, all) => (
      index === 0 || point.x !== all[index - 1]!.x || point.y !== all[index - 1]!.y
    ));
    const [extendedFirst, ...extendedRest] = extended;
    paths.push(`M${coordinate(extendedFirst!.x, extendedFirst!.y)}${extendedRest.map((point) => ` L${coordinate(point.x, point.y)}`).join('')}`);
    points = [];
  };
  for (let i = start; i < end; i++) {
    const b = i - start;
    if ((trend.binTokens[i] as number) === 0) {
      flush();
      continue;
    }
    points.push({ bin: b, x: xAt(b), y: yAt(values[i] as number) });
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

export type TrendStagePointerIntent = 'locate' | 'extend';

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
      readonly view: 'by-book' | 'by-book-scaled';
      readonly plotWidth: number;
      readonly rowHeight: number;
      readonly rowGap: number;
      readonly barcodeBandGap: number;
      readonly barcodeHeight: number;
      readonly band: BarcodeBandSpec;
      readonly tokenCounts: readonly number[];
      /** Per-row x denominator: own extent for equal rows, shared maximum for
       * token-scaled rows. */
      readonly rowDomain: readonly number[];
    };

export interface TrendLabelBand {
  readonly d: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly height: number;
}

/** Combined labels use one stable lane at every width. When a title does not
 * fit, the painter reduces it to its ordinal rather than removing identity. */
export const TREND_SERIES_LABEL_BAND_HEIGHT = 34;

/** One by-book stage row is a plot, embedded barcode, and title band (reusing
 * rowGap). Keep this centralized so painting, pointer hit-testing, cursors and
 * SVG rows can never drift apart. */
export function byBookRowPitch(
  rowHeight: number,
  rowGap: number,
  barcodeBandGap: number,
  barcodeHeight: number,
): number {
  return rowHeight + barcodeBandExtent(barcodeBandGap, barcodeHeight) + rowGap;
}

/** One document-label band per declared document. The SVG painter and the
 * HTML interaction overlay both consume these rectangles, so visible labels
 * and their targets cannot drift apart as barcodes or layouts change. */
export function trendLabelBands(stage: TrendStageSpec): readonly TrendLabelBand[] {
  if (stage.view === 'series') {
    const top = stage.plotHeight
      + barcodeBandExtent(stage.barcodeBandGap, stage.barcodeHeight);
    return stage.layout.tokenCounts.map((count, d) => ({
      d,
      left: seriesXFromTokenEdge(d, 0, stage.plotWidth, stage.layout),
      right: seriesXFromTokenEdge(d, count, stage.plotWidth, stage.layout),
      top,
      height: TREND_SERIES_LABEL_BAND_HEIGHT,
    }));
  }
  const pitch = byBookRowPitch(
    stage.rowHeight,
    stage.rowGap,
    stage.barcodeBandGap,
    stage.barcodeHeight,
  );
  const bandOffset = stage.rowHeight
    + barcodeBandExtent(stage.barcodeBandGap, stage.barcodeHeight);
  return stage.tokenCounts.map((_, d) => ({
    d,
    left: 0,
    right: stage.plotWidth,
    top: d * pitch + bandOffset,
    height: stage.rowGap,
  }));
}

/** Resolve the document selected while an already-armed label drag traverses
 * the stage. The sequence resolver and by-book row clamp extend coordinates
 * to the first/last document, so the pointer need not stay in the label lane. */
export function trendStageDocument(
  px: number,
  py: number,
  stage: TrendStageSpec,
): number | null {
  if (stage.view === 'series') {
    if (!Number.isFinite(px) || stage.plotWidth <= 0) return null;
    return seriesTokenFromX(px, stage.plotWidth, stage.layout)?.d ?? null;
  }
  if (!Number.isFinite(py) || stage.tokenCounts.length === 0) return null;
  const pitch = byBookRowPitch(
    stage.rowHeight,
    stage.rowGap,
    stage.barcodeBandGap,
    stage.barcodeHeight,
  );
  if (pitch <= 0) return null;
  return Math.max(0, Math.min(stage.tokenCounts.length - 1, Math.floor(py / pitch)));
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
  intent: TrendStagePointerIntent,
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
  const domainToken = bookTokenFromX(px, stage.plotWidth, stage.rowDomain[d] ?? 0);
  const extent = stage.tokenCounts[d] ?? 0;
  if (domainToken === null || extent <= 0) return null;
  if (domainToken >= extent && intent === 'locate') return null;
  const token = Math.min(domainToken, extent - 1);
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

/** Token-edge x pixel on the concatenated axis. Unlike
 *  `seriesXFromToken`, this does not add a half-token centering offset. */
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

/** Token-edge x pixel on a single 0..tokenCount row. */
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
