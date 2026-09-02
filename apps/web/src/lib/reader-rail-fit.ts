/**
 * Decide the Read presentation from measured inline geometry. The required
 * width is painted by a CSS probe using the live prose font, rail minimums,
 * and gaps, so this decision follows zoom and typography rather than a named
 * viewport breakpoint.
 */
export function readerRailsFit(
  availableInlineSize: number,
  requiredInlineSize: number,
): boolean {
  return Number.isFinite(availableInlineSize)
    && Number.isFinite(requiredInlineSize)
    && availableInlineSize > 0
    && requiredInlineSize > 0
    && availableInlineSize + 0.5 >= requiredInlineSize;
}
