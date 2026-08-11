import type { WorkspaceV1 } from '@texttrends/core';

export function workspaceState(input: string | Partial<WorkspaceV1> = 'builtin/sherlock'): WorkspaceV1 {
  const workspace: WorkspaceV1 = {
    schema: 'texttrends/workspace/1',
    corpus: { kind: 'builtin', id: typeof input === 'string' ? input : 'builtin/sherlock' },
    notebook: { schema: 'texttrends/query-notebook/3', groups: [] },
    active: [],
    kwicEnabled: [],
    views: {
      trend: {
        mode: 'series',
        focusedDoc: null,
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
        sort: { by: 'logRatio', dirA: -1, dirB: 1 },
        pageSize: 100,
      },
    },
  };
  return typeof input === 'string' ? workspace : { ...workspace, ...input };
}
