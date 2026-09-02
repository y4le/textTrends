import {
  VOCABULARY_COLUMNS,
  type VocabularyColumnSettings,
} from './vocabulary-columns.ts';
import {
  definePreference,
  exactKeys,
  recordOf,
  type PreferenceReader,
  type PreferenceWriter,
} from './preference-store.ts';
import { VOCABULARY_COLUMN_PREFERENCE_DESCRIPTOR } from './preferences.ts';

export const VOCABULARY_COLUMN_STORAGE_KEY = VOCABULARY_COLUMN_PREFERENCE_DESCRIPTOR.key;
/** Vocabulary widths are scale-independent weights. Keeping them in session
 * storage matches the Matches presentation contract without making viewport
 * geometry part of a portable workspace. */
function parseVocabularyColumnSettings(value: unknown): VocabularyColumnSettings | null {
  const record = recordOf(value);
  if (record === null || !exactKeys(record, VOCABULARY_COLUMNS)) return null;
  const settings = {} as Record<(typeof VOCABULARY_COLUMNS)[number], number>;
  for (const column of VOCABULARY_COLUMNS) {
    const width = record[column];
    if (typeof width !== 'number' || !Number.isInteger(width) || width < 1 || width > 99) {
      return null;
    }
    settings[column] = width;
  }
  if (Object.values(settings).reduce((sum, width) => sum + width, 0) !== 100) return null;
  return settings;
}

export const VOCABULARY_COLUMN_PREFERENCE = definePreference<VocabularyColumnSettings>({
  key: VOCABULARY_COLUMN_STORAGE_KEY,
  scope: VOCABULARY_COLUMN_PREFERENCE_DESCRIPTOR.scope,
  parse: parseVocabularyColumnSettings,
  serialize: parseVocabularyColumnSettings,
});

export function loadVocabularyColumnSettings(
  storage: PreferenceReader | null,
): VocabularyColumnSettings | null {
  return VOCABULARY_COLUMN_PREFERENCE.load(storage);
}

export function saveVocabularyColumnSettings(
  storage: PreferenceWriter | null,
  settings: VocabularyColumnSettings,
): void {
  VOCABULARY_COLUMN_PREFERENCE.save(storage, settings);
}
