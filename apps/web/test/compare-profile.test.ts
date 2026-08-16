import { describe, expect, it } from 'vitest';
import type {
  InventoryDocumentRowV1,
  InventoryResultV1,
} from '@texttrends/core';
import {
  compareProfile,
  hapaxShare,
  meanParagraphTokens,
  meanSentenceTokens,
  sideMattr,
  sideReadability,
} from '../src/lib/compare-profile.ts';

const documentRow = (
  overrides: Partial<InventoryDocumentRowV1>,
): InventoryDocumentRowV1 => ({
  doc: 'a',
  selectedTokens: 1_000,
  fullTokens: 1_000,
  lexicalTokens: 1_000,
  numeralTokens: 0,
  types: 400,
  hapax: 200,
  sentences: 50,
  paragraphs: 10,
  sentenceMean: 20,
  sentenceMedian: 18,
  sentenceP90: 34,
  paragraphMean: 100,
  ttr: 0.4,
  mattr: 0.7,
  mattrIsPlainTtr: false,
  charsUtf16: 6_000,
  readabilityCharacters: 5_000,
  readabilityLetters: 5_000,
  ...overrides,
});

const result = (
  totals: Partial<InventoryResultV1['totals']>,
  documents: readonly InventoryDocumentRowV1[] = [documentRow({})],
): InventoryResultV1 => ({
  method: 'inventory/1',
  selection: 'sha256:s' as InventoryResultV1['selection'],
  order: documents.map((row) => row.doc),
  totals: {
    selectedDocs: documents.length,
    expectedDocs: documents.length,
    missingDocs: 0,
    tokens: 1_000,
    lexicalTokens: 1_000,
    numeralTokens: 0,
    types: 400,
    hapax: 200,
    sentences: 50,
    paragraphs: 10,
    charsUtf16: 6_000,
    readabilityCharacters: 5_000,
    readabilityLetters: 5_000,
    ...totals,
  },
  documents,
  rhythm: null,
  missingDocs: [],
  mattrWindow: 500,
});

describe('side MATTR', () => {
  it('token-weights the per-document values rather than concatenating texts', () => {
    // 0.8 over 3,000 tokens and 0.6 over 1,000 → (0.8·3000 + 0.6·1000)/4000.
    expect(sideMattr([
      documentRow({ doc: 'a', selectedTokens: 3_000, mattr: 0.8 }),
      documentRow({ doc: 'b', selectedTokens: 1_000, mattr: 0.6 }),
    ])).toBeCloseTo(0.75, 12);
  });

  it('excludes documents whose MATTR degraded to a plain TTR', () => {
    // Averaging a windowed measurement with an unwindowed one would report a
    // number that is neither.
    expect(sideMattr([
      documentRow({ doc: 'a', selectedTokens: 3_000, mattr: 0.8 }),
      documentRow({ doc: 'b', selectedTokens: 1_000, mattr: 0.2, mattrIsPlainTtr: true }),
    ])).toBeCloseTo(0.8, 12);
  });

  it('is null when no document carries a usable value', () => {
    expect(sideMattr([])).toBeNull();
    expect(sideMattr([documentRow({ mattr: null })])).toBeNull();
    expect(sideMattr([documentRow({ mattrIsPlainTtr: true })])).toBeNull();
    expect(sideMattr([documentRow({ selectedTokens: 0 })])).toBeNull();
  });
});

describe('side derivations', () => {
  it('reports hapax as a share of types, not a raw total', () => {
    expect(hapaxShare(result({ types: 400, hapax: 200 }))).toBeCloseTo(500, 12);
    expect(hapaxShare(result({ types: 0, hapax: 0 }))).toBeNull();
  });

  it('reports mean sentence and paragraph length', () => {
    expect(meanSentenceTokens(result({ tokens: 1_000, sentences: 50 }))).toBe(20);
    expect(meanParagraphTokens(result({ tokens: 1_000, paragraphs: 10 }))).toBe(100);
    expect(meanSentenceTokens(result({ sentences: 0 }))).toBeNull();
    expect(meanParagraphTokens(result({ paragraphs: 0 }))).toBeNull();
  });

  it('builds ARI from characters inside tokens, not the token span extent', () => {
    // 5,000 token chars over 1,000 words and 50 sentences.
    expect(sideReadability(result({}))).toBeCloseTo(4.71 * 5 + 0.5 * 20 - 21.43, 9);
    // The wider span extent would report a materially higher grade, which is
    // why the profile must not reach for `charsUtf16`.
    expect(sideReadability(result({}))).not.toBeCloseTo(
      4.71 * 6 + 0.5 * 20 - 21.43,
      3,
    );
  });

  it('declines ARI when a side has no sentences or no tokens', () => {
    expect(sideReadability(result({ sentences: 0 }))).toBeNull();
    expect(sideReadability(result({ tokens: 0 }))).toBeNull();
  });
});

describe('compare profile', () => {
  it('survives a side that has not measured yet', () => {
    const metrics = compareProfile(result({}), null);
    expect(metrics.every((metric) => metric.b === null)).toBe(true);
    expect(metrics.find((metric) => metric.key === 'tokens')!.a).toBe(1_000);
  });
});
