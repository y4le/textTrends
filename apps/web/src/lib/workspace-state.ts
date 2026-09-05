/** Durable projection and its exact referential prefilter. Transient interaction state is excluded. */

import { canonicalJson, type WorkspaceV1 } from '@texttrends/core';
import type { AppState } from './app-state.ts';
import { DEFAULT_TREND_VIEW } from './trend-view.ts';
import { DEFAULT_TREND_BINS, DEFAULT_TREND_MEASURE, DEFAULT_KEYNESS_VIEW } from './app-defaults.ts';

export function workspaceFromApp(state: AppState): WorkspaceV1 | null {
  const project = state.projectSession?.project;
  if (!project) return null;
  if (project.data.docs.some((doc) => doc.library === undefined)) return null;
  const liveLibraries = new Set(project.data.docs.map((doc) => doc.library));
  const retained = state.unavailableDocs.filter((entry) => !liveLibraries.has(entry.doc.library));
  const order = [...project.data.order];
  // Preserve a best-effort neighbouring position after live texts are reordered.
  for (const entry of [...retained].sort((a, b) => a.index - b.index)) {
    order.splice(Math.min(entry.index, order.length), 0, entry.doc.doc);
  }
  const { filter, ...frequency } = state.frequencyView;
  return {
    schema: 'texttrends/workspace/1',
    corpus: {
      kind: 'library',
      order,
      docs: [...project.data.docs.map((doc) => ({
        doc: doc.doc,
        library: doc.library!,
        meta: doc.meta,
        ...(doc.extraction.text === undefined || doc.extraction.textLengthUtf16 === undefined
          ? {}
          : { warm: { textHash: doc.extraction.text, textLengthUtf16: doc.extraction.textLengthUtf16 } }),
      })), ...retained.map((entry) => entry.doc)],
    },
    notebook: state.notebook,
    active: state.notebook.groups
      .filter((group) => state.activeGroupIds.has(group.id))
      .map((group) => group.id),
    views: {
      trend: {
        mode: state.trendViewPreference,
        bins: state.trendBins,
        measure: state.trendMeasure,
      },
      frequency: {
        minCount: frequency.minCount,
        minDocFreq: frequency.minDocFreq,
        classes: frequency.classes,
        stoplistTopN: frequency.stoplistTopN,
        ...(filter === undefined ? {} : { filter }),
        sort: frequency.sort,
        pageSize: frequency.page.limit,
      },
      compare: {
        mode: state.keynessView.mode,
        documentA: state.keynessView.documentA,
        documentB: state.keynessView.documentB,
        restOn: state.keynessView.restOn,
        minCountTotal: state.keynessView.minCountTotal,
        minDocFreqTotal: state.keynessView.minDocFreqTotal,
        classes: state.keynessView.classes,
        stoplistTopN: state.keynessView.stoplistTopN,
        sort: state.keynessView.sort,
        showConfidenceIntervals: state.keynessView.showConfidenceIntervals,
        pageSize: state.keynessView.pageLimit,
      },
    },
  };
}

/** A fresh install is a durable, fully valid local workspace with no inputs.
 *  Demo content is an explicit acquisition, never implicit project state. */
export function emptyLibraryWorkspace(): WorkspaceV1 {
  return {
    schema: 'texttrends/workspace/1',
    corpus: { kind: 'library', order: [], docs: [] },
    notebook: { schema: 'texttrends/query-notebook/3', groups: [] },
    active: [],
    views: {
      trend: {
        mode: DEFAULT_TREND_VIEW,
        bins: DEFAULT_TREND_BINS,
        measure: DEFAULT_TREND_MEASURE,
      },
      frequency: {
        minCount: 1,
        minDocFreq: 1,
        classes: ['lexical'],
        stoplistTopN: 0,
        sort: { by: 'count', dir: -1 },
        pageSize: 100,
      },
      compare: {
        mode: DEFAULT_KEYNESS_VIEW.mode,
        documentA: null,
        documentB: null,
        restOn: DEFAULT_KEYNESS_VIEW.restOn,
        minCountTotal: DEFAULT_KEYNESS_VIEW.minCountTotal,
        minDocFreqTotal: DEFAULT_KEYNESS_VIEW.minDocFreqTotal,
        classes: DEFAULT_KEYNESS_VIEW.classes,
        stoplistTopN: DEFAULT_KEYNESS_VIEW.stoplistTopN,
        sort: DEFAULT_KEYNESS_VIEW.sort,
        showConfidenceIntervals: DEFAULT_KEYNESS_VIEW.showConfidenceIntervals,
        pageSize: DEFAULT_KEYNESS_VIEW.pageLimit,
      },
    },
  };
}

/** Exact referential inputs to `workspaceFromApp`. The persistence subscriber
 * sees every transient Zustand write (Find, Reader, Matches, cursor, …), so it
 * must reject states that cannot possibly change the durable projection before
 * paying for a full canonical serialization of the library metadata. Keep this
 * tuple adjacent to and in lockstep with `workspaceFromApp`. */
export const WORKSPACE_SEMANTIC_SOURCE_KEYS = [
  'projectSession',
  'unavailableDocs',
  'notebook',
  'activeGroupIds',
  'trendViewPreference',
  'trendBins',
  'trendMeasure',
  'frequencyView',
  'keynessView',
] as const satisfies readonly (keyof AppState)[];

export function workspaceSemanticSources(state: AppState): readonly unknown[] {
  return WORKSPACE_SEMANTIC_SOURCE_KEYS.map((key) =>
    key === 'projectSession'
      ? state.projectSession?.project ?? null
      : state[key]);
}

export function sameWorkspaceSemanticSources(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
}

export function workspaceSemanticKey(state: AppState): string | null {
  const workspace = workspaceFromApp(state);
  return workspace === null ? null : canonicalJson(workspace);
}

