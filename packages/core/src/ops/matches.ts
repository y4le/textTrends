/**
 * Continuous Matches planning over the full ready corpus.
 *
 * The occurrence vectors remain the shared matching primitive. This module
 * builds a small, cacheable rank axis at duplicate-run boundaries, then
 * restores a k-way merge frontier for an exact bounded window. It never
 * materializes a corpus-sized merged row index.
 */

import { tokenEndChar, type DocumentIndexV1 } from '../index/build.ts';
import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { ResolvedSelection } from '../snapshot/selection.ts';
import {
  assertBoundShards,
  type BoundShards,
  type BoundTexts,
  internalShardOf,
} from './binding.ts';
import {
  KWIC_CONTEXT_MARKS_MAX_PER_SIDE,
  KWIC_CONTEXT_MAX_TOKENS,
  KWIC_MAX_PAGE,
  MAX_KWIC_TRACKS,
  materializeKwicPage,
  type KwicRow,
  type KwicTrackIdentity,
  type NumericKwicPage,
  type NumericKwicContextMark,
  type NumericKwicRow,
} from './kwic.ts';
import { collectTokenWindowMarks, type TokenWindowMark } from './marks.ts';
import {
  OCCURRENCE_LIMITS_V1,
  TERM_GROUP_LIMITS_V1,
  type NumericOccurrences,
} from './occurrences.ts';

export const MATCHES_AXIS_STRIDE = 128;

export type MatchesAnchorV1 =
  | { readonly kind: 'position'; readonly doc: string; readonly token: number }
  | { readonly kind: 'rank'; readonly rank: number };

export interface MatchesWindowRequestV1 {
  readonly anchor: MatchesAnchorV1;
  readonly before: number;
  readonly after: number;
  readonly contextTokens: number;
}

/** Transfer-safe public copy of the sparse axis. */
export interface MatchesAxisArraysV1 {
  readonly ranks: Uint32Array;
  readonly globalTokens: Uint32Array;
}

/**
 * Cacheable core axis. The module-private payload retains only sparse samples,
 * never occurrence vectors. Planning requires compatible admitted,
 * order-validated tracks and checks their count, total, and restored frontier.
 */
export interface MatchesAxisV1 {
  readonly snapshot: CorpusSnapshotV1['id'];
  readonly selection: ResolvedSelection['hash'];
  readonly total: number;
  readonly trackCount: number;
}

export interface MatchesPositionBracketV1 {
  /** At the corpus tail this may equal `anchorRank`; comparing globalToken to
   * the requested cursor distinguishes the last row from the end sentinel. */
  readonly rank: number;
  readonly globalToken: number;
}

export interface NumericMatchesWindowV1 {
  readonly snapshot: CorpusSnapshotV1['id'];
  readonly total: number;
  readonly trackCount: number;
  readonly anchorRank: number | null;
  readonly firstRank: number;
  /** Last occurrence strictly before a position anchor, when one exists. */
  readonly preceding: MatchesPositionBracketV1 | null;
  readonly rows: readonly NumericKwicRow[];
}

export interface MatchesWindowV1 extends Omit<NumericMatchesWindowV1, 'rows'> {
  readonly rows: readonly KwicRow[];
}

interface RowRef {
  readonly trackOrdinal: number;
  readonly occurrenceIndex: number;
}

interface MatchesAxisSource {
  readonly ranks: Uint32Array;
  readonly globalTokens: Uint32Array;
}

const axisSources = new WeakMap<MatchesAxisV1, MatchesAxisSource>();

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
    throw new RangeError('matches windows require the full corpus selection');
  }
}

function globalAt(
  snapshot: CorpusSnapshotV1,
  occurrence: NumericOccurrences,
  index: number,
): number {
  const ordinal = occurrence.docOrdinal[index] as number;
  const ref = snapshot.docs[ordinal];
  if (!ref) throw new RangeError(`occurrence references unknown doc ordinal ${ordinal}`);
  return ref.sequenceTokenBase + (occurrence.pos[index] as number);
}

function assertTrack(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  occurrence: NumericOccurrences,
): void {
  if (occurrence.snapshot !== snapshot.id) {
    throw new RangeError('occurrences were computed under a different snapshot');
  }
  if (occurrence.selection !== selection.hash) {
    throw new RangeError('occurrences were computed under a different selection');
  }
  const count = occurrence.pos.length;
  if (
    count > OCCURRENCE_LIMITS_V1.maxOccurrences
    || occurrence.docOrdinal.length !== count
    || occurrence.spanTokens.length !== count
    || occurrence.memberOffsets.length !== count + 1
    || occurrence.memberOrdinals.length > OCCURRENCE_LIMITS_V1.maxMemberOrdinals
    || occurrence.memberOffsets[0] !== 0
    || occurrence.memberOffsets[count] !== occurrence.memberOrdinals.length
  ) {
    throw new RangeError('malformed occurrence arrays');
  }
  let previousDoc = -1;
  let previousPos = -1;
  let previousOffset = 0;
  for (let index = 0; index < count; index++) {
    const docOrdinal = occurrence.docOrdinal[index] as number;
    const pos = occurrence.pos[index] as number;
    const span = occurrence.spanTokens[index] as number;
    const ref = snapshot.docs[docOrdinal];
    const memberEnd = occurrence.memberOffsets[index + 1] as number;
    if (
      !ref
      || pos >= ref.tokenCount
      || span === 0
      || pos + span > ref.tokenCount
      || docOrdinal < previousDoc
      || (docOrdinal === previousDoc && pos < previousPos)
      || memberEnd < previousOffset
      || memberEnd > occurrence.memberOrdinals.length
    ) {
      throw new RangeError(`occurrence ${index} is outside declared corpus order`);
    }
    previousDoc = docOrdinal;
    previousPos = pos;
    previousOffset = memberEnd;
  }
}

function lowerBoundGlobal(
  snapshot: CorpusSnapshotV1,
  occurrence: NumericOccurrences,
  target: number,
): number {
  let low = 0;
  let high = occurrence.pos.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (globalAt(snapshot, occurrence, middle) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function nextToken(
  snapshot: CorpusSnapshotV1,
  tracks: readonly NumericOccurrences[],
  frontiers: readonly number[],
): number | null {
  let token = Number.POSITIVE_INFINITY;
  for (let track = 0; track < tracks.length; track++) {
    const occurrence = tracks[track] as NumericOccurrences;
    const index = frontiers[track] as number;
    if (index < occurrence.pos.length) {
      token = Math.min(token, globalAt(snapshot, occurrence, index));
    }
  }
  return Number.isFinite(token) ? token : null;
}

/** Advance every track through the next `(document, token)` run. */
function advanceRun(
  snapshot: CorpusSnapshotV1,
  tracks: readonly NumericOccurrences[],
  frontiers: number[],
  token: number,
): number {
  let count = 0;
  for (let track = 0; track < tracks.length; track++) {
    const occurrence = tracks[track] as NumericOccurrences;
    let index = frontiers[track] as number;
    while (index < occurrence.pos.length && globalAt(snapshot, occurrence, index) === token) {
      index++;
      count++;
    }
    frontiers[track] = index;
  }
  if (count > tracks.length * TERM_GROUP_LIMITS_V1.maxMembers) {
    throw new RangeError('a match duplicate run exceeds the admitted member bound');
  }
  return count;
}

function compareMembers(
  tracks: readonly NumericOccurrences[],
  left: RowRef,
  right: RowRef,
): number {
  const a = tracks[left.trackOrdinal] as NumericOccurrences;
  const b = tracks[right.trackOrdinal] as NumericOccurrences;
  const aStart = a.memberOffsets[left.occurrenceIndex] as number;
  const aEnd = a.memberOffsets[left.occurrenceIndex + 1] as number;
  const bStart = b.memberOffsets[right.occurrenceIndex] as number;
  const bEnd = b.memberOffsets[right.occurrenceIndex + 1] as number;
  const length = Math.min(aEnd - aStart, bEnd - bStart);
  for (let index = 0; index < length; index++) {
    const difference = (a.memberOrdinals[aStart + index] as number)
      - (b.memberOrdinals[bStart + index] as number);
    if (difference !== 0) return difference;
  }
  return (aEnd - aStart) - (bEnd - bStart);
}

/** Gather and impose the current KWIC deterministic finals within one run. */
function gatherRun(
  snapshot: CorpusSnapshotV1,
  tracks: readonly NumericOccurrences[],
  frontiers: number[],
  token: number,
): RowRef[] {
  const rows: RowRef[] = [];
  for (let trackOrdinal = 0; trackOrdinal < tracks.length; trackOrdinal++) {
    const occurrence = tracks[trackOrdinal] as NumericOccurrences;
    let index = frontiers[trackOrdinal] as number;
    while (index < occurrence.pos.length && globalAt(snapshot, occurrence, index) === token) {
      if (rows.length >= tracks.length * TERM_GROUP_LIMITS_V1.maxMembers) {
        throw new RangeError('a match duplicate run exceeds the admitted member bound');
      }
      rows.push({ trackOrdinal, occurrenceIndex: index });
      index++;
    }
    frontiers[trackOrdinal] = index;
  }
  rows.sort((left, right) => {
    const a = tracks[left.trackOrdinal] as NumericOccurrences;
    const b = tracks[right.trackOrdinal] as NumericOccurrences;
    return (a.spanTokens[left.occurrenceIndex] as number)
      - (b.spanTokens[right.occurrenceIndex] as number)
      || left.trackOrdinal - right.trackOrdinal
      || compareMembers(tracks, left, right);
  });
  return rows;
}

/** Build the cacheable sparse rank axis in one bounded pass over occurrences. */
export function buildMatchesAxis(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  tracks: readonly NumericOccurrences[],
): MatchesAxisV1 {
  assertFullCorpusSelection(snapshot, selection);
  if (tracks.length < 1 || tracks.length > MAX_KWIC_TRACKS) {
    throw new RangeError(`matches requires 1..${MAX_KWIC_TRACKS} tracks`);
  }
  let total = 0;
  for (const track of tracks) {
    assertTrack(snapshot, selection, track);
    total += track.pos.length;
  }

  const ranks: number[] = [];
  const globalTokens: number[] = [];
  const frontiers = new Array<number>(tracks.length).fill(0);
  let rank = 0;
  let previousSampleRank = -MATCHES_AXIS_STRIDE;
  for (;;) {
    const token = nextToken(snapshot, tracks, frontiers);
    if (token === null) break;
    if (ranks.length === 0 || rank - previousSampleRank >= MATCHES_AXIS_STRIDE) {
      ranks.push(rank);
      globalTokens.push(token);
      previousSampleRank = rank;
    }
    rank += advanceRun(snapshot, tracks, frontiers, token);
  }
  if (rank !== total) throw new RangeError('matches merge did not consume every occurrence');

  const axis: MatchesAxisV1 = Object.freeze({
    snapshot: snapshot.id,
    selection: selection.hash,
    total,
    trackCount: tracks.length,
  });
  axisSources.set(axis, {
    ranks: Uint32Array.from(ranks),
    globalTokens: Uint32Array.from(globalTokens),
  });
  return axis;
}

/** Fresh arrays suitable for structured clone or transfer. */
export function copyMatchesAxis(axis: MatchesAxisV1): MatchesAxisArraysV1 {
  const source = axisSources.get(axis);
  if (!source) throw new RangeError('unrecognized matches axis');
  return {
    ranks: source.ranks.slice(),
    globalTokens: source.globalTokens.slice(),
  };
}

/** Resident bytes retained by an axis cache. Occurrence vectors are not pinned. */
export function matchesAxisPayloadBytes(axis: MatchesAxisV1): number {
  const source = axisSources.get(axis);
  if (!source) throw new RangeError('unrecognized matches axis');
  return source.ranks.byteLength + source.globalTokens.byteLength;
}

function validateRequest(request: MatchesWindowRequestV1): void {
  if (
    !Number.isInteger(request.before)
    || request.before < 0
    || !Number.isInteger(request.after)
    || request.after < 0
    || request.before + 1 + request.after > KWIC_MAX_PAGE
  ) {
    throw new RangeError(`matches window must contain 1..${KWIC_MAX_PAGE} rows`);
  }
  if (
    !Number.isInteger(request.contextTokens)
    || request.contextTokens < 0
    || request.contextTokens > KWIC_CONTEXT_MAX_TOKENS
  ) {
    throw new RangeError(`contextTokens must be an integer from 0 through ${KWIC_CONTEXT_MAX_TOKENS}`);
  }
}

function sampleAtOrBefore(ranks: Uint32Array, rank: number): number {
  let low = 0;
  let high = ranks.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((ranks[middle] as number) <= rank) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

interface ContextMarks {
  readonly marks: readonly NumericKwicContextMark[];
  readonly truncated: boolean;
}

/** Intersect projected occurrences with one node-excluding context side,
 * merge overlapping geometry, then keep the spans nearest the node. */
function contextMarks(
  projected: readonly TokenWindowMark[],
  sideStart: number,
  sideEnd: number,
  side: 'left' | 'right',
): ContextMarks {
  const merged: Array<{
    trackOrdinals: number[];
    charStartUtf16: number;
    charEndUtf16: number;
    clippedStart: boolean;
    clippedEnd: boolean;
  }> = [];
  for (const mark of projected) {
    const start = Math.max(sideStart, mark.charStartUtf16);
    const end = Math.min(sideEnd, mark.charEndUtf16);
    if (start >= end) continue;
    const next = {
      trackOrdinals: [mark.trackOrdinal],
      charStartUtf16: start,
      charEndUtf16: end,
      clippedStart: mark.clippedStart || mark.charStartUtf16 < sideStart,
      clippedEnd: mark.clippedEnd || mark.charEndUtf16 > sideEnd,
    };
    const previous = merged.at(-1);
    if (!previous || next.charStartUtf16 >= previous.charEndUtf16) {
      merged.push(next);
      continue;
    }
    if (!previous.trackOrdinals.includes(mark.trackOrdinal)) {
      previous.trackOrdinals.push(mark.trackOrdinal);
      previous.trackOrdinals.sort((left, right) => left - right);
    }
    if (next.charStartUtf16 === previous.charStartUtf16) {
      previous.clippedStart ||= next.clippedStart;
    }
    if (next.charEndUtf16 > previous.charEndUtf16) {
      previous.charEndUtf16 = next.charEndUtf16;
      previous.clippedEnd = next.clippedEnd;
    } else if (next.charEndUtf16 === previous.charEndUtf16) {
      previous.clippedEnd ||= next.clippedEnd;
    }
  }
  const truncated = merged.length > KWIC_CONTEXT_MARKS_MAX_PER_SIDE;
  const marks = truncated
    ? side === 'left'
      ? merged.slice(-KWIC_CONTEXT_MARKS_MAX_PER_SIDE)
      : merged.slice(0, KWIC_CONTEXT_MARKS_MAX_PER_SIDE)
    : merged;
  return { marks, truncated };
}

function numericRow(
  snapshot: CorpusSnapshotV1,
  bound: BoundShards,
  tracks: readonly NumericOccurrences[],
  row: RowRef,
  contextTokens: number,
  shardCache: Array<DocumentIndexV1 | undefined>,
): NumericKwicRow {
  const occurrence = tracks[row.trackOrdinal] as NumericOccurrences;
  const index = row.occurrenceIndex;
  const docOrdinal = occurrence.docOrdinal[index] as number;
  const pos = occurrence.pos[index] as number;
  const spanTokens = occurrence.spanTokens[index] as number;
  let shard = shardCache[docOrdinal];
  if (!shard) {
    const doc = snapshot.docs[docOrdinal]?.doc;
    if (!doc) throw new RangeError(`unknown doc ordinal ${docOrdinal}`);
    shard = internalShardOf(bound, doc);
    shardCache[docOrdinal] = shard;
  }
  const memberStart = occurrence.memberOffsets[index] as number;
  const memberEnd = occurrence.memberOffsets[index + 1] as number;
  const leftToken = Math.max(0, pos - contextTokens);
  const rightToken = Math.min(shard.tokenTypeIds.length - 1, pos + spanTokens - 1 + contextTokens);
  const leftCharStart = shard.startsUtf16[leftToken] as number;
  const nodeCharStart = shard.startsUtf16[pos] as number;
  const nodeCharEnd = tokenEndChar(shard, pos + spanTokens - 1);
  const rightCharEnd = tokenEndChar(shard, rightToken);
  const projected = collectTokenWindowMarks(
    shard,
    docOrdinal,
    tracks,
    leftToken,
    rightToken + 1,
  );
  const left = contextMarks(projected, leftCharStart, nodeCharStart, 'left');
  const right = contextMarks(projected, nodeCharEnd, rightCharEnd, 'right');
  return {
    trackOrdinal: row.trackOrdinal,
    docOrdinal,
    pos,
    spanTokens,
    members: Array.from(occurrence.memberOrdinals.subarray(memberStart, memberEnd)),
    leftCharStart,
    nodeCharStart,
    nodeCharEnd,
    rightCharEnd,
    leftMarks: left.marks,
    rightMarks: right.marks,
    leftMarksTruncated: left.truncated,
    rightMarksTruncated: right.truncated,
  };
}

/**
 * Plan one exact bounded window from a cached sparse axis. `tracks` must be
 * admitted, order-validated NumericOccurrences. Axis construction performs
 * that admission once; executors substituting recomputed vectors must preserve
 * the same occurrence-cache admission discipline.
 */
export function planMatchesWindow(
  snapshot: CorpusSnapshotV1,
  bound: BoundShards,
  selection: ResolvedSelection,
  axis: MatchesAxisV1,
  tracks: readonly NumericOccurrences[],
  request: MatchesWindowRequestV1,
): NumericMatchesWindowV1 {
  assertBoundShards(bound);
  if (bound.snapshot !== snapshot.id) throw new RangeError('bound shards belong to a different snapshot');
  assertFullCorpusSelection(snapshot, selection);
  validateRequest(request);
  if (axis.snapshot !== snapshot.id || axis.selection !== selection.hash) {
    throw new RangeError('matches axis belongs to different coordinates');
  }
  const source = axisSources.get(axis);
  if (!source) throw new RangeError('unrecognized matches axis');
  if (tracks.length !== axis.trackCount) {
    throw new RangeError(`matches axis requires ${axis.trackCount} tracks`);
  }
  let trackTotal = 0;
  for (const track of tracks) {
    if (track.snapshot !== snapshot.id || track.selection !== selection.hash) {
      throw new RangeError('matches tracks belong to different coordinates');
    }
    trackTotal += track.pos.length;
  }
  if (trackTotal !== axis.total) {
    throw new RangeError('matches tracks do not match the axis total');
  }

  const anchor = request.anchor;
  let anchorRank: number | null = null;
  let preceding: MatchesPositionBracketV1 | null = null;
  if (axis.total > 0) {
    if (anchor.kind === 'rank') {
      if (
        !Number.isSafeInteger(anchor.rank)
        || anchor.rank < 0
        || anchor.rank >= axis.total
      ) {
        throw new RangeError(`matches rank must be in [0, ${axis.total})`);
      }
      anchorRank = anchor.rank;
    } else {
      const docOrdinal = snapshot.docs.findIndex((ref) => ref.doc === anchor.doc);
      const ref = snapshot.docs[docOrdinal];
      if (
        docOrdinal < 0
        || !ref
        || !Number.isSafeInteger(anchor.token)
        || anchor.token < 0
        || anchor.token >= ref.tokenCount
      ) {
        throw new RangeError(`matches position is outside '${anchor.doc}'`);
      }
      const target = ref.sequenceTokenBase + anchor.token;
      const trackFrontiers = tracks.map((track) => lowerBoundGlobal(snapshot, track, target));
      const rankAtOrAfter = trackFrontiers.reduce((sum, frontier) => sum + frontier, 0);
      anchorRank = Math.min(rankAtOrAfter, axis.total - 1);
      if (rankAtOrAfter > 0) {
        let token = -1;
        for (let track = 0; track < tracks.length; track++) {
          const frontier = trackFrontiers[track] as number;
          if (frontier > 0) token = Math.max(token, globalAt(snapshot, tracks[track] as NumericOccurrences, frontier - 1));
        }
        preceding = { rank: rankAtOrAfter - 1, globalToken: token };
      }
    }
  } else if (anchor.kind === 'rank' && anchor.rank !== 0) {
    throw new RangeError('an empty matches accepts only rank zero');
  } else if (anchor.kind === 'position') {
    const ref = snapshot.docs.find((doc) => doc.doc === anchor.doc);
    if (
      !ref
      || !Number.isSafeInteger(anchor.token)
      || anchor.token < 0
      || anchor.token >= ref.tokenCount
    ) {
      throw new RangeError(`matches position is outside '${anchor.doc}'`);
    }
  }

  if (anchorRank === null) {
    return {
      snapshot: snapshot.id,
      total: 0,
      trackCount: axis.trackCount,
      anchorRank: null,
      firstRank: 0,
      preceding,
      rows: [],
    };
  }
  const firstRank = Math.max(0, anchorRank - request.before);
  const endRank = Math.min(axis.total, anchorRank + request.after + 1);
  const sampleIndex = sampleAtOrBefore(source.ranks, firstRank);
  const sampleRank = source.ranks[sampleIndex] as number;
  const sampleToken = source.globalTokens[sampleIndex] as number;
  const frontiers = tracks.map((track) => lowerBoundGlobal(snapshot, track, sampleToken));
  if (frontiers.reduce((sum, frontier) => sum + frontier, 0) !== sampleRank) {
    throw new RangeError('matches tracks do not reconstruct the sampled frontier');
  }
  let rank = sampleRank;
  const rows: NumericKwicRow[] = [];
  const shardCache = new Array<DocumentIndexV1 | undefined>(snapshot.docs.length);
  while (rank < endRank) {
    const token = nextToken(snapshot, tracks, frontiers);
    if (token === null) throw new RangeError('matches axis exceeds its occurrence sources');
    const run = gatherRun(snapshot, tracks, frontiers, token);
    for (let index = 0; index < run.length; index++) {
      const rowRank = rank + index;
      if (rowRank >= firstRank && rowRank < endRank) {
        rows.push(numericRow(snapshot, bound, tracks, run[index] as RowRef, request.contextTokens, shardCache));
      }
    }
    rank += run.length;
  }
  return {
    snapshot: snapshot.id,
    total: axis.total,
    trackCount: axis.trackCount,
    anchorRank,
    firstRank,
    preceding,
    rows,
  };
}

/** Materialize verified text for exactly the bounded planned rows. */
export function materializeMatchesWindow(
  snapshot: CorpusSnapshotV1,
  window: NumericMatchesWindowV1,
  texts: BoundTexts,
  tracks: readonly KwicTrackIdentity[],
): MatchesWindowV1 {
  if (tracks.length !== window.trackCount) {
    throw new RangeError(`matches window requires ${window.trackCount} track identities`);
  }
  const page: NumericKwicPage = {
    snapshot: window.snapshot,
    total: window.total,
    rows: window.rows,
  };
  return {
    snapshot: window.snapshot,
    total: window.total,
    trackCount: window.trackCount,
    anchorRank: window.anchorRank,
    firstRank: window.firstRank,
    preceding: window.preceding,
    rows: materializeKwicPage(snapshot, page, texts, tracks),
  };
}
