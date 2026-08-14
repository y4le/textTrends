import { describe, expect, it } from 'vitest';
import type { InventoryResultV1, NumericTrend } from '@texttrends/core';
import type { InventoryState, SeriesTrendState } from '../src/lib/store.ts';
import { fullTokenCountsForDocs, fullTokensByDoc } from '../src/lib/doc-tokens.ts';

const inventoryResult = (doc: string, fullTokens: number): InventoryResultV1 => ({
  method: 'inventory/1',
  selection: 'sha256:inventory' as InventoryResultV1['selection'],
  order: [doc],
  totals: {
    selectedDocs: 1,
    expectedDocs: 1,
    missingDocs: 0,
    tokens: fullTokens,
    lexicalTokens: fullTokens,
    numeralTokens: 0,
    types: 0,
    hapax: 0,
    sentences: 0,
    paragraphs: 0,
    charsUtf16: 0,
  },
  documents: [{
    doc,
    selectedTokens: fullTokens,
    fullTokens,
    lexicalTokens: fullTokens,
    numeralTokens: 0,
    types: 0,
    hapax: 0,
    sentences: 0,
    paragraphs: 0,
    sentenceMean: null,
    sentenceMedian: null,
    sentenceP90: null,
    paragraphMean: null,
    ttr: null,
    mattr: null,
    mattrIsPlainTtr: true,
    charsUtf16: 0,
  }],
  rhythm: null,
  missingDocs: [],
  mattrWindow: 500,
});

const trend = (order: readonly string[], counts: readonly number[]): NumericTrend => ({
  coordinate: 'declared-sequence',
  bins: { mode: 'per-doc', count: 4 },
  rowOffsets: new Uint32Array(order.length + 1),
  docOrdinal: new Uint32Array(),
  binIndex: new Uint32Array(),
  binStartToken: new Uint32Array(),
  binTokens: new Uint32Array(),
  count: new Uint32Array(),
  ratePer10k: new Float64Array(),
  order,
  sequenceBases: order.map(() => 0),
  docTokenCount: counts,
});

const readyTrend = (result: NumericTrend): SeriesTrendState => ({
  status: 'ready',
  trend: result,
});

describe('fullTokensByDoc', () => {
  it('uses the resident baseline inventory when it represents all ready documents', () => {
    const inventory: InventoryState = {
      snapshot: 'snapshot-1',
      selection: null,
      state: { status: 'ready', result: inventoryResult('a', 120) },
    };
    expect(fullTokensByDoc('a', {
      inventory,
      trends: new Map(),
    })).toBe(120);
  });

  it('uses retained trend geometry when inventory is range-scoped', () => {
    const inventory: InventoryState = {
      snapshot: 'snapshot-1',
      selection: {
        snapshot: 'snapshot-1',
        ranges: [{ doc: 'a', tokens: { start: 10, end: 20 } }],
      },
      state: { status: 'ready', result: inventoryResult('a', 120) },
    };
    expect(fullTokensByDoc('b', {
      inventory,
      trends: new Map([
        ['series-1', readyTrend(trend(['a', 'b'], [120, 240]))],
      ]),
    })).toBe(240);
  });

  it('uses snapshot-bound retained extents when range inventory omits a failed trend doc', () => {
    const inventory: InventoryState = {
      snapshot: 'snapshot-1',
      selection: {
        snapshot: 'snapshot-1',
        ranges: [{ doc: 'a', tokens: { start: 10, end: 20 } }],
      },
      state: { status: 'ready', result: inventoryResult('a', 120) },
    };
    expect(fullTokenCountsForDocs(['a', 'b'], {
      corpusTokenCounts: new Map([['a', 120], ['b', 240]]),
      inventory,
      trends: new Map([['failed', { status: 'error', message: 'too many rows' }]]),
    })).toEqual([120, 240]);
  });

  it('prefers a selected document’s range-scoped inventory full extent', () => {
    const inventory: InventoryState = {
      snapshot: 'snapshot-1',
      selection: {
        snapshot: 'snapshot-1',
        ranges: [{ doc: 'a', tokens: { start: 10, end: 20 } }],
      },
      state: { status: 'ready', result: inventoryResult('a', 120) },
    };
    expect(fullTokensByDoc('a', {
      inventory,
      trends: new Map([
        // Deliberately different: inventory must win for the represented doc.
        ['series-1', readyTrend(trend(['a'], [999]))],
      ]),
    })).toBe(120);
  });

  it('returns null when neither source knows the requested document', () => {
    expect(fullTokensByDoc('missing', {
      inventory: null,
      trends: new Map([
        ['pending', { status: 'pending' }],
        ['ready', readyTrend(trend(['a'], [120]))],
      ]),
    })).toBeNull();
  });

  it('resolves aggregate corpus geometry from inventory after every trend lane fails', () => {
    const result = inventoryResult('a', 2_000_000);
    const inventory: InventoryState = {
      snapshot: 'snapshot-1',
      selection: null,
      state: { status: 'ready', result },
    };
    expect(fullTokenCountsForDocs(['a'], {
      inventory,
      trends: new Map([['failed', { status: 'error', message: 'too many rows' }]]),
    })).toEqual([2_000_000]);
    expect(fullTokenCountsForDocs(['a', 'missing'], {
      inventory,
      trends: new Map(),
    })).toBeNull();
  });
});
