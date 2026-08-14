import { describe, expect, it } from 'vitest';
import {
  bookDetailRegionId,
  bookDetailView,
  bookGrowthHeadingId,
  bookInventoryHeadingId,
  bookRhythmHeadingId,
  bookSheetTarget,
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
  rhythm: {
    binsPerDoc: 4,
    docOrdinal: Uint32Array.from([0]),
    binIndex: Uint32Array.from([0]),
    binStartToken: Uint32Array.from([0]),
    binTokens: Uint32Array.from([10]),
    sentences: Uint32Array.from([2]),
    sentenceMean: Float64Array.from([5]),
    sentenceMedian: Float64Array.from([5]),
  },
  growth: {
    tokens: Uint32Array.from([10]),
    types: Uint32Array.from([5]),
    documentEnds: [10],
  },
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
      bookInventoryHeadingId(doc),
      bookGrowthHeadingId(doc),
      bookRhythmHeadingId(doc),
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

  it('projects resident detail without inventing per-book growth', () => {
    const target = { surface: 'book-sheet', doc: 'a' } as const;
    expect(bookDetailView({
      target,
      title: 'Alpha',
      result,
      snapshotDocOrdinal: 0,
      selection: null,
    })).toMatchObject({
      doc: 'a',
      title: 'Alpha',
      growth: 'unscoped',
      vocabularyLabel: 'vocabulary (all texts)',
      rhythm: [{ mean: 5, tokens: 10, sentences: 2 }],
    });
    expect(bookDetailView({
      target,
      title: 'Alpha',
      result,
      snapshotDocOrdinal: 0,
      selection: { snapshot: 's', ranges: [{ doc: 'a', tokens: { start: 0, end: 10 } }] },
    })).toMatchObject({
      growth: 'scoped',
      vocabularyLabel: 'vocabulary for this text',
    });
    expect(bookDetailView({
      target,
      title: 'Alpha',
      result,
      snapshotDocOrdinal: 0,
      selection: { snapshot: 's', ranges: [{ doc: 'a', tokens: { start: 2, end: 4 } }] },
    })).toMatchObject({
      growth: 'unscoped',
      vocabularyLabel: 'vocabulary for the active range',
    });
    expect(bookDetailView({
      target: { surface: 'book-sheet', doc: 'missing' },
      title: 'Missing',
      result,
      snapshotDocOrdinal: -1,
      selection: null,
    })).toBeNull();

    expect(bookDetailView({
      target,
      title: 'Alpha',
      result: { ...result, growth: null },
      snapshotDocOrdinal: 0,
      selection: null,
    })).toMatchObject({ growth: 'absent' });
  });
});
