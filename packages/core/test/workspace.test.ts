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
    kwicEnabled: [],
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
        prefixNfc: 'é',
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
        sort: { by: 'g2', dirA: -1, dirB: 1 },
        showConfidenceIntervals: true,
        pageSize: 50,
      },
    },
  };
}

describe('workspace admission', () => {
  it('admits an exact library-backed workspace', () => {
    expect(parseWorkspace(validWorkspace())).toEqual(validWorkspace());
  });

  it('upgrades legacy Compare presentation settings without changing its display', () => {
    const value = validWorkspace();
    const { showConfidenceIntervals: _legacyMissing, ...legacyCompare } =
      value.views.compare;
    const parsed = parseWorkspace({
      ...value,
      views: { ...value.views, compare: legacyCompare },
    });
    expect(parsed.views.compare).toEqual({
      ...value.views.compare,
      showConfidenceIntervals: true,
    });
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
      kwicEnabled: ['g1'],
    };
    expect(parseWorkspace(custom)).toEqual(custom);
  });

  it('upgrades a workspace carrying a query-notebook/2 without changing its terms', () => {
    const value = validWorkspace();
    const parsed = parseWorkspace({
      ...value,
      notebook: {
        schema: 'texttrends/query-notebook/2',
        groups: [{
          id: 'g1',
          aliases: ['Holmes'],
          exactMatch: false,
          countOverlaps: false,
          style: { color: 'blue', line: 'solid' },
        }],
      },
      active: ['g1'],
      kwicEnabled: ['g1'],
    });
    expect(parsed.notebook).toEqual({
      schema: 'texttrends/query-notebook/3',
      groups: [{
        id: 'g1',
        aliases: ['Holmes'],
        exactMatch: false,
        countOverlaps: false,
        style: { color: 'blue', line: 'solid' },
      }],
    });
    expect(parsed.active).toEqual(['g1']);
    expect(parsed.kwicEnabled).toEqual(['g1']);
  });

  it('reopens a legacy v1 workspace whose phrase members used surfaces', () => {
    const value = validWorkspace();
    const parsed = parseWorkspace({
      ...value,
      notebook: {
        schema: 'texttrends/query-notebook/1',
        groups: [{
          id: 'g1', name: 'New York', countOverlaps: false,
          members: [{
            id: 'm1', kind: 'phrase', surfaces: ['New', 'York'],
            match: { case: 'folded', diacritics: 'folded' }, crossSentence: false,
          }],
        }],
      },
      active: ['g1'],
      kwicEnabled: ['g1'],
    });
    expect(parsed.notebook.groups[0]).toEqual({
      id: 'g1', aliases: ['New York'], exactMatch: false, countOverlaps: false,
      style: { color: 'blue', line: 'solid' },
    });
  });

  it('keeps the workspace and reconciles selections when an unusable legacy term is omitted', () => {
    const value = validWorkspace();
    const parsed = parseWorkspace({
      ...value,
      notebook: {
        schema: 'texttrends/query-notebook/1',
        groups: [{
          id: 'punct', name: 'Punctuation', countOverlaps: false,
          members: [{
            id: 'm1', kind: 'token', surface: '★',
            match: { case: 'folded', diacritics: 'folded' },
          }],
        }],
      },
      active: ['punct'],
      kwicEnabled: ['punct'],
    });
    expect(parsed.corpus).toEqual(value.corpus);
    expect(parsed.views).toEqual(value.views);
    expect(parsed.notebook.groups).toEqual([]);
    expect(parsed.active).toEqual([]);
    expect(parsed.kwicEnabled).toEqual([]);
  });

  it('rejects dangling or malformed durable identities', () => {
    const value = validWorkspace();
    if (value.corpus.kind !== 'library') throw new Error('fixture must be library-backed');
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
    if (value.corpus.kind !== 'library') throw new Error('fixture must be library-backed');
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
    expect(parseWorkspaceTrendView({ ...trend, focusedDoc: 'one' })).toEqual(trend);
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
    for (const denominator of [1_000, 100_000]) {
      expect(parseWorkspaceTrendView({
        ...trend,
        measure: { kind: 'rate', denominator, smoothing: 3, showRaw: true },
      }).measure).toEqual({
        kind: 'rate', denominator: 10_000, smoothing: 3, showRaw: true,
      });
    }
  });

  it('reconciles presentation references against the opened corpus', () => {
    const reconciled = reconcileWorkspaceDocuments(validWorkspace(), new Set(['one']));
    expect(reconciled.views.compare.documentA).toBe('one');
    expect(reconciled.views.compare.documentB).toBeNull();
  });
});
