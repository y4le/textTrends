import { KWIC_CONTEXT_MAX_TOKENS } from '@texttrends/core';
import type { WidthClass } from './presentation.ts';
import {
  fitTextColumn,
  partitionedGridTemplate,
  type PartitionTrack,
} from './column-layout.ts';

export type MatchesColumn = 'left' | 'node' | 'right' | 'book';
export type MatchesFixedColumn = Exclude<MatchesColumn, 'left' | 'right'>;
export type MatchesTrackWidth = number | 'auto';

/** Persisted presentation intent. Context values are scale-independent weights;
 * fixed columns are either explicit character cells or content-sized. */
export interface MatchesColumnSettings {
  readonly left: number;
  readonly node: MatchesTrackWidth;
  readonly right: number;
  readonly book: MatchesTrackWidth;
}

export interface ResolvedMatchesColumns {
  readonly left: number;
  readonly node: number;
  readonly right: number;
  readonly book: number;
  readonly token: number;
}

export interface MatchesColumnContent {
  readonly nodes: readonly string[];
  readonly books: readonly string[];
  readonly tokens: readonly string[];
}

export interface MatchesColumnLimit {
  readonly min: number;
  readonly max: number;
}

/** Most resizing stays presentation-only because this base reserve supplies
 * ample text for ordinary layouts. Exceptionally wide context columns request
 * more progressively, up to the shared core bound. */
export const MATCHES_CONTEXT_TOKENS = 64;
export const MATCHES_CONTEXT_TOKENS_MAX = KWIC_CONTEXT_MAX_TOKENS;

export const MATCHES_COLUMN_DEFAULTS: MatchesColumnSettings = Object.freeze({
  left: 1,
  node: 'auto',
  right: 1,
  book: 'auto',
});

export const MATCHES_COLUMN_LIMITS: Readonly<Record<MatchesColumn, MatchesColumnLimit>> =
  Object.freeze({
    left: Object.freeze({ min: 1, max: 100 }),
    node: Object.freeze({ min: 1, max: 48 }),
    right: Object.freeze({ min: 1, max: 100 }),
    book: Object.freeze({ min: 3, max: 80 }),
  });

/** Widths are visible monospace character cells. Grid tracks add this padding
 * outside the content budget. */
export const MATCHES_COLUMN_PADDING_CH = 1.5;
export const MATCHES_COMPACT_BOOK_CH = 3;

export function clampMatchesColumnWidth(
  column: MatchesColumn,
  value: number,
): number {
  const limits = MATCHES_COLUMN_LIMITS[column];
  if (!Number.isFinite(value)) return limits.min;
  return Math.max(limits.min, Math.min(limits.max, Math.round(value)));
}

export function matchesNodeColumnWidth(values: readonly string[]): number {
  return fitTextColumn(
    values.map((value) => value.replace(/\s+/gu, ' ').trim()),
    MATCHES_COLUMN_LIMITS.node.min,
    MATCHES_COLUMN_LIMITS.node.max,
  );
}

export function matchesBookColumnWidth(
  values: readonly string[],
  widthClass: WidthClass,
): number {
  if (widthClass !== 'wide') return MATCHES_COMPACT_BOOK_CH;
  return fitTextColumn(
    values,
    MATCHES_COLUMN_LIMITS.book.min,
    MATCHES_COLUMN_LIMITS.book.max,
  );
}

export function matchesTokenLabel(value: string, widthClass: WidthClass): string {
  if (widthClass === 'wide') return value;
  const separator = value.indexOf('/');
  return separator === -1 ? value : value.slice(0, separator).trimEnd();
}

export function matchesTokenColumnWidth(
  values: readonly string[],
  widthClass: WidthClass,
): number {
  return fitTextColumn(
    values.map((value) => matchesTokenLabel(value, widthClass)),
    5,
    48,
  );
}

export function resolvedMatchesColumns(
  settings: MatchesColumnSettings,
  content: MatchesColumnContent,
  widthClass: WidthClass,
): ResolvedMatchesColumns {
  return {
    left: settings.left,
    node: settings.node === 'auto'
      ? matchesNodeColumnWidth(content.nodes)
      : clampMatchesColumnWidth('node', settings.node),
    right: settings.right,
    book: settings.book === 'auto'
      ? matchesBookColumnWidth(content.books, widthClass)
      : clampMatchesColumnWidth('book', settings.book),
    token: matchesTokenColumnWidth(content.tokens, widthClass),
  };
}

export function matchesGridTemplate(
  columns: ResolvedMatchesColumns,
  options: { readonly book: boolean },
): string {
  const fixed = (width: number): PartitionTrack => ({
    kind: 'fixed',
    preferred: `calc(${width}ch + ${MATCHES_COLUMN_PADDING_CH}ch)`,
  });
  const tracks: PartitionTrack[] = [
    { kind: 'elastic', weight: columns.left },
    fixed(columns.node),
    { kind: 'elastic', weight: columns.right },
  ];
  if (options.book) tracks.push(fixed(columns.book));
  tracks.push(fixed(columns.token));
  return partitionedGridTemplate(tracks);
}

export function matchesColumnWidthFromDrag(
  column: MatchesColumn,
  startWidth: number,
  deltaPx: number,
  chPx: number,
): number {
  if (!Number.isFinite(deltaPx) || !(chPx > 0)) {
    return clampMatchesColumnWidth(column, startWidth);
  }
  return clampMatchesColumnWidth(column, startWidth + deltaPx / chPx);
}

export function matchesColumnWidthFromKey(
  column: MatchesColumn,
  current: number,
  key: string,
  shiftKey = false,
): number | null {
  const limits = MATCHES_COLUMN_LIMITS[column];
  const step = shiftKey ? 8 : 1;
  switch (key) {
    case 'ArrowLeft':
      return clampMatchesColumnWidth(column, current - step);
    case 'ArrowRight':
      return clampMatchesColumnWidth(column, current + step);
    case 'Home':
      return limits.min;
    case 'End':
      return limits.max;
    default:
      return null;
  }
}

export function isDefaultMatchesColumns(settings: MatchesColumnSettings): boolean {
  return (Object.keys(MATCHES_COLUMN_DEFAULTS) as MatchesColumn[]).every(
    (column) => settings[column] === MATCHES_COLUMN_DEFAULTS[column],
  );
}
