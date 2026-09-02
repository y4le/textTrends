import type { WorkspaceV1 } from '@texttrends/core';

export function workspaceState(input: Partial<WorkspaceV1> = {}): WorkspaceV1 {
  const workspace: WorkspaceV1 = {
    schema: 'texttrends/workspace/1',
    corpus: { kind: 'library', order: [], docs: [] },
    notebook: { schema: 'texttrends/query-notebook/3', groups: [] },
    active: [],
    kwicEnabled: [],
    views: {
      trend: {
        mode: 'series',
        bins: { mode: 'per-doc', count: 40 },
        measure: {
          kind: 'rate',
          denominator: 10_000,
          smoothing: 0,
          showRaw: false,
        },
      },
      frequency: {
        minCount: 1,
        minDocFreq: 1,
        classes: ['lexical', 'numeral'],
        stoplistTopN: 0,
        sort: { by: 'count', dir: -1 },
        pageSize: 100,
      },
      compare: {
        mode: 'documents',
        documentA: null,
        documentB: null,
        restOn: 'b',
        minCountTotal: 1,
        minDocFreqTotal: 1,
        classes: ['lexical', 'numeral'],
        stoplistTopN: 0,
        sort: { by: 'logRatio', dirA: -1, dirB: 1 },
        showConfidenceIntervals: false,
        pageSize: 100,
      },
    },
  };
  return { ...workspace, ...input };
}
