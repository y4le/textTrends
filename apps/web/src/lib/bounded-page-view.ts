import { FREQUENCY_WINDOW_MAX } from '@texttrends/core';

export interface BoundedPageView {
  readonly label: string;
  readonly canNext: boolean;
  readonly atWindow: boolean;
}

/** Shared presentation for analyses bounded by the 5,000-row worker window. */
export function boundedPageView(
  total: number,
  offset: number,
  limit: number,
  rowCount: number,
): BoundedPageView {
  if (total === 0) return { label: '0 rows', canNext: false, atWindow: false };
  const nextOffset = offset + limit;
  const atWindow = nextOffset >= FREQUENCY_WINDOW_MAX && nextOffset < total;
  return {
    label: `rows ${(offset + 1).toLocaleString('en-US')}–${Math.min(total, offset + rowCount).toLocaleString('en-US')}`,
    canNext: nextOffset < total && nextOffset + limit <= FREQUENCY_WINDOW_MAX,
    atWindow,
  };
}
