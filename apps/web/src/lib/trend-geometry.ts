/**
 * Pure geometry for the trend views — kept worker- and DOM-free so the edge
 * cases (zero-token books, sub-gap spans, label collisions) are testable
 * without rendering.
 */

/** Bin token extents for one doc: equal-width construction (ceil(tokens/bins),
 *  matching the trend kernel), last bin clamped. */
export function binSpan(
  tokens: number,
  bins: number,
  b: number,
): { start: number; end: number } {
  const width = tokens === 0 ? 0 : Math.ceil(tokens / bins);
  return { start: Math.min(b * width, tokens), end: Math.min((b + 1) * width, tokens) };
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

/** Pointer → scrub target for the series view. Coordinates OUTSIDE the plot
 *  (label rail, area below the axis, the passage line) are rejected — the
 *  scale clamp must never turn a click on chrome into a position change. */
export function pointerTargetSeries(
  px: number,
  py: number,
  plotWidth: number,
  plotHeight: number,
  layout: SequenceLayout,
): { d: number; token: number } | null {
  if (px < 0 || px >= plotWidth || py < 0 || py > plotHeight) return null;
  return seriesTokenFromX(px, plotWidth, layout);
}

/** Pointer → scrub target for the by-book view: the pointer must sit inside
 *  a row's plotted band — the gaps between rows and anything past the last
 *  row reject rather than snap to the nearest document. */
export function pointerTargetByBook(
  px: number,
  py: number,
  plotWidth: number,
  rowHeight: number,
  rowGap: number,
  tokenCounts: readonly number[],
): { d: number; token: number } | null {
  if (px < 0 || px >= plotWidth || py < 0) return null;
  const stride = rowHeight + rowGap;
  const d = Math.floor(py / stride);
  if (d >= tokenCounts.length) return null;
  if (py - d * stride > rowHeight) return null;
  const token = bookTokenFromX(px, plotWidth, tokenCounts[d] ?? 0);
  return token === null ? null : { d, token };
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
