import { describe, expect, it } from 'vitest';
import type { TextHash } from '../src/contract/brands.ts';
import {
  parseQueryNotebook,
  type QueryNotebookV1,
} from '../src/project/notebook.ts';
import {
  parseResearchState,
  reconcileResearchState,
  RESEARCH_MAX_PINS,
  RESEARCH_MAX_SELECTIONS,
  upgradeStoredResearchState,
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
    selections: [{
      id: 'selection-1',
      name: 'Opening',
      anchor: {
        doc: 'a',
        text: HASH_A,
        chars: { start: 0, end: 10 },
      },
    }],
    pins: [{
      id: 'pin-1',
      note: 'clue',
      anchor: {
        doc: 'a',
        text: HASH_A,
        chars: { start: 4, end: 9 },
      },
      captured: [{
        seriesId: 'g1',
        groupId: 'g1',
        identity: 'identity',
        label: 'Holmes',
      }],
    }],
    views: {
      trend: {
        schema: 'texttrends/trend-view/2',
        mode: 'series',
        sectionMarks: true,
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
  it('round-trips an exact bounded record and keeps the v1 migration seam pure', () => {
    const value = state();
    expect(parseResearchState(value)).toEqual(value);
    expect(upgradeStoredResearchState(value)).toBe(value);
  });

  it('upgrades the original trend view without changing outer CAS identity', () => {
    const current = state();
    const legacy = {
      ...current,
      views: {
        ...current.views,
        trend: {
          schema: 'texttrends/trend-view/1',
          mode: 'by-book',
          sectionMarks: false,
          focusedDoc: null,
        },
      },
    };
    const upgraded = upgradeStoredResearchState(legacy);
    expect(parseResearchState(upgraded).views.trend).toEqual({
      schema: 'texttrends/trend-view/2',
      mode: 'by-book',
      sectionMarks: false,
      focusedDoc: null,
      bins: { mode: 'per-doc', count: 40 },
      measure: {
        kind: 'rate',
        denominator: 10_000,
        smoothing: 0,
        showRaw: false,
      },
    });
  });

  it('enforces trend-view/2 bin bounds and discriminated display settings', () => {
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

  it('rejects over-cap and sparse arrays before accepting authored data', () => {
    expect(() => parseResearchState({
      ...state(),
      active: Array.from({ length: 6 }, (_, index) => `g${index}`),
    })).toThrow(/5-item cap/);
    expect(() => parseResearchState({
      ...state(),
      selections: Array.from(
        { length: RESEARCH_MAX_SELECTIONS + 1 },
        (_, index) => ({
          id: `s${index}`,
          name: 'x',
          anchor: { doc: 'a', text: HASH_A, chars: { start: 0, end: 1 } },
        }),
      ),
    })).toThrow(/32-item cap/);
    expect(() => parseResearchState({
      ...state(),
      pins: Array.from(
        { length: RESEARCH_MAX_PINS + 1 },
        (_, index) => ({
          id: `p${index}`,
          note: '',
          anchor: { doc: 'a', text: HASH_A, chars: { start: 0, end: 1 } },
          captured: [],
        }),
      ),
    })).toThrow(/8-item cap/);
    const sparse = [...state().pins];
    sparse.length = 2;
    expect(() => parseResearchState({ ...state(), pins: sparse })).toThrow(/dense/);
  });

  it('rejects overlapping keyness hashes, malformed anchors, and derived style slots', () => {
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
    expect(() => parseResearchState({
      ...state(),
      selections: [{
        ...state().selections[0]!,
        anchor: {
          ...state().selections[0]!.anchor,
          chars: { start: 10, end: 9 },
        },
      }],
    })).toThrow(/nondecreasing/);
    expect(() => parseResearchState({
      ...state(),
      styleSlots: { g1: 0 },
    })).toThrow(/exact v1 record/);
  });
});
