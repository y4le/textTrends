import type { WorkspaceTrendViewV1 } from '@texttrends/core';

export type TrendView = WorkspaceTrendViewV1['mode'];

export const DEFAULT_TREND_VIEW: TrendView = 'by-book';

export const TREND_VIEW_ORDER: readonly TrendView[] = [
  'series',
  'by-book',
  'by-book-scaled',
];

export function nextTrendView(view: TrendView): TrendView {
  const index = TREND_VIEW_ORDER.indexOf(view);
  return TREND_VIEW_ORDER[(index + 1) % TREND_VIEW_ORDER.length] ?? DEFAULT_TREND_VIEW;
}

export function trendViewLabel(view: TrendView): string {
  if (view === 'series') return 'combined';
  if (view === 'by-book') return 'equal';
  return 'to scale';
}

export function trendViewAccessibleName(view: TrendView): string {
  if (view === 'series') return 'Combined sequence';
  if (view === 'by-book') return 'Separate rows, equal width';
  return 'To scale — separate rows, same token scale';
}

/** One x denominator per row. Equal rows use their own token extents; scaled
 * rows share the longest document's extent so one x always means one token. */
export function trendRowDomain(
  view: TrendView,
  tokenCounts: readonly number[],
): readonly number[] {
  if (view !== 'by-book-scaled') return tokenCounts;
  const shared = Math.max(0, ...tokenCounts);
  return tokenCounts.map(() => shared);
}
