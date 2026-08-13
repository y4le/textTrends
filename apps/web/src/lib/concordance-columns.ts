export type ConcordanceColumn = 'left' | 'node' | 'right' | 'book';

export interface ConcordanceColumnWidths {
  readonly left: number;
  readonly node: number;
  readonly right: number;
  readonly book: number;
}

export interface ConcordanceColumnLimit {
  readonly min: number;
  readonly max: number;
}

/** A fixed reserve keeps column resizing presentation-only. Twenty-four
 * word-like tokens supplies roughly 100 characters per side for the bundled
 * prose without tying worker requests to live display geometry. */
export const CONCORDANCE_CONTEXT_TOKENS = 24;

/** Widths describe visible monospace character cells. Cell padding is added
 * outside this budget by the grid tracks. */
export const CONCORDANCE_COLUMN_DEFAULTS: ConcordanceColumnWidths = Object.freeze({
  left: 40,
  node: 18,
  right: 40,
  book: 4,
});

export const CONCORDANCE_COLUMN_LIMITS: Readonly<Record<ConcordanceColumn, ConcordanceColumnLimit>> =
  Object.freeze({
    left: Object.freeze({ min: 1, max: 100 }),
    node: Object.freeze({ min: 1, max: 48 }),
    right: Object.freeze({ min: 1, max: 100 }),
    book: Object.freeze({ min: 3, max: 48 }),
  });

/** The grid adds 0.75ch on both sides of every cell. Keeping this value next
 * to the drag math makes a measured track an honest ch-to-pixel ruler. */
export const CONCORDANCE_COLUMN_PADDING_CH = 1.5;

export function clampConcordanceColumnWidth(
  column: ConcordanceColumn,
  value: number,
): number {
  const limits = CONCORDANCE_COLUMN_LIMITS[column];
  if (!Number.isFinite(value)) return CONCORDANCE_COLUMN_DEFAULTS[column];
  return Math.max(limits.min, Math.min(limits.max, Math.round(value)));
}

export function concordanceColumnWidthFromDrag(
  column: ConcordanceColumn,
  startWidth: number,
  deltaPx: number,
  chPx: number,
): number {
  if (!Number.isFinite(deltaPx) || !(chPx > 0)) {
    return clampConcordanceColumnWidth(column, startWidth);
  }
  return clampConcordanceColumnWidth(column, startWidth + deltaPx / chPx);
}

export function concordanceColumnWidthFromKey(
  column: ConcordanceColumn,
  current: number,
  key: string,
  shiftKey = false,
): number | null {
  const limits = CONCORDANCE_COLUMN_LIMITS[column];
  const step = shiftKey ? 8 : 1;
  switch (key) {
    case 'ArrowLeft':
      return clampConcordanceColumnWidth(column, current - step);
    case 'ArrowRight':
      return clampConcordanceColumnWidth(column, current + step);
    case 'Home':
      return limits.min;
    case 'End':
      return limits.max;
    case 'Enter':
      return CONCORDANCE_COLUMN_DEFAULTS[column];
    default:
      return null;
  }
}

/** Return the smallest horizontal correction that leaves the complete node
 * column visible. If the node itself is wider than the port, preserve its
 * beginning. */
export function nodeVisibleScrollLeft(
  portWidth: number,
  scrollLeft: number,
  maxScrollLeft: number,
  nodeLeft: number,
  nodeWidth: number,
): number {
  if (![portWidth, scrollLeft, maxScrollLeft, nodeLeft, nodeWidth].every(Number.isFinite)) {
    return Math.max(0, scrollLeft);
  }
  const boundedMax = Math.max(0, maxScrollLeft);
  const current = Math.max(0, Math.min(boundedMax, scrollLeft));
  let next = current;
  if (nodeWidth >= portWidth || nodeLeft < current) next = nodeLeft;
  else if (nodeLeft + nodeWidth > current + portWidth) {
    next = nodeLeft + nodeWidth - portWidth;
  }
  return Math.max(0, Math.min(boundedMax, next));
}
