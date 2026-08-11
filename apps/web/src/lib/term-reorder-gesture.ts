export const TERM_REORDER_EDGE_PX = 72;
export const TERM_REORDER_MAX_SCROLL_PX = 18;

/** One animation-frame scroll step for a held reorder pointer near an edge. */
export function termReorderScrollStep(
  clientY: number,
  top: number,
  bottom: number,
): number {
  if (![clientY, top, bottom].every(Number.isFinite) || bottom <= top) return 0;
  const topDistance = clientY - top;
  if (topDistance < TERM_REORDER_EDGE_PX) {
    const pressure = Math.min(1, (TERM_REORDER_EDGE_PX - topDistance) / TERM_REORDER_EDGE_PX);
    return -Math.max(1, Math.ceil(TERM_REORDER_MAX_SCROLL_PX * pressure));
  }
  const bottomDistance = bottom - clientY;
  if (bottomDistance < TERM_REORDER_EDGE_PX) {
    const pressure = Math.min(1, (TERM_REORDER_EDGE_PX - bottomDistance) / TERM_REORDER_EDGE_PX);
    return Math.max(1, Math.ceil(TERM_REORDER_MAX_SCROLL_PX * pressure));
  }
  return 0;
}
