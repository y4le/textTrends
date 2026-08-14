import { describe, expect, it } from 'vitest';
import {
  bookDetailRegionId,
  bookDetailView,
  bookSheetTarget,
  bookSourceHeadingId,
  bookTitleControlId,
  isWholeBookSelection,
} from '../src/lib/corpus-view.ts';
import type { InventoryResultV1 } from '@texttrends/core';

const result: InventoryResultV1 = {
  method: 'inventory/1',
  selection: 'sha256:selection' as InventoryResultV1['selection'],
  order: ['a'],
  totals: {
    selectedDocs: 1,
    expectedDocs: 1,
    missingDocs: 0,
    tokens: 10,
    lexicalTokens: 9,
    numeralTokens: 1,
    types: 5,
    hapax: 2,
    sentences: 2,
    paragraphs: 1,
    charsUtf16: 20,
  },
  documents: [{
    doc: 'a',
    selectedTokens: 10,
    fullTokens: 10,
    lexicalTokens: 9,
    numeralTokens: 1,
    types: 5,
    hapax: 2,
    sentences: 2,
    paragraphs: 1,
    sentenceMean: 5,
    sentenceMedian: 5,
    sentenceP90: 6,
    paragraphMean: 10,
    ttr: 0.5,
    mattr: 0.5,
    mattrIsPlainTtr: true,
    charsUtf16: 20,
  }],
  rhythm: null,
  missingDocs: [],
  mattrWindow: 10,
};

describe('corpus view', () => {
  it('totally parses book-sheet targets', () => {
    expect(bookSheetTarget({ surface: 'book-sheet', doc: 'a' }))
      .toEqual({ surface: 'book-sheet', doc: 'a' });
    for (const value of [
      null,
      [],
      { surface: 'book-sheet' },
      { surface: 'book-sheet', doc: '' },
      { surface: 'query-editor', doc: 'a' },
    ]) {
      expect(bookSheetTarget(value)).toBeNull();
    }
  });

  it('builds whitespace-free, single-token DOM references for human-readable doc ids', () => {
    const doc = '1 - A Study in Scarlet - Arthur Conan Doyle';
    for (const id of [
      bookTitleControlId(doc),
      bookDetailRegionId(doc),
      bookSourceHeadingId(doc),
    ]) {
      expect(id).not.toMatch(/\s/u);
      expect(id).toContain(encodeURIComponent(doc));
    }
  });

  it('requires the exact whole-book range', () => {
    expect(isWholeBookSelection(null, 'a', 10)).toBe(false);
    expect(isWholeBookSelection({
      snapshot: 's',
      ranges: [{ doc: 'a', tokens: { start: 0, end: 10 } }],
    }, 'a', 10)).toBe(true);
    expect(isWholeBookSelection({
      snapshot: 's',
      ranges: [{ doc: 'a', tokens: { start: 1, end: 10 } }],
    }, 'a', 10)).toBe(false);
  });

  it('projects resident detail for the requested text', () => {
    const target = { surface: 'book-sheet', doc: 'a' } as const;
    expect(bookDetailView({
      target,
      title: 'Alpha',
      result,
    })).toMatchObject({
      doc: 'a',
      title: 'Alpha',
      stats: result.documents[0],
      mattrWindow: 10,
    });
    expect(bookDetailView({
      target: { surface: 'book-sheet', doc: 'missing' },
      title: 'Missing',
      result,
    })).toBeNull();
  });
});
