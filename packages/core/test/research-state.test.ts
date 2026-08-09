import { describe, expect, it } from 'vitest';
import type { TextHash } from '../src/contract/brands.ts';
import {
  parseQueryNotebook,
  type QueryNotebookV1,
} from '../src/project/notebook.ts';
import {
  parseResearchState,
  reconcileResearchState,
  type ResearchStateV1,
} from '../src/project/research-state.ts';

const HASH_A = 'a'.repeat(64) as TextHash;
const HASH_B = 'b'.repeat(64) as TextHash;

const NOTEBOOK: QueryNotebookV1 = {
  schema: 'texttrends/query-notebook/1',
  groups: [{
    id: 'g1',
    name: 'Holmes',
    members: [{
      id: 'm1',
      kind: 'token',
      surface: 'Holmes',
      match: { case: 'sensitive', diacritics: 'sensitive' },
    }],
    countOverlaps: false,
  }],
};

function state(): ResearchStateV1 {
  return {
    schema: 'texttrends/research-state/1',
    project: 'builtin/sherlock',
    revision: 1,
    notebook: NOTEBOOK,
    active: ['g1'],
    kwicEnabled: ['g1'],
    views: {
      trend: {
        schema: 'texttrends/trend-view/3',
        mode: 'series',
        focusedDoc: 'a',
        bins: { mode: 'per-doc', count: 40 },
        measure: {
          kind: 'rate',
          denominator: 10_000,
          smoothing: 0,
          showRaw: false,
        },
      },
      inventory: {
        schema: 'texttrends/inventory-view/1',
        minCount: 2,
        minDocFreq: 1,
        classes: ['lexical'],
        sort: { by: 'dp', dir: -1 },
        pageSize: 100,
      },
      keyness: {
        schema: 'texttrends/keyness-view/1',
        a: [HASH_A],
        b: [HASH_B],
        mode: 'documents',
        filter: {
          minCountTotal: 5,
          minDocFreqTotal: 2,
          classes: ['lexical'],
        },
        sort: { by: 'logRatio', dirA: -1, dirB: 1 },
        pageSize: 100,
      },
    },
  };
}

describe('core notebook codec', () => {
  it('admits the authored notebook and rejects sparse or extra records', () => {
    expect(parseQueryNotebook(NOTEBOOK)).toBe(NOTEBOOK);
    expect(() => parseQueryNotebook({ ...NOTEBOOK, extra: true })).toThrow(RangeError);
    const sparse = [...NOTEBOOK.groups];
    sparse.length = 2;
    expect(() => parseQueryNotebook({ ...NOTEBOOK, groups: sparse })).toThrow(/dense/);
  });
});

describe('research-state/1', () => {
  it('round-trips an exact bounded record', () => {
    const value = state();
    expect(parseResearchState(value)).toEqual(value);
  });

  it('enforces trend-view/3 bin bounds and discriminated display settings', () => {
    const current = state();
    const withTrend = (trend: unknown) => parseResearchState({
      ...current,
      views: { ...current.views, trend },
    });
    expect(() => withTrend({
      ...current.views.trend,
      bins: { mode: 'per-doc', count: 3 },
    })).toThrow(/trend bins/);
    expect(() => withTrend({
      ...current.views.trend,
      bins: { mode: 'fixed-tokens', count: 50_001 },
    })).toThrow(/trend bins/);
    expect(() => withTrend({
      ...current.views.trend,
      measure: { kind: 'count', smoothing: 3 },
    })).toThrow(/trend measure/);
    expect(() => withTrend({
      ...current.views.trend,
      measure: {
        kind: 'rate', denominator: 10_000, smoothing: 4, showRaw: false,
      },
    })).toThrow(/trend measure/);
  });

  it('drops active/KWIC ids absent from the admitted notebook only on reconciliation', () => {
    const value = {
      ...state(),
      active: ['g1', 'departed'],
      kwicEnabled: ['departed', 'g1'],
    };
    const parsed = parseResearchState(value);
    expect(parsed.active).toEqual(['g1', 'departed']);
    expect(reconcileResearchState(parsed)).toEqual(expect.objectContaining({
      active: ['g1'],
      kwicEnabled: ['g1'],
    }));
  });

  it('admits KWIC eligibility for inactive groups beyond the five active-track cap', () => {
    const eligible = Array.from({ length: 6 }, (_, index) => `g${index}`);
    expect(parseResearchState({
      ...state(),
      kwicEnabled: eligible,
    }).kwicEnabled).toEqual(eligible);
  });

  it('rejects over-cap arrays before accepting authored data', () => {
    expect(() => parseResearchState({
      ...state(),
      active: Array.from({ length: 6 }, (_, index) => `g${index}`),
    })).toThrow(/5-item cap/);
  });

  it('rejects overlapping keyness hashes and removed or derived fields', () => {
    expect(() => parseResearchState({
      ...state(),
      views: {
        ...state().views,
        keyness: {
          ...state().views.keyness,
          b: [HASH_A],
        },
      },
    })).toThrow(/disjoint TextHashes/);
    expect(() => parseResearchState({ ...state(), selections: [] })).toThrow(/exact v1 record/);
    expect(() => parseResearchState({ ...state(), pins: [] })).toThrow(/exact v1 record/);
    expect(() => parseResearchState({
      ...state(),
      styleSlots: { g1: 0 },
    })).toThrow(/exact v1 record/);
  });
});
