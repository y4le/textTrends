/**
 * Exact, bounded occurrence navigation over one cached NumericOccurrences
 * value. The result carries one hit at most; the full occurrence arrays never
 * cross the worker boundary.
 */

import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { ResolvedSelection } from '../snapshot/selection.ts';
import type { NumericOccurrences } from './occurrences.ts';

export interface OccurrenceStepRequestV1 {
  readonly method: 'occurrence-step/1';
  readonly doc: string;
  readonly token: number;
  readonly direction: 1 | -1;
}

export interface OccurrenceStepHitV1 {
  readonly doc: string;
  readonly token: number;
  readonly spanTokens: number;
  readonly members: readonly number[];
}

export interface OccurrenceStepResultV1 {
  readonly method: 'occurrence-step/1';
  readonly hit: OccurrenceStepHitV1 | null;
  readonly atEdge: boolean;
}

function assertFullCorpusSelection(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
): void {
  if (selection.snapshot !== snapshot.id) {
    throw new RangeError('selection is bound to a different snapshot');
  }
  if (
    selection.spec.ranges !== undefined
    || selection.spec.docs.length !== snapshot.docs.length
    || selection.spec.docs.some((doc, index) => doc !== snapshot.docs[index]?.doc)
  ) {
    throw new RangeError('occurrence stepping requires the full corpus selection');
  }
}

function assertOccurrenceShape(occ: NumericOccurrences): void {
  const count = occ.pos.length;
  if (
    occ.docOrdinal.length !== count
    || occ.spanTokens.length !== count
    || occ.memberOffsets.length !== count + 1
    || occ.memberOffsets[0] !== 0
    || occ.memberOffsets[count] !== occ.memberOrdinals.length
  ) {
    throw new RangeError('malformed occurrence arrays');
  }
}

/** One-time cache-admission check for the ordering the binary step relies on.
 * Occurrence construction guarantees this order; validating at insertion
 * keeps repeated navigation logarithmic without trusting a malformed cache. */
export function validateOccurrenceOrder(
  snapshot: CorpusSnapshotV1,
  occ: NumericOccurrences,
): void {
  assertOccurrenceShape(occ);
  let previousDoc = -1;
  let previousPos = -1;
  for (let index = 0; index < occ.pos.length; index++) {
    const doc = occ.docOrdinal[index]!;
    const pos = occ.pos[index]!;
    const ref = snapshot.docs[doc];
    if (
      !ref
      || pos >= ref.tokenCount
      || occ.spanTokens[index] === 0
      || pos + occ.spanTokens[index]! > ref.tokenCount
      || doc < previousDoc
      || (doc === previousDoc && pos < previousPos)
    ) {
      throw new RangeError(`occurrence ${index} is outside declared corpus order`);
    }
    previousDoc = doc;
    previousPos = pos;
  }
}

/** Step strictly by distinct occurrence START from the supplied document-local
 * token. Under countOverlaps, several raw occurrences may share that start;
 * they form one reachable reading stop with maximal span and unioned member
 * provenance. A hit beginning at the anchor is skipped. Callers may request a
 * cycle at the edge; next/previous round trips otherwise retain the same stop
 * identity. The cache validates the occurrence ordering once before this
 * logarithmic lookup. */
export function occurrenceStep(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  occ: NumericOccurrences,
  request: OccurrenceStepRequestV1,
  cycleAtEdge = false,
): OccurrenceStepResultV1 {
  assertFullCorpusSelection(snapshot, selection);
  if (occ.snapshot !== snapshot.id) {
    throw new RangeError('occurrences were computed under a different snapshot');
  }
  if (occ.selection !== selection.hash) {
    throw new RangeError('occurrences were computed under a different selection');
  }
  assertOccurrenceShape(occ);
  if (request.method !== 'occurrence-step/1' || (request.direction !== 1 && request.direction !== -1)) {
    throw new RangeError('invalid occurrence-step request');
  }
  const anchorOrdinal = snapshot.docs.findIndex((ref) => ref.doc === request.doc);
  const anchorRef = snapshot.docs[anchorOrdinal];
  if (
    anchorOrdinal < 0
    || !anchorRef
    || !Number.isSafeInteger(request.token)
    || request.token < 0
    || request.token >= anchorRef.tokenCount
  ) {
    throw new RangeError(`occurrence-step anchor is outside '${request.doc}'`);
  }
  const anchor = anchorRef.sequenceTokenBase + request.token;
  const globalAt = (index: number): number => {
    const ref = snapshot.docs[occ.docOrdinal[index]!];
    if (!ref) throw new RangeError(`occurrence references unknown doc ordinal ${occ.docOrdinal[index]}`);
    return ref.sequenceTokenBase + occ.pos[index]!;
  };

  let low = 0;
  let high = occ.pos.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const beforeBoundary = request.direction === 1
      ? globalAt(middle) <= anchor
      : globalAt(middle) < anchor;
    if (beforeBoundary) low = middle + 1;
    else high = middle;
  }
  let index = request.direction === 1 ? low : low - 1;
  if (index < 0 || index >= occ.pos.length) {
    if (!cycleAtEdge || occ.pos.length === 0) {
      return {
        method: 'occurrence-step/1',
        hit: null,
        atEdge: true,
      };
    }
    index = request.direction === 1 ? 0 : occ.pos.length - 1;
  }
  const sameStart = (left: number, right: number): boolean =>
    occ.docOrdinal[left] === occ.docOrdinal[right]
    && occ.pos[left] === occ.pos[right];
  let first = index;
  while (first > 0 && sameStart(first - 1, first)) first--;
  let end = first + 1;
  while (end < occ.pos.length && sameStart(first, end)) end++;

  const docOrdinal = occ.docOrdinal[first]!;
  const ref = snapshot.docs[docOrdinal];
  if (!ref) throw new RangeError(`occurrence references unknown doc ordinal ${docOrdinal}`);
  let spanTokens = 0;
  const members = new Set<number>();
  for (let raw = first; raw < end; raw++) {
    spanTokens = Math.max(spanTokens, occ.spanTokens[raw]!);
    const memberStart = occ.memberOffsets[raw]!;
    const memberEnd = occ.memberOffsets[raw + 1]!;
    if (memberStart > memberEnd || memberEnd > occ.memberOrdinals.length) {
      throw new RangeError(`occurrence ${raw} has malformed member offsets`);
    }
    for (let member = memberStart; member < memberEnd; member++) {
      members.add(occ.memberOrdinals[member]!);
    }
  }
  return {
    method: 'occurrence-step/1',
    hit: {
      doc: ref.doc,
      token: occ.pos[first]!,
      spanTokens,
      members: [...members].sort((left, right) => left - right),
    },
    atEdge: false,
  };
}
