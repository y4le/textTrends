import {
  clampMatchesColumnWidth,
  MATCHES_COLUMN_LIMITS,
  type MatchesColumnSettings,
  type MatchesFixedColumn,
  type MatchesTrackWidth,
} from './matches-columns.ts';
import {
  definePreference,
  exactKeys,
  recordOf,
  type PreferenceReader,
  type PreferenceWriter,
} from './preference-store.ts';
import { MATCHES_COLUMN_PREFERENCE_DESCRIPTOR } from './preferences.ts';

export const MATCHES_COLUMN_STORAGE_KEY = MATCHES_COLUMN_PREFERENCE_DESCRIPTOR.key;
const CONTEXT_COLUMNS = ['left', 'right'] as const;

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
function parseMatchesColumnSettings(value: unknown): MatchesColumnSettings | null {
  const record = recordOf(value);
  if (record === null || !exactKeys(record, ['book', 'left', 'node', 'right'])) return null;
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
}

export const MATCHES_COLUMN_PREFERENCE = definePreference<MatchesColumnSettings>({
  key: MATCHES_COLUMN_STORAGE_KEY,
  scope: MATCHES_COLUMN_PREFERENCE_DESCRIPTOR.scope,
  parse: parseMatchesColumnSettings,
  serialize: parseMatchesColumnSettings,
});

export function loadMatchesColumnSettings(
  storage: PreferenceReader | null,
): MatchesColumnSettings | null {
  return MATCHES_COLUMN_PREFERENCE.load(storage);
}

export function saveMatchesColumnSettings(
  storage: PreferenceWriter | null,
  settings: MatchesColumnSettings,
): void {
  MATCHES_COLUMN_PREFERENCE.save(storage, settings);
}
