import { describe, expect, it } from 'vitest';
import { EMPTY_NOTEBOOK } from '../src/project/notebook.ts';
import {
  parseWorkspace,
  parseWorkspaceTrendView,
  reconcileWorkspaceDocuments,
  type WorkspaceV1,
} from '../src/project/workspace.ts';

const HASH = 'a'.repeat(64);

function validWorkspace(): WorkspaceV1 {
  return {
    schema: 'texttrends/workspace/1',
    corpus: {
      kind: 'library',
      order: ['one'],
      docs: [{
        doc: 'one',
        library: `txt:${HASH}`,
        meta: { title: 'One', language: 'en', tags: ['fiction'] },
        warm: { textHash: HASH, textLengthUtf16: 10 },
      }],
    },
    notebook: EMPTY_NOTEBOOK,
    active: [],
    views: {
      trend: {
        mode: 'by-book',
        bins: { mode: 'per-doc', count: 40 },
        measure: { kind: 'count' },
      },
      frequency: {
        minCount: 2,
        minDocFreq: 1,
        classes: ['lexical', 'numeral'],
        stoplistTopN: 0,
        filter: { mode: 'regex', query: '^é|ère$' },
        sort: { by: 'count', dir: -1 },
        pageSize: 100,
      },
      compare: {
        mode: 'documents',
        documentA: 'one',
        documentB: 'missing',
        restOn: 'b',
        minCountTotal: 2,
        minDocFreqTotal: 1,
        classes: ['lexical'],
        stoplistTopN: 0,
        sort: { by: 'g2', dirA: -1, dirB: 1 },
        showConfidenceIntervals: true,
        pageSize: 50,
      },
    },
  };
}

function omitKey(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

const OBSOLETE_WORKSPACE_SHAPES: readonly [
  name: string,
  mutate: (value: WorkspaceV1) => unknown,
][] = [
  ['query-notebook/1', (value) => ({
    ...value,
    notebook: { ...value.notebook, schema: 'texttrends/query-notebook/1' },
  })],
  ['query-notebook/2', (value) => ({
    ...value,
    notebook: { ...value.notebook, schema: 'texttrends/query-notebook/2' },
  })],
  ['trend.focusedDoc', (value) => ({
    ...value,
    views: { ...value.views, trend: { ...value.views.trend, focusedDoc: 'one' } },
  })],
  ['trend denominator 1,000', (value) => ({
    ...value,
    views: {
      ...value.views,
      trend: {
        ...value.views.trend,
        measure: { kind: 'rate', denominator: 1_000, smoothing: 0, showRaw: false },
      },
    },
  })],
  ['frequency.prefixNfc', (value) => ({
    ...value,
    views: { ...value.views, frequency: { ...value.views.frequency, prefixNfc: 'a' } },
  })],
  ['frequency.regex', (value) => ({
    ...value,
    views: { ...value.views, frequency: { ...value.views.frequency, regex: '^a' } },
  })],
  ['frequency without stoplistTopN', (value) => ({
    ...value,
    views: { ...value.views, frequency: omitKey(value.views.frequency, 'stoplistTopN') },
  })],
  ['compare without showConfidenceIntervals', (value) => ({
    ...value,
    views: { ...value.views, compare: omitKey(value.views.compare, 'showConfidenceIntervals') },
  })],
  ['compare without stoplistTopN', (value) => ({
    ...value,
    views: { ...value.views, compare: omitKey(value.views.compare, 'stoplistTopN') },
  })],
  ['workspace carrying kwicEnabled', (value) => ({ ...value, kwicEnabled: [] })],
  ['built-in corpus', (value) => ({
    ...value,
    corpus: { kind: 'builtin', id: 'builtin/sherlock' },
  })],
  ['dangling active group', (value) => ({ ...value, active: ['missing'] })],
];

describe('workspace admission', () => {
  it('admits an exact library-backed workspace', () => {
    expect(parseWorkspace(validWorkspace())).toEqual(validWorkspace());
  });

  it.each(OBSOLETE_WORKSPACE_SHAPES)('rejects obsolete %s', (_name, mutate) => {
    expect(() => parseWorkspace(mutate(validWorkspace()))).toThrow(RangeError);
  });

  it('validates current text filters', () => {
    const value = validWorkspace();
    const { filter: _filter, ...frequency } = value.views.frequency;
    expect(parseWorkspace({
      ...value,
      views: {
        ...value.views,
        frequency: {
          ...frequency,
          filter: { mode: 'literal', query: '[' },
        },
      },
    }).views.frequency.filter).toEqual({ mode: 'literal', query: '[' });
    expect(() => parseWorkspace({
      ...value,
      views: {
        ...value.views,
        frequency: { ...frequency, filter: { mode: 'regex', query: '[' } },
      },
    })).toThrow(/frequency regex/);
    expect(() => parseWorkspace({
      ...value,
      views: {
        ...value.views,
        frequency: {
          ...frequency,
          filter: { mode: 'literal', query: 'e\u0301' },
        },
      },
    })).toThrow(/NFC/);
  });

  it('round-trips bounded common-word filter depths', () => {
    const value = validWorkspace();
    const parsed = parseWorkspace({
      ...value,
      views: {
        ...value.views,
        frequency: { ...value.views.frequency, stoplistTopN: 500 },
        compare: { ...value.views.compare, stoplistTopN: 750 },
      },
    });
    expect(parsed.views.frequency.stoplistTopN).toBe(500);
    expect(parsed.views.compare.stoplistTopN).toBe(750);
    expect(() => parseWorkspace({
      ...value,
      views: {
        ...value.views,
        compare: { ...value.views.compare, stoplistTopN: 2_001 },
      },
    })).toThrow(/compare view/u);
  });

  it('round-trips a current workspace with interval whiskers hidden', () => {
    const value = validWorkspace();
    const parsed = parseWorkspace({
      ...value,
      views: {
        ...value.views,
        compare: {
          ...value.views.compare,
          showConfidenceIntervals: false,
        },
      },
    });
    expect(parsed.views.compare.showConfidenceIntervals).toBe(false);
  });

  it('round-trips the lower confidence-bound Compare sort', () => {
    const value = validWorkspace();
    const compare = {
      ...value.views.compare,
      sort: { ...value.views.compare.sort, by: 'logRatioLow' as const },
    };
    expect(parseWorkspace({
      ...value,
      views: { ...value.views, compare },
    }).views.compare.sort.by).toBe('logRatioLow');
  });

  it('round-trips the transient-selection comparison mode without persisting a range', () => {
    const value = validWorkspace();
    const compare = {
      ...value.views.compare,
      mode: 'selection-rest' as const,
    };
    expect(parseWorkspace({
      ...value,
      views: { ...value.views, compare },
    }).views.compare).toEqual(compare);
  });

  it('round-trips a query-notebook/3 workspace with an authored custom color', () => {
    const value = validWorkspace();
    const custom: WorkspaceV1 = {
      ...value,
      notebook: {
        schema: 'texttrends/query-notebook/3',
        groups: [{
          id: 'g1',
          aliases: ['Holmes'],
          exactMatch: false,
          countOverlaps: false,
          style: { color: '#a1b2c3', line: 'dash' },
        }],
      },
      active: ['g1'],
    };
    expect(parseWorkspace(custom)).toEqual(custom);
  });

  it('rejects dangling or malformed durable identities', () => {
    const value = validWorkspace();
    const corpus = value.corpus;
    expect(() => parseWorkspace({
      ...value,
      corpus: { ...value.corpus, order: ['different'] },
    })).toThrow(/order and documents/);
    expect(() => parseWorkspace({
      ...value,
      corpus: {
        kind: 'library',
        order: ['one'],
        docs: [{ ...corpus.docs[0], library: `source/txt:${HASH}` }],
      },
    })).toThrow(/library identity/);
  });

  it('treats warm text identity as a bounded cache hint', () => {
    const value = validWorkspace();
    const corpus = value.corpus;
    expect(() => parseWorkspace({
      ...value,
      corpus: {
        kind: 'library',
        order: ['one'],
        docs: [{
          ...corpus.docs[0],
          warm: { textHash: 'not-a-hash', textLengthUtf16: 10 },
        }],
      },
    })).toThrow(/warm text hint/);
  });

  it('validates the live trend settings contract directly', () => {
    const trend = validWorkspace().views.trend;
    expect(parseWorkspaceTrendView(trend)).toEqual(trend);
    expect(parseWorkspaceTrendView({ ...trend, mode: 'by-book-scaled' })).toEqual({
      ...trend,
      mode: 'by-book-scaled',
    });
    expect(() => parseWorkspaceTrendView({
      ...trend,
      bins: { mode: 'per-doc', count: 3 },
    })).toThrow(/trend bins/);
    expect(() => parseWorkspaceTrendView({
      ...trend,
      measure: { kind: 'count', smoothing: 3 },
    })).toThrow(/trend measure/);
    expect(() => parseWorkspaceTrendView({
      ...trend,
      measure: {
        kind: 'rate', denominator: 10_000, smoothing: 4, showRaw: false,
      },
    })).toThrow(/trend measure/);
  });

  it('reconciles presentation references against the opened corpus', () => {
    const reconciled = reconcileWorkspaceDocuments(validWorkspace(), new Set(['one']));
    expect(reconciled.views.compare.documentA).toBe('one');
    expect(reconciled.views.compare.documentB).toBeNull();
  });
});
