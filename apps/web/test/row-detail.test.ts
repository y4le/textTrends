import { describe, expect, it } from 'vitest';
import {
  renderedRowDetailLayer,
  rowDetailSurface,
  rowDetailWrite,
  type RowDetailSurface,
} from '../src/lib/row-detail.ts';

describe('row detail presentation', () => {
  it('parses only governed surface discriminants', () => {
    expect(rowDetailSurface({ surface: 'book-sheet', doc: 'a' })).toBe('book-sheet');
    expect(rowDetailSurface({ surface: 'query-editor' })).toBe('query-editor');
    expect(rowDetailSurface({ surface: 'compare-settings' })).toBe('compare-settings');
    expect(rowDetailSurface({ surface: 'compare-row' })).toBe('compare-row');
    expect(rowDetailSurface({ surface: 'foreign' })).toBeNull();
    expect(rowDetailSurface(null)).toBeNull();
    expect(rowDetailSurface([])).toBeNull();
  });

  it('pushes the first detail and replaces laterally', () => {
    const surfaces: readonly RowDetailSurface[] = [
      'query-editor',
      'book-sheet',
      'vocab-filter',
      'vocab-row',
      'compare-settings',
      'compare-row',
    ];
    for (const next of surfaces) expect(rowDetailWrite(null, next)).toBe('push');
    for (const top of surfaces) {
      for (const next of surfaces) {
        expect(rowDetailWrite(top, next)).toBe('replace');
      }
    }
  });

  it('renders only an active row detail', () => {
    const row = {
      kind: 'row-detail' as const,
      id: 'row',
      target: { surface: 'vocab-row' },
      returnFocusTo: 'vocabulary-row-1',
    };
    const reader = {
      kind: 'reader' as const,
      id: 'reader',
      target: { doc: 'a', token: 0 },
      returnFocusTo: 'row',
    };
    expect(renderedRowDetailLayer([row])).toBe(row);
    expect(renderedRowDetailLayer([row, reader])).toBeUndefined();
    expect(renderedRowDetailLayer([reader])).toBeUndefined();
  });
});
