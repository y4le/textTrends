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
import type { RsvpPacing } from '@texttrends/rsvp';

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

export interface RsvpState extends RsvpPacing {
  readonly snapshot: string;
  readonly doc: string;
  readonly docTokenCount: number;
  /** Immutable entry position. The presentation owns the later live cursor. */
  readonly startToken: number;
  readonly playing: boolean;
}

export type PrimaryInteraction =
  | { readonly kind: 'none' }
  | { readonly kind: 'find'; readonly find: FindState | null };

/** The one primary interaction state. Future command and speed modes extend
 * this union instead of adding independently-owned component flags. */
export type InteractionState =
  | PrimaryInteraction
  | {
      readonly kind: 'rsvp';
      readonly rsvp: RsvpState;
      readonly suspended: PrimaryInteraction;
    };

export const NO_INTERACTION: PrimaryInteraction = Object.freeze({ kind: 'none' });

export type FindInteraction = Extract<PrimaryInteraction, { readonly kind: 'find' }>;

/** Presentation, track derivation, and non-navigating analysis see a suspended
 * Find as still effective. Navigation leases and seek writers must continue to
 * fence on the literal kind so a late result cannot move RSVP. */
export function findScope(interaction: InteractionState): FindInteraction | null {
  const primary = interaction.kind === 'rsvp'
    ? interaction.suspended
    : interaction;
  return primary.kind === 'find' ? primary : null;
}

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

export interface FindMatchProgress {
  readonly current: number;
  readonly total: number;
}

interface FindMatchesState {
  readonly snapshot: string;
  readonly request: {
    readonly anchor:
      | { readonly kind: 'rank'; readonly rank: number }
      | { readonly kind: 'position'; readonly doc: string; readonly token: number };
  } | null;
  readonly resident: {
    readonly total: number;
    readonly firstRank: number;
    readonly rows: readonly {
      readonly seriesId: string;
      readonly groupId: string;
      readonly members: readonly number[];
      readonly doc: string;
      readonly pos: number;
    }[];
  } | null;
  readonly state: { readonly status: 'pending' | 'ready' | 'error' };
}

/** Expose an exact one-based Find position only after the matching bounded
 * window lands. The row check prevents a retained or superseded window from
 * briefly labelling a newer occurrence-step result with stale progress. */
export function findMatchProgress(
  find: FindState | null,
  matches: FindMatchesState | null,
): FindMatchProgress | null {
  if (
    find?.state.status !== 'ready'
    || matches?.state.status !== 'ready'
    || matches.snapshot !== find.snapshot
  ) return null;
  const hit = find.state.hit;
  const anchor = matches.request?.anchor;
  const resident = matches.resident;
  if (
    anchor?.kind !== 'position'
    || anchor.doc !== hit.doc
    || anchor.token !== hit.token
    || resident === null
    || !Number.isSafeInteger(resident.total)
    || !Number.isSafeInteger(resident.firstRank)
    || resident.total < 1
    || resident.firstRank < 0
  ) return null;
  const rowIndex = resident.rows.findIndex((row) =>
    row.seriesId === find.query.seriesId
    && row.groupId === find.query.group.id
    && row.doc === hit.doc
    && row.pos === hit.token
    && row.members.length === hit.members.length
    && row.members.every((member, index) => member === hit.members[index]));
  const rank = resident.firstRank + rowIndex;
  if (rowIndex < 0 || rank >= resident.total) return null;
  return { current: rank + 1, total: resident.total };
}

export function findBarModel(
  interaction: InteractionState,
): FindBarModel {
  const find = findScope(interaction)?.find ?? null;
  return {
    hasSubmittedQuery: find !== null,
    busy: find?.state.status === 'pending'
      || find?.trend.status === 'pending'
      || find?.dispersion.status === 'pending',
  };
}
