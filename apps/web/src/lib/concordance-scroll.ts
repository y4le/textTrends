import type { SequenceLayout } from './trend-geometry.ts';

/** Kept below browser layout-coordinate limits while still giving ordinary
 * Concordances one native row pitch per logical occurrence. */
export const CONCORDANCE_SAFE_SCROLL_EXTENT = 8_000_000;
export const CONCORDANCE_ROW_HEIGHT = 32;

export interface ConcordanceAxisLike {
  readonly ranks: Uint32Array;
  readonly globalTokens: Uint32Array;
}

export interface ConcordanceResidentLike {
  readonly total: number;
  readonly firstRank: number;
  readonly rows: readonly { readonly doc: string; readonly pos: number }[];
}

interface RankTokenPoint {
  readonly logical: number;
  readonly globalToken: number;
}

export interface ConcordanceVisibleRanks {
  readonly start: number;
  readonly end: number;
}

export interface ConcordanceRankTarget {
  readonly rank: number;
  readonly doc: string;
  readonly token: number;
}

export function concordancePhysicalExtent(
  totalRows: number,
  rowHeight = CONCORDANCE_ROW_HEIGHT,
): number {
  if (!Number.isFinite(totalRows) || totalRows <= 0 || !(rowHeight > 0)) return 0;
  return Math.min(totalRows * rowHeight, CONCORDANCE_SAFE_SCROLL_EXTENT);
}

export function concordanceScrollTop(
  logical: number,
  totalRows: number,
  rowHeight = CONCORDANCE_ROW_HEIGHT,
): number {
  const extent = concordancePhysicalExtent(totalRows, rowHeight);
  if (extent === 0) return 0;
  return Math.max(0, Math.min(totalRows, logical)) / totalRows * extent;
}

export function concordanceLogicalAtScroll(
  scrollTop: number,
  totalRows: number,
  rowHeight = CONCORDANCE_ROW_HEIGHT,
): number {
  const extent = concordancePhysicalExtent(totalRows, rowHeight);
  if (extent === 0 || !Number.isFinite(scrollTop)) return 0;
  return Math.max(0, Math.min(extent, scrollTop)) / extent * totalRows;
}

export function concordanceVisibleRanks(
  logical: number,
  totalRows: number,
  viewportHeight: number,
  rowHeight = CONCORDANCE_ROW_HEIGHT,
  overscanViewports = 1,
): ConcordanceVisibleRanks {
  if (totalRows <= 0 || !(rowHeight > 0)) return { start: 0, end: 0 };
  const visibleRows = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rowHeight));
  const overscan = Math.ceil(visibleRows * Math.max(0, overscanViewports));
  const halfVisible = visibleRows / 2;
  const start = Math.max(0, Math.floor(logical - halfVisible) - overscan);
  const end = Math.min(totalRows, Math.ceil(logical + halfVisible) + overscan);
  return { start, end: Math.max(start, end) };
}

export function concordanceWindowSize(viewportHeight: number): {
  readonly before: number;
  readonly after: number;
} {
  const visibleRows = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / CONCORDANCE_ROW_HEIGHT));
  const radius = Math.min(249, Math.max(24, visibleRows * 2));
  return { before: radius, after: radius };
}

/** Choose a rank anchor for the next resident window before visible overscan
 * reaches the leading unloaded edge. Returning the first rank just outside
 * residency makes neighboring windows overlap; ignoring trailing overscan
 * prevents newly shifted windows from immediately refetching in reverse. */
export function concordancePrefetchRank(
  logical: number,
  totalRows: number,
  viewportHeight: number,
  resident: ConcordanceResidentLike | null,
  direction: -1 | 0 | 1,
): number | null {
  if (!Number.isFinite(totalRows) || totalRows <= 0) return null;
  const active = Math.max(0, Math.min(totalRows - 1, Math.floor(logical)));
  if (resident === null || resident.total !== totalRows || resident.rows.length === 0) {
    return active;
  }
  const first = Math.max(0, Math.min(totalRows, resident.firstRank));
  const end = Math.max(first, Math.min(totalRows, first + resident.rows.length));
  if (active < first || active >= end) return active;

  const visible = concordanceVisibleRanks(logical, totalRows, viewportHeight);
  const needsBefore = direction <= 0 && first > 0 && visible.start <= first;
  const needsAfter = direction >= 0 && end < totalRows && visible.end >= end;
  if (needsBefore && needsAfter) {
    return active - first < end - active ? first - 1 : end;
  }
  if (needsBefore) return first - 1;
  if (needsAfter) return end;
  return null;
}

/** Resolve the occurrence nearest the now line. Concordance-originated cursor
 * publication is intentionally discrete; continuous corpus interpolation is
 * reserved for the reverse scrub-to-Concordance direction. */
export function concordanceTargetAtLogical(
  logical: number,
  resident: ConcordanceResidentLike | null,
): ConcordanceRankTarget | null {
  if (resident === null || resident.total <= 0 || !Number.isFinite(logical)) return null;
  const rank = Math.max(0, Math.min(resident.total - 1, Math.floor(logical)));
  const row = resident.rows[rank - resident.firstRank];
  return row === undefined ? null : { rank, doc: row.doc, token: row.pos };
}

export function globalTokenForTarget(
  docs: readonly string[],
  layout: SequenceLayout,
  target: { readonly doc: string; readonly token: number },
): number | null {
  const ordinal = docs.indexOf(target.doc);
  const count = layout.tokenCounts[ordinal] ?? 0;
  if (
    ordinal < 0
    || count <= 0
    || !Number.isSafeInteger(target.token)
    || target.token < 0
    || target.token >= count
  ) return null;
  return (layout.bases[ordinal] ?? 0) + target.token;
}

function rankTokenPoints(input: {
  readonly docs: readonly string[];
  readonly layout: SequenceLayout;
  readonly totalRows: number;
  readonly axis: ConcordanceAxisLike | null;
  readonly resident: ConcordanceResidentLike | null;
}): readonly RankTokenPoint[] {
  const { docs, layout, totalRows, axis, resident } = input;
  if (totalRows <= 0 || layout.totalTokens <= 0) return [];
  const points = new Map<number, number>();
  points.set(0, 0);
  points.set(totalRows, layout.totalTokens - 1);
  if (axis !== null && axis.ranks.length === axis.globalTokens.length) {
    for (let index = 0; index < axis.ranks.length; index++) {
      const rank = axis.ranks[index] as number;
      const globalToken = axis.globalTokens[index] as number;
      if (rank < totalRows && globalToken < layout.totalTokens) {
        points.set(rank + 0.5, globalToken);
      }
    }
  }
  if (resident?.total === totalRows) {
    resident.rows.forEach((row, index) => {
      const globalToken = globalTokenForTarget(
        docs,
        layout,
        { doc: row.doc, token: row.pos },
      );
      const rank = resident.firstRank + index;
      if (globalToken !== null && rank < totalRows) points.set(rank + 0.5, globalToken);
    });
  }
  return [...points]
    .map(([logical, globalToken]) => ({ logical, globalToken }))
    .sort((left, right) => left.logical - right.logical);
}

export function logicalForGlobalToken(input: {
  readonly docs: readonly string[];
  readonly layout: SequenceLayout;
  readonly totalRows: number;
  readonly globalToken: number;
  readonly axis: ConcordanceAxisLike | null;
  readonly resident: ConcordanceResidentLike | null;
}): number {
  const { layout, totalRows } = input;
  if (totalRows <= 0 || layout.totalTokens <= 0) return 0;
  const target = Math.max(0, Math.min(layout.totalTokens - 1, input.globalToken));
  // A generic external cursor chooses corpus sentinels at the endpoints. In a
  // one-token corpus both endpoints coincide, and the start sentinel wins;
  // self-published scroll state preserves the distinct bottom coordinate.
  if (target <= 0) return 0;
  if (target >= layout.totalTokens - 1) return totalRows;
  const points = rankTokenPoints(input);
  const exact = points.find((point) =>
    point.logical > 0
    && point.logical < totalRows
    && point.globalToken === target);
  if (exact) return exact.logical;
  let lower = points[0]!;
  let upper = points.at(-1)!;
  for (const point of points) {
    if (point.globalToken < target) lower = point;
    if (point.globalToken > target) {
      upper = point;
      break;
    }
  }
  if (upper.globalToken <= lower.globalToken) return lower.logical;
  const ratio = (target - lower.globalToken) / (upper.globalToken - lower.globalToken);
  return lower.logical + (upper.logical - lower.logical) * ratio;
}
