import type { SavedSelectionV1 } from '@texttrends/core';
import {
  decodeShareLink,
  matchShareDocuments,
} from './share-state.ts';
import type { SelectionCheck } from './store.ts';

export type FindingsRowKind = 'range' | 'pin' | 'anchor';

export interface FindingsRowTarget {
  readonly surface: 'findings-row';
  readonly kind: FindingsRowKind;
  readonly id: string;
}

export interface ShareReviewTarget {
  readonly surface: 'share-review';
}

export const SHARE_REPLACE_SURVIVORS =
  'Replacing keeps your pinned evidence and replaces the notebook, active tracks, saved ranges, and view settings.';

export type ShareDraftReview =
  | { readonly status: 'empty' }
  | { readonly status: 'invalid'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly groups: number;
      readonly documents: number;
      readonly anchors: number;
      readonly matchedDocuments: number;
      readonly unmatchedDocuments: readonly string[];
    };

const SAFE_ID = /^[A-Za-z0-9_-]+$/u;
const MAX_FINDINGS_ID_UNITS = 128;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFindingsId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= MAX_FINDINGS_ID_UNITS;
}

/** A deterministic injective DOM token for admitted persisted ids. The s/x
 * prefix keeps the safe literal and encoded domains disjoint. */
export function findingsDomToken(id: string): string {
  if (!isFindingsId(id)) {
    throw new RangeError(
      `a Findings id must contain 1–${MAX_FINDINGS_ID_UNITS} UTF-16 code units`,
    );
  }
  if (SAFE_ID.test(id)) return `s${id}`;
  return `x${[...id]
    .map((character) => character.codePointAt(0)!.toString(16))
    .join('-')}`;
}

export function findingsRowControlId(kind: FindingsRowKind, id: string): string {
  return `findings-${kind}-${findingsDomToken(id)}`;
}

export function findingsRowTarget(value: unknown): FindingsRowTarget | null {
  if (!record(value) || value.surface !== 'findings-row') return null;
  if (
    value.kind !== 'range'
    && value.kind !== 'pin'
    && value.kind !== 'anchor'
  ) return null;
  if (!isFindingsId(value.id)) return null;
  return { surface: 'findings-row', kind: value.kind, id: value.id };
}

export function shareReviewTarget(value: unknown): ShareReviewTarget | null {
  return record(value) && value.surface === 'share-review'
    ? { surface: 'share-review' }
    : null;
}

export function reviewShareDraft(
  value: string,
  local: readonly { readonly doc: string; readonly text: string }[],
): ShareDraftReview {
  if (value.trim() === '') return { status: 'empty' };
  try {
    const share = decodeShareLink(value.trim());
    const match = matchShareDocuments(share, local);
    return {
      status: 'ready',
      groups: share.n.groups.length,
      documents: share.x.length,
      anchors: (share.r ?? []).length,
      matchedDocuments: match.matchedDocuments,
      unmatchedDocuments: match.unmatchedDocuments,
    };
  } catch (error) {
    return {
      status: 'invalid',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function findingsRowTargetIsStale(
  target: FindingsRowTarget,
  groups: Readonly<Record<FindingsRowKind, ReadonlySet<string>>>,
): boolean {
  return !groups[target.kind].has(target.id);
}

export interface SavedRangeRowView {
  readonly id: string;
  readonly controlId: string;
  readonly name: string;
  readonly documentId: string;
  readonly document: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly charSpan: string;
  readonly textHash: string;
  readonly check: SelectionCheck | null;
}

export function savedRangeRows(
  selections: readonly SavedSelectionV1[],
  checks: ReadonlyMap<string, SelectionCheck>,
  documentTitles: ReadonlyMap<string, string>,
): readonly SavedRangeRowView[] {
  return selections.map((selection) => ({
    id: selection.id,
    controlId: findingsRowControlId('range', selection.id),
    name: selection.name,
    documentId: selection.anchor.doc,
    document: documentTitles.get(selection.anchor.doc) ?? selection.anchor.doc,
    charStart: selection.anchor.chars.start,
    charEnd: selection.anchor.chars.end,
    charSpan: `${selection.anchor.chars.start + 1}–${selection.anchor.chars.end}`,
    textHash: selection.anchor.text,
    check: checks.get(selection.id) ?? null,
  }));
}
