import { describe, expect, it } from 'vitest';
import {
  loadVocabularyColumnSettings,
  saveVocabularyColumnSettings,
} from '../src/lib/vocabulary-column-storage.ts';
import { VOCABULARY_COLUMN_DEFAULTS } from '../src/lib/vocabulary-columns.ts';

const memoryStorage = (initial: string | null = null) => {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    removeItem: () => { value = null; },
  };
};

describe('Vocabulary column session storage', () => {
  it('round-trips scale-independent weights', () => {
    const storage = memoryStorage();
    saveVocabularyColumnSettings(storage, VOCABULARY_COLUMN_DEFAULTS);
    expect(loadVocabularyColumnSettings(storage)).toEqual(VOCABULARY_COLUMN_DEFAULTS);
  });

  it('rejects malformed, partial, and non-partition settings', () => {
    expect(loadVocabularyColumnSettings(memoryStorage('{bad'))).toBeNull();
    expect(loadVocabularyColumnSettings(memoryStorage(JSON.stringify({ key: 100 })))).toBeNull();
    expect(loadVocabularyColumnSettings(memoryStorage(JSON.stringify({
      ...VOCABULARY_COLUMN_DEFAULTS,
      key: 27,
    })))).toBeNull();
  });

  it('degrades when storage is unavailable', () => {
    expect(loadVocabularyColumnSettings(null)).toBeNull();
    expect(() => saveVocabularyColumnSettings({
      setItem: () => { throw new Error('disabled'); },
      removeItem: () => { throw new Error('disabled'); },
    }, VOCABULARY_COLUMN_DEFAULTS)).not.toThrow();
  });
});
