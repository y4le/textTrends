import {
  clampMatchesColumnWidth,
  MATCHES_COLUMN_LIMITS,
  type MatchesColumnSettings,
  type MatchesFixedColumn,
  type MatchesTrackWidth,
} from './matches-columns.ts';

export const MATCHES_COLUMN_STORAGE_KEY = 'texttrends/matches-columns/3';
const CONTEXT_COLUMNS = ['left', 'right'] as const;

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

function storedFixedWidth(
  record: Record<string, unknown>,
  column: MatchesFixedColumn,
): MatchesTrackWidth | null {
  const value = record[column];
  if (value === 'auto') return value;
  const limits = MATCHES_COLUMN_LIMITS[column];
  if (typeof value !== 'number'
    || !Number.isInteger(value)
    || value < limits.min
    || value > limits.max) return null;
  return clampMatchesColumnWidth(column, value);
}

/** Session storage survives refresh without making column geometry portable
 * workspace semantics. Only ratios, character widths, and explicit auto intent
 * are persisted; resolved viewport pixels never are. */
export function loadMatchesColumnSettings(
  storage: StorageReader | null,
): MatchesColumnSettings | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(MATCHES_COLUMN_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join('\u001f') !== ['book', 'left', 'node', 'right'].join('\u001f')) {
      return null;
    }
    const context = {} as Record<(typeof CONTEXT_COLUMNS)[number], number>;
    for (const column of CONTEXT_COLUMNS) {
      const value = record[column];
      const limits = MATCHES_COLUMN_LIMITS[column];
      if (typeof value !== 'number'
        || !Number.isInteger(value)
        || value < limits.min
        || value > limits.max) return null;
      context[column] = value;
    }
    const node = storedFixedWidth(record, 'node');
    const book = storedFixedWidth(record, 'book');
    if (node === null || book === null) return null;
    return { ...context, node, book };
  } catch {
    return null;
  }
}

export function saveMatchesColumnSettings(
  storage: StorageWriter | null,
  settings: MatchesColumnSettings,
): void {
  if (storage === null) return;
  try {
    storage.setItem(MATCHES_COLUMN_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be disabled or full; resizing remains functional for the
    // lifetime of the current page.
  }
}

export function browserSessionStorage(target: Window): Storage | null {
  try {
    return target.sessionStorage;
  } catch {
    return null;
  }
}
