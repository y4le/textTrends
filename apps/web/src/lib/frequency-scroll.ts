/** Position one primary Vocabulary row in the virtual body. Expanded detail
 * belongs after its primary row and therefore shifts every later row. */
export function frequencyRowTop(
  index: number,
  rowHeight: number,
  expandedIndex: number,
  detailHeight: number,
): number {
  const boundedIndex = Math.max(0, Math.floor(index));
  const pitch = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1;
  const detail = Number.isFinite(detailHeight) && detailHeight > 0 ? detailHeight : 0;
  return boundedIndex * pitch
    + (expandedIndex >= 0 && boundedIndex > expandedIndex ? detail : 0);
}

/** Return the first primary row whose top edge is not above the visible body
 * edge. This is the semantic anchor retained when density changes row pitch. */
export function firstFullyVisibleFrequencyRow(input: {
  readonly scrollTop: number;
  readonly rowCount: number;
  readonly rowHeight: number;
  readonly expandedIndex: number;
  readonly detailHeight: number;
}): number {
  if (!Number.isSafeInteger(input.rowCount) || input.rowCount <= 0) return 0;
  const target = Math.max(0, Number.isFinite(input.scrollTop) ? input.scrollTop : 0);
  let low = 0;
  let high = input.rowCount;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const top = frequencyRowTop(
      middle,
      input.rowHeight,
      input.expandedIndex,
      input.detailHeight,
    );
    if (top + 0.01 < target) low = middle + 1;
    else high = middle;
  }
  return Math.min(input.rowCount - 1, low);
}
