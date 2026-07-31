import { describe, expect, it } from 'vitest';
import {
  rowDetailSurface,
  rowDetailWrite,
  type RowDetailSurface,
} from '../src/lib/row-detail.ts';

describe('row detail presentation', () => {
  it('parses only governed surface discriminants', () => {
    expect(rowDetailSurface({ surface: 'book-sheet', doc: 'a' })).toBe('book-sheet');
    expect(rowDetailSurface({ surface: 'query-editor' })).toBe('query-editor');
    expect(rowDetailSurface({ surface: 'foreign' })).toBeNull();
    expect(rowDetailSurface(null)).toBeNull();
    expect(rowDetailSurface([])).toBeNull();
  });

  it('pushes the first detail, nests only structure from a book, and replaces laterally', () => {
    const surfaces: readonly RowDetailSurface[] = [
      'query-editor',
      'book-sheet',
      'structure-editor',
      'vocab-filter',
      'vocab-row',
    ];
    for (const next of surfaces) expect(rowDetailWrite(null, next)).toBe('push');
    for (const top of surfaces) {
      for (const next of surfaces) {
        expect(rowDetailWrite(top, next)).toBe(
          top === 'book-sheet' && next === 'structure-editor' ? 'push' : 'replace',
        );
      }
    }
  });
});
