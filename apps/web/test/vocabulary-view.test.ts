import { describe, expect, it } from 'vitest';
import {
  frequencyMeasure,
  frequencyRegexError,
  vocabularyRowControlId,
  vocabularyTarget,
  vocabularyTargetIsStale,
} from '../src/lib/vocabulary-view.ts';

describe('vocabulary view law', () => {
  it('totally guards row targets', () => {
    expect(vocabularyTarget({ surface: 'vocab-row', typeId: 7, key: 'Holmes' }))
      .toEqual({ surface: 'vocab-row', typeId: 7, key: 'Holmes' });
    for (const value of [
      null,
      [],
      { surface: 'vocab-row', typeId: -1, key: 'x' },
      { surface: 'vocab-row', typeId: 1.5, key: 'x' },
      { surface: 'vocab-row', typeId: 1, key: '' },
      { surface: 'vocab-filter' },
      { surface: 'foreign', typeId: 1, key: 'x' },
    ]) expect(vocabularyTarget(value)).toBeNull();
    expect(vocabularyRowControlId(7)).toBe('vocabulary-row-7');
    expect(vocabularyRowControlId(7)).not.toContain('Holmes');
  });

  it('maps every sort to an honest compact measure', () => {
    const row = {
      key: 'Holmes',
      typeId: 7,
      class: 'lexical' as const,
      count: 1_234,
      ratePer10k: 12.5,
      docFreq: 4,
      dp: null,
      dpNorm: 0.25,
    };
    expect(frequencyMeasure(row, 'key')).toMatchObject({
      field: 'count',
      label: 'count',
      value: '1,234',
    });
    expect(frequencyMeasure(row, 'docFreq').value).toBe('4');
    expect(frequencyMeasure(row, 'dp').value).toBe('unavailable');
    expect(frequencyMeasure(row, 'dpNorm').value).toBe('0.25');
  });

  it('retains targets provisionally until a ready result proves an exact row stale', () => {
    const target = { surface: 'vocab-row' as const, typeId: 7, key: 'Holmes' };
    const pending = {
      snapshot: 's1',
      selection: null,
      state: { status: 'pending' as const },
    };
    const error = {
      snapshot: 's1',
      selection: null,
      state: { status: 'error' as const, message: 'failed' },
    };
    const ready = (rows: readonly {
      key: string;
      typeId: number;
      class: 'lexical';
      count: number;
      ratePer10k: number;
      docFreq: number;
      dp: number | null;
      dpNorm: number | null;
    }[]) => ({
      snapshot: 's1',
      selection: null,
      state: {
        status: 'ready' as const,
        result: {
          method: 'freq-list/1' as const,
          selection: 'all' as never,
          total: rows.length,
          totalTokens: 1,
          parts: 1,
          rows,
        },
      },
    });
    const row = {
      key: 'Holmes',
      typeId: 7,
      class: 'lexical' as const,
      count: 1,
      ratePer10k: 1,
      docFreq: 1,
      dp: null,
      dpNorm: null,
    };

    expect(vocabularyTargetIsStale(target, true, pending)).toBe(false);
    expect(vocabularyTargetIsStale(target, true, error)).toBe(false);
    expect(vocabularyTargetIsStale(target, true, ready([row]))).toBe(false);
    expect(vocabularyTargetIsStale(target, true, ready([]))).toBe(true);
    expect(vocabularyTargetIsStale(target, false, pending)).toBe(true);
  });

  it('validates bounded Unicode regular expressions', () => {
    expect(frequencyRegexError('')).toBeNull();
    expect(frequencyRegexError('^Holmes$|Watson')).toBeNull();
    expect(frequencyRegexError('[')).toMatch(/Invalid regular expression/);
    expect(frequencyRegexError('x'.repeat(257))).toMatch(/256/);
  });
});
