import { describe, expect, it } from 'vitest';
import type {
  FrequencyListResultV1,
  InventoryResultV1,
  KeynessResultV1,
  NumericTrend,
} from '@texttrends/core';
import {
  formatProvenanceText,
  formatResultTsv,
  provenanceFor,
  resultTableFor,
  type ProvenanceInput,
} from '../src/lib/provenance.ts';
import { DEFAULT_KEYNESS_VIEW } from '../src/lib/store.ts';

const inventory: InventoryResultV1 = {
  method: 'inventory/1',
  selection: 'sha256:inventory' as InventoryResultV1['selection'],
  order: ['a', 'b'],
  totals: {
    selectedDocs: 2,
    expectedDocs: 2,
    missingDocs: 0,
    tokens: 200,
    lexicalTokens: 180,
    numeralTokens: 20,
    types: 80,
    hapax: 30,
    sentences: 10,
    paragraphs: 5,
    charsUtf16: 900,
  },
  documents: [],
  rhythm: null,
  growth: {
    tokens: new Uint32Array([100, 200]),
    types: new Uint32Array([50, 80]),
    documentEnds: [100, 200],
  },
  missingDocs: [],
  mattrWindow: 500,
};

const trend: NumericTrend = {
  coordinate: 'declared-sequence',
  bins: { mode: 'per-doc', count: 4 },
  rowOffsets: new Uint32Array([0, 2]),
  docOrdinal: new Uint32Array([0, 0]),
  binIndex: new Uint32Array([0, 1]),
  binStartToken: new Uint32Array([0, 50]),
  binTokens: new Uint32Array([50, 50]),
  count: new Uint32Array([2, 3]),
  ratePer10k: new Float64Array([400, 600]),
  order: ['a'],
  sequenceBases: [0],
  docTokenCount: [100],
};

const frequency: FrequencyListResultV1 = {
  method: 'freq-list/1',
  selection: 'sha256:frequency' as FrequencyListResultV1['selection'],
  total: 1,
  totalTokens: 180,
  parts: 2,
  rows: [{
    key: 'Holmes',
    typeId: 1,
    class: 'lexical',
    count: 12,
    ratePer10k: 666.666,
    docFreq: 2,
    dp: 0.25,
    dpNorm: 0.5,
  }],
};

const keyness: KeynessResultV1 = {
  method: 'keyness-g2-2x2/1',
  effect: 'log-ratio-halves/1',
  selectionA: 'sha256:a' as KeynessResultV1['selectionA'],
  selectionB: 'sha256:b' as KeynessResultV1['selectionB'],
  totalsA: { tokens: 100, documents: 1 },
  totalsB: { tokens: 100, documents: 1 },
  total: 1,
  rows: [{
    key: 'Holmes',
    typeId: 1,
    class: 'lexical',
    countA: 9,
    countB: 1,
    rateAper10k: 900,
    rateBper10k: 100,
    logRatio: 3,
    g2: 5,
    rangeA: 1,
    rangeB: 1,
  }],
};

function input(overrides: Partial<ProvenanceInput> = {}): ProvenanceInput {
  return {
    documentTitles: new Map([['a', 'a'], ['b', 'b']]),
    snapshot: {
      snapshot: 'snapshot-1',
      readyDocs: ['a', 'b'],
      missingDocs: [],
    },
    linkedSelection: null,
    inventory,
    trends: [{ label: 'Holmes', result: trend }],
    trendMeasure: {
      kind: 'rate',
      denominator: 10_000,
      smoothing: 0,
      showRaw: false,
    },
    concordance: { resident: true, enabledTracks: 2, total: 42 },
    frequency: {
      view: {
        schema: 'texttrends/frequency-view/1',
        minCount: 2,
        minDocFreq: 1,
        classes: ['lexical'],
        prefixNfc: 'H',
        sort: { by: 'count', dir: -1 },
        page: { offset: 0, limit: 100 },
      },
      result: frequency,
    },
    keyness: {
      view: DEFAULT_KEYNESS_VIEW,
      sideA: ['a'],
      sideB: ['b'],
      resultA: keyness,
      resultB: keyness,
    },
    ...overrides,
  };
}

describe('provenanceFor', () => {
  it('names every enumerated Trends parameter from resident results', () => {
    const value = formatProvenanceText(provenanceFor(input(), 'trends'));
    expect(value).toContain('result · kernel rate: rate per 10,000 selected tokens');
    expect(value).toContain('presentation · measure: rate');
    expect(value.match(/10,000/gu)).toHaveLength(1);
    expect(value).toContain('result · bin policy: 4 equal bins per document');
    expect(value).toContain('result · coordinate: declared-sequence');
    expect(value).toContain('presentation · smoothing: none');
    expect(value).toContain('resident series: Holmes');
    expect(value).toContain('Snapshot: snapshot-1');
  });

  it('describes corpus, concordance, vocabulary, and compare methods', () => {
    expect(formatProvenanceText(provenanceFor(input(), 'inputs'))).toContain('MATTR window: 500');
    expect(formatProvenanceText(provenanceFor(input(), 'concordance')))
      .toContain('Method: concordance-window/1');
    const vocabulary = formatProvenanceText(provenanceFor(input(), 'vocabulary'));
    expect(vocabulary).toContain('Method: inventory/1');
    expect(vocabulary).toContain('Method: freq-list/1');
    expect(vocabulary).toContain('token classes: lexical');
    const compare = formatProvenanceText(provenanceFor(input(), 'compare'));
    expect(compare).toContain('side A: a');
    expect(compare).toContain('side B: b');
    expect(compare).toContain('shared sort field: logRatio');
    expect(compare).toContain('A direction: descending');
    expect(compare).toContain('B direction: ascending');
    expect(compare).toContain('page size: 100');
    expect(compare).toContain('exactly zero log ratio');
    expect(compare).toContain('page-local scale');
    expect(compare).toContain('No confidence intervals');
    expect(compare).toContain('linked Trends range');
  });

  it('is deterministic and honest about waiting and partial results', () => {
    const value = provenanceFor(input(), 'trends');
    expect(formatProvenanceText(value)).toBe(formatProvenanceText(value));
    const waiting = provenanceFor(input({ trends: [] }), 'trends');
    expect(waiting.completeness.status).toBe('waiting');
    expect(waiting.methods).toEqual([]);
    const partial = provenanceFor(input({
      snapshot: {
        snapshot: 'snapshot-2',
        readyDocs: ['a'],
        missingDocs: ['b'],
      },
    }), 'trends');
    expect(partial.completeness.status).toBe('partial');
    expect(formatProvenanceText(partial)).toContain('Missing documents: b');
  });

  it('renders a linked half-open range as 1-based inclusive provenance', () => {
    const value = provenanceFor(input({
      linkedSelection: {
        snapshot: 'snapshot-1',
        ranges: [{ doc: 'a', tokens: { start: 0, end: 3 } }],
      },
    }), 'trends');
    expect(value.content.selection).toBe('a tokens 1–3 (1-based inclusive)');
    expect(value.completeness.statement).toBe('The selected range in a is represented.');
  });

  it('uses reader-facing titles in prose, comparison sides, and result exports', () => {
    const titled = input({
      documentTitles: new Map([['a', 'Alpha'], ['b', 'Beta']]),
      linkedSelection: {
        snapshot: 'snapshot-1',
        ranges: [{ doc: 'a', tokens: { start: 0, end: 3 } }],
      },
    });
    const text = formatProvenanceText(provenanceFor(titled, 'trends'));
    expect(text).toContain('Selection: Alpha tokens 1–3');
    expect(text).toContain('Ready documents: Alpha, Beta');
    expect(formatProvenanceText(provenanceFor(titled, 'compare'))).toContain('side A: Alpha');
    expect(formatResultTsv(resultTableFor(titled, 'trends')!, provenanceFor(titled, 'trends')))
      .toContain('Holmes\tAlpha\t1');
  });

  it('describes every endpoint and total for a cross-document linked range', () => {
    const value = provenanceFor(input({
      linkedSelection: {
        snapshot: 'snapshot-1',
        ranges: [
          { doc: 'a', tokens: { start: 8, end: 10 } },
          { doc: 'b', tokens: { start: 0, end: 4 } },
        ],
      },
    }), 'trends');
    expect(value.content.selection)
      .toBe('a token 9 through b token 4 (6 tokens across 2 documents)');
    expect(value.completeness.statement)
      .toBe('The selected range across 2 documents is represented.');
  });
});

describe('result exports', () => {
  it('formats Trends, Vocabulary, and Compare rows with the same provenance', () => {
    for (const place of ['trends', 'vocabulary', 'compare'] as const) {
      const provenance = provenanceFor(input(), place);
      const table = resultTableFor(input(), place);
      expect(table).not.toBeNull();
      const tsv = formatResultTsv(table!, provenance);
      expect(tsv).toContain(`# Place: ${place}`);
      expect(tsv).toContain('\t');
      expect(tsv.endsWith('\n')).toBe(true);
    }
    const trends = formatResultTsv(
      resultTableFor(input(), 'trends')!,
      provenanceFor(input(), 'trends'),
    );
    expect(trends).toContain('Holmes\ta\t1\t0\t50\t2\t400');
    const compare = formatResultTsv(
      resultTableFor(input(), 'compare')!,
      provenanceFor(input(), 'compare'),
    );
    expect(compare).toContain('ranking_side\trank\tterm');
    expect(compare).toContain('A\t1\tHolmes');
    expect(compare).toContain('B\t1\tHolmes');
  });

  it('exports range-resident Trends rows rather than relabelling baseline rows', () => {
    const selectedTrend: NumericTrend = {
      ...trend,
      binTokens: new Uint32Array([3]),
      count: new Uint32Array([1]),
      ratePer10k: new Float64Array([3333.333]),
      docOrdinal: new Uint32Array([0]),
      binIndex: new Uint32Array([0]),
      binStartToken: new Uint32Array([0]),
    };
    const selectedInput = input({
      linkedSelection: {
        snapshot: 'snapshot-1',
        ranges: [{ doc: 'a', tokens: { start: 0, end: 3 } }],
      },
      trends: [{ label: 'Holmes', result: selectedTrend }],
    });
    const result = formatResultTsv(
      resultTableFor(selectedInput, 'trends')!,
      provenanceFor(selectedInput, 'trends'),
    );
    expect(result).toContain('# Selection: a tokens 1–3 (1-based inclusive)');
    expect(result).toContain('Holmes\ta\t1\t0\t3\t1\t3333.333');
    expect(result).not.toContain('\t50\t2\t400');
  });

  it('sanitizes tabs and newlines without quoting ambiguous TSV cells', () => {
    const value = formatResultTsv({
      title: 'test',
      columns: ['first\tcolumn'],
      rows: [['two\nlines']],
    }, provenanceFor(input(), 'trends'));
    expect(value).toContain('first column');
    expect(value).toContain('two lines');
  });
});
