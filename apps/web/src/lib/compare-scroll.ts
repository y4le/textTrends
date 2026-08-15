export const COMPARE_ROW_HEIGHT_ESTIMATE = 44;

/** Keep the resident table comfortably below browser layout-coordinate limits.
 * The worker protocol still accepts arbitrary safe offsets; this is a bound on
 * one browser view, not on the analysis itself. */
export const COMPARE_MAX_RESIDENT_ROWS = 50_000;

export interface CompareVirtualLayoutInput {
  readonly rowCount: number;
  readonly rowHeight: number;
  readonly detailIndex: number;
  readonly detailHeight: number;
  readonly bodyViewportTop: number;
  readonly viewportHeight: number;
  readonly overscan: number;
}

export interface CompareVirtualLayout {
  readonly start: number;
  readonly end: number;
  readonly topSpacer: number;
  readonly bottomSpacer: number;
  readonly bodyHeight: number;
}

function validDetailIndex(rowCount: number, detailIndex: number): number {
  return Number.isInteger(detailIndex)
    && detailIndex >= 0
    && detailIndex < rowCount
    ? detailIndex
    : -1;
}

export function compareRowTop(
  index: number,
  rowHeight: number,
  detailIndex: number,
  detailHeight: number,
): number {
  const boundedIndex = Math.max(0, Math.floor(index));
  const pitch = Number.isFinite(rowHeight) && rowHeight > 0
    ? rowHeight
    : COMPARE_ROW_HEIGHT_ESTIMATE;
  const detail = Number.isFinite(detailHeight) && detailHeight > 0
    ? detailHeight
    : 0;
  return boundedIndex * pitch
    + (detailIndex >= 0 && boundedIndex > detailIndex ? detail : 0);
}

/** Pure table-window arithmetic. The caller supplies a measured row pitch so
 * zoomed text and user font settings cannot drift away from the spacers. */
export function compareVirtualLayout(
  input: CompareVirtualLayoutInput,
): CompareVirtualLayout {
  const rowCount = Number.isSafeInteger(input.rowCount) && input.rowCount > 0
    ? input.rowCount
    : 0;
  const rowHeight = Number.isFinite(input.rowHeight) && input.rowHeight > 0
    ? input.rowHeight
    : COMPARE_ROW_HEIGHT_ESTIMATE;
  const detailIndex = validDetailIndex(rowCount, input.detailIndex);
  const detailHeight = detailIndex >= 0
    && Number.isFinite(input.detailHeight)
    && input.detailHeight > 0
    ? input.detailHeight
    : 0;
  const bodyHeight = rowCount * rowHeight + detailHeight;
  if (rowCount === 0) {
    return { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0, bodyHeight: 0 };
  }

  const rowIndexAtOffset = (offset: number): number => {
    let adjusted = Math.max(0, Number.isFinite(offset) ? offset : 0);
    if (detailIndex >= 0) {
      const detailTop = (detailIndex + 1) * rowHeight;
      if (adjusted >= detailTop && adjusted < detailTop + detailHeight) {
        return detailIndex;
      }
      if (adjusted >= detailTop + detailHeight) adjusted -= detailHeight;
    }
    return Math.max(0, Math.min(rowCount - 1, Math.floor(adjusted / rowHeight)));
  };

  const bodyViewportTop = Math.max(
    0,
    Number.isFinite(input.bodyViewportTop) ? input.bodyViewportTop : 0,
  );
  const viewportHeight = Math.max(
    0,
    Number.isFinite(input.viewportHeight) ? input.viewportHeight : 0,
  );
  const overscan = Math.max(
    0,
    Number.isFinite(input.overscan) ? input.overscan : 0,
  );
  const start = rowIndexAtOffset(bodyViewportTop - overscan);
  const end = Math.min(
    rowCount,
    rowIndexAtOffset(bodyViewportTop + viewportHeight + overscan) + 1,
  );
  const topSpacer = compareRowTop(
    start,
    rowHeight,
    detailIndex,
    detailHeight,
  );
  const bottomSpacer = Math.max(
    0,
    bodyHeight - compareRowTop(end, rowHeight, detailIndex, detailHeight),
  );
  return { start, end, topSpacer, bottomSpacer, bodyHeight };
}
