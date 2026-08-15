import {
  VOCABULARY_COLUMNS,
  type VocabularyColumnSettings,
} from './vocabulary-columns.ts';

const STORAGE_KEY = 'texttrends/vocabulary-columns/1';
type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

/** Vocabulary widths are scale-independent weights. Keeping them in session
 * storage matches the Matches presentation contract without making viewport
 * geometry part of a portable workspace. */
export function loadVocabularyColumnSettings(
  storage: StorageReader | null,
): VocabularyColumnSettings | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).sort().join('\u001f')
      !== [...VOCABULARY_COLUMNS].sort().join('\u001f')) return null;
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
  } catch {
    return null;
  }
}

export function saveVocabularyColumnSettings(
  storage: StorageWriter | null,
  settings: VocabularyColumnSettings,
): void {
  if (storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Disabled/full storage does not prevent resizing for this mount.
  }
}

export function vocabularySessionStorage(target: Window): Storage | null {
  try {
    return target.sessionStorage;
  } catch {
    return null;
  }
}
