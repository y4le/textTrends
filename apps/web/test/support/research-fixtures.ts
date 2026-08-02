import type { ResearchStateV1 } from '@texttrends/core';

export function researchState(
  project = 'p',
  revision = 1,
): ResearchStateV1 {
  return {
    schema: 'texttrends/research-state/1',
    project,
    revision,
    notebook: {
      schema: 'texttrends/query-notebook/1',
      groups: [],
    },
    active: [],
    kwicEnabled: [],
    selections: [],
    pins: [],
    views: {
      trend: {
        schema: 'texttrends/trend-view/2',
        mode: 'series',
        sectionMarks: true,
        focusedDoc: null,
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
        minCount: 1,
        minDocFreq: 1,
        classes: ['lexical', 'numeral'],
        sort: { by: 'count', dir: -1 },
        pageSize: 100,
      },
      keyness: {
        schema: 'texttrends/keyness-view/1',
        a: [],
        b: [],
        mode: 'documents',
        filter: {
          minCountTotal: 1,
          minDocFreqTotal: 1,
          classes: ['lexical', 'numeral'],
        },
        sort: { by: 'logRatio', dirA: -1, dirB: 1 },
        pageSize: 100,
      },
    },
  };
}
