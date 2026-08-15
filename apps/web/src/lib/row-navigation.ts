import {
  shortcutMatches,
  type ShortcutEventLike,
  type ShortcutId,
} from './shortcuts.ts';

export type RowNavigationShortcutId =
  | 'row-previous'
  | 'row-next'
  | 'row-page-previous'
  | 'row-page-next'
  | 'row-half-page-previous'
  | 'row-half-page-next'
  | 'row-first'
  | 'row-last'
  | 'row-exit';

export const ROW_NAVIGATION_SHORTCUT_IDS: readonly ShortcutId[] = Object.freeze([
  'row-previous',
  'row-next',
  'row-page-previous',
  'row-page-next',
  'row-half-page-previous',
  'row-half-page-next',
  'row-first',
  'row-last',
  'row-open',
  'row-exit',
]);

const MOVE_IDS: readonly RowNavigationShortcutId[] = Object.freeze([
  'row-previous',
  'row-next',
  'row-page-previous',
  'row-page-next',
  'row-half-page-previous',
  'row-half-page-next',
  'row-first',
  'row-last',
  'row-exit',
]);

export function rowNavigationShortcut(
  event: ShortcutEventLike,
): RowNavigationShortcutId | null {
  return MOVE_IDS.find((id) => shortcutMatches(event, id)) ?? null;
}

export function visibleRowPageSize(
  containerHeight: number,
  viewportHeight: number,
  rowHeight: number,
): number {
  if (!(rowHeight > 0)) return 1;
  const boundedContainer = containerHeight > 0
    ? Math.min(containerHeight, viewportHeight)
    : viewportHeight;
  return Math.max(1, Math.floor(boundedContainer / rowHeight));
}

export function rowNavigationTarget(
  length: number,
  current: number,
  shortcut: Exclude<RowNavigationShortcutId, 'row-exit'>,
  pageSize: number,
): number {
  if (length <= 0) return -1;
  const boundedCurrent = Math.max(0, Math.min(length - 1, current));
  const step = Math.max(1, Math.floor(pageSize));
  switch (shortcut) {
    case 'row-previous':
      return Math.max(0, boundedCurrent - 1);
    case 'row-next':
      return Math.min(length - 1, boundedCurrent + 1);
    case 'row-page-previous':
      return Math.max(0, boundedCurrent - step);
    case 'row-page-next':
      return Math.min(length - 1, boundedCurrent + step);
    case 'row-half-page-previous':
      return Math.max(0, boundedCurrent - Math.max(1, Math.floor(step / 2)));
    case 'row-half-page-next':
      return Math.min(length - 1, boundedCurrent + Math.max(1, Math.floor(step / 2)));
    case 'row-first':
      return 0;
    case 'row-last':
      return length - 1;
  }
}
