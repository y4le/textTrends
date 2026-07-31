import { describe, expect, it } from 'vitest';
import {
  structureEditControlId,
  structureEditorTarget,
} from '../src/lib/structure-surface.ts';

describe('structure editor surface', () => {
  it('totally parses only governed structure editor targets', () => {
    expect(structureEditorTarget({ surface: 'structure-editor', doc: 'a' }))
      .toEqual({ surface: 'structure-editor', doc: 'a' });
    for (const value of [
      null,
      [],
      { surface: 'structure-editor' },
      { surface: 'structure-editor', doc: '' },
      { surface: 'book-sheet', doc: 'a' },
    ]) {
      expect(structureEditorTarget(value)).toBeNull();
    }
  });

  it('builds a single-token focus-return id for human-readable docs', () => {
    expect(structureEditControlId('1 - A Study in Scarlet')).toBe(
      'structure-edit-1%20-%20A%20Study%20in%20Scarlet',
    );
  });
});
