import {
  termGroupIdentity,
  type DispersionResultV1,
  type NotebookGroupV1,
  type NumericTrend,
  type SeriesStyleV1,
  type TermGroupSpec,
} from '@texttrends/core';
import {
  coreGroupOf,
  defaultSeriesStyle,
  groupTitle,
  parseAuthoredAliases,
  validateNotebookGroup,
} from './notebook.ts';
import type { OccurrenceStepHitV1 } from '../shared/analysis-contract.ts';

export const FIND_INPUT_ID = 'corpus-find-input';
export const FIND_SURFACE_SELECTOR = '[data-interaction-surface="find"]';

export interface FindAnchor {
  readonly doc: string;
  readonly token: number;
}

export type FindSeekState =
  | { readonly status: 'idle' }
  | { readonly status: 'pending'; readonly direction: 1 | -1 }
  | {
      readonly status: 'ready';
      readonly direction: 1 | -1;
      readonly hit: OccurrenceStepHitV1;
      readonly wrapped: boolean;
    }
  | { readonly status: 'edge' }
  | { readonly status: 'error'; readonly message: string };

export interface FindQuery {
  /** Canonical comma-authored input restored to the composer and announced in
   * status text. */
  readonly raw: string;
  /** Terms semantics: the first authored alias names the temporary group. */
  readonly label: string;
  readonly seriesId: string;
  readonly group: TermGroupSpec;
  readonly identity: string;
  readonly style: SeriesStyleV1;
}

export type FindTrendState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly trend: NumericTrend }
  | { readonly status: 'error'; readonly message: string };

export type FindDispersionState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly result: DispersionResultV1 }
  | { readonly status: 'error'; readonly message: string };

export interface FindState {
  readonly snapshot: string;
  readonly query: FindQuery;
  readonly anchor: FindAnchor | null;
  readonly state: FindSeekState;
  /** The temporary one-term comparison shown instead of durable Terms while
   * Find owns the interaction surface. These lanes never mutate the notebook. */
  readonly trend: FindTrendState;
  readonly dispersion: FindDispersionState;
}

/** The one primary interaction state. Future command and speed modes extend
 * this union instead of adding independently-owned component flags. */
export type InteractionState =
  | { readonly kind: 'none' }
  | { readonly kind: 'find'; readonly find: FindState | null };

export const NO_INTERACTION: InteractionState = Object.freeze({ kind: 'none' });

export type CompileFindResult =
  | { readonly ok: true; readonly query: FindQuery }
  | { readonly ok: false; readonly message: string };

/** Compile Find through the same comma-authored alias parser, normalization,
 * validation, and core group compiler as a durable Term. Its aliases are OR
 * alternatives within one temporary identity; Find never mutates Terms. */
export function compileFindQuery(raw: string, newId: () => string): CompileFindResult {
  const aliases = parseAuthoredAliases(raw);
  if (aliases.length === 0) {
    return { ok: false, message: 'type at least one letter or number' };
  }
  const groupId = `find-group:${newId()}`;
  const style = defaultSeriesStyle(0);
  const authored: NotebookGroupV1 = {
    id: groupId,
    aliases,
    exactMatch: false,
    countOverlaps: false,
    style,
  };
  try {
    validateNotebookGroup(authored);
    const group = coreGroupOf(authored);
    return {
      ok: true,
      query: {
        raw: aliases.join(', '),
        label: groupTitle(authored),
        seriesId: `find-series:${newId()}`,
        group,
        identity: termGroupIdentity(group),
        style,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function corpusPosition(
  point: FindAnchor,
  readyDocs: readonly string[],
): readonly [ordinal: number, token: number] | null {
  const ordinal = readyDocs.indexOf(point.doc);
  return ordinal < 0 ? null : [ordinal, point.token];
}

/** occurrence-step cycles at corpus edges but does not expose that fact. The
 * declared document order plus the captured issue-time anchor derives it
 * exactly, including a one-occurrence query that wraps back to itself. */
export function findWrapped(
  anchor: FindAnchor,
  hit: Pick<OccurrenceStepHitV1, 'doc' | 'token'>,
  direction: 1 | -1,
  readyDocs: readonly string[],
): boolean {
  const from = corpusPosition(anchor, readyDocs);
  const to = corpusPosition(hit, readyDocs);
  if (from === null || to === null) return false;
  const comparison = to[0] === from[0] ? to[1] - from[1] : to[0] - from[0];
  return direction === 1 ? comparison <= 0 : comparison >= 0;
}

export function findStatusText(
  find: FindState | null,
  documentTitle: (doc: string) => string,
): string {
  if (find === null) return 'Type a term or comma-separated aliases to find in the corpus.';
  const quoted = `“${find.query.raw}”`;
  switch (find.state.status) {
    case 'idle': return `Ready to find ${quoted}.`;
    case 'pending': return `Searching for ${quoted}.`;
    case 'edge': return `No matches for ${quoted} in this corpus.`;
    case 'error': return `Find failed: ${find.state.message}`;
    case 'ready': {
      const place = `${documentTitle(find.state.hit.doc)} · token ${(find.state.hit.token + 1).toLocaleString()}`;
      if (!find.state.wrapped) return `${quoted} in ${place}.`;
      const edge = find.state.direction === 1 ? 'first' : 'last';
      return `Wrapped to the ${edge} match of ${quoted} · ${place}.`;
    }
    default: {
      const exhaustive: never = find.state;
      return exhaustive;
    }
  }
}

export interface FindBarModel {
  readonly hasSubmittedQuery: boolean;
  readonly busy: boolean;
}

export function findBarModel(
  interaction: InteractionState,
): FindBarModel {
  const find = interaction.kind === 'find' ? interaction.find : null;
  return {
    hasSubmittedQuery: find !== null,
    busy: find?.state.status === 'pending'
      || find?.trend.status === 'pending'
      || find?.dispersion.status === 'pending',
  };
}
