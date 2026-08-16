import { describe, expect, it } from 'vitest';
import {
  isDefaultVocabularyColumns,
  resetVocabularyColumnBoundary,
  vocabularyColumnBoundaryFromDrag,
  vocabularyColumnBoundaryFromKey,
  vocabularyGridTemplate,
  VOCABULARY_COLUMN_DEFAULTS,
} from '../src/lib/vocabulary-columns.ts';

describe('Vocabulary column geometry', () => {
  it('partitions every column without intrinsic width floors', () => {
    expect(vocabularyGridTemplate(VOCABULARY_COLUMN_DEFAULTS)).toBe(
      'minmax(0, 32fr) minmax(0, 15fr) minmax(0, 11fr) minmax(0, 11fr) '
      + 'minmax(0, 14fr) minmax(0, 17fr)',
    );
  });

  it('moves one boundary while preserving the pair and total weights', () => {
    const dragged = vocabularyColumnBoundaryFromDrag(
      VOCABULARY_COLUMN_DEFAULTS,
      'key',
      50,
      100,
      100,
    );
    expect(dragged.key + dragged.count).toBe(47);
    expect(dragged.key).toBeGreaterThan(VOCABULARY_COLUMN_DEFAULTS.key);
    expect(Object.values(dragged).reduce((sum, width) => sum + width, 0)).toBe(100);

    const keyed = vocabularyColumnBoundaryFromKey(dragged, 'key', 'ArrowLeft', true)!;
    expect(keyed.key).toBe(dragged.key - 5);
    expect(keyed.key + keyed.count).toBe(47);
  });

  it('resets one boundary and recognizes the complete default', () => {
    const changed = vocabularyColumnBoundaryFromKey(
      VOCABULARY_COLUMN_DEFAULTS,
      'dp',
      'ArrowRight',
    )!;
    expect(isDefaultVocabularyColumns(changed)).toBe(false);
    expect(resetVocabularyColumnBoundary(changed, 'dp')).toEqual(VOCABULARY_COLUMN_DEFAULTS);
    expect(isDefaultVocabularyColumns(VOCABULARY_COLUMN_DEFAULTS)).toBe(true);
  });
});
