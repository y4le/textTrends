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
