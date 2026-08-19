/**
 * destinations/1 — bounded passage discovery over cached occurrences.
 *
 * Planning is numeric and allocation-bounded: occurrence starts are k-way
 * merged per document, fixed windows are counted with monotone pointers,
 * nearby anchors collapse into runs, and only eight numeric slots per document
 * survive. A breadth-first deterministic greedy pass then ranks and suppresses
 * overlapping windows. This is deliberately not weighted-interval DP: the
 * product is an ordered list whose first passages are consumed independently,
 * not a set-level maximum-coverage summary.
 *
 * Materialization touches only the at-most-twelve winners. It binds source text
 * through authenticated shard/text capabilities and retains at most sixteen
 * occurrence marks per snippet.
 */

import { lowerBound, tokenEndChar } from '../index/build.ts';
import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { ResolvedSelection } from '../snapshot/selection.ts';
import {
  assertBoundShards,
  assertBoundTexts,
  internalShardOf,
  internalTextOf,
  type BoundShards,
  type BoundTexts,
} from './binding.ts';
import { MAX_KWIC_TRACKS } from './kwic.ts';
import { collectTokenWindowMarksLimited } from './marks.ts';
import { trackDocumentSlices, type NumericOccurrences } from './occurrences.ts';
import {
  assertFullCorpusSelection,
  assertOccurrenceDocumentSlices,
} from './overview.ts';

export const DESTINATION_WINDOW_OPTIONS_V0 = [300, 400, 600] as const;
export type DestinationWindowTokensV0 = typeof DESTINATION_WINDOW_OPTIONS_V0[number];
export const DESTINATION_WINDOW_TOKENS_V1 = 400;
export const DESTINATION_MAX_RESULTS = 12;
export const DESTINATION_PER_DOC_KEEP = 8;
export const DESTINATION_SNIPPET_TOKENS = 48;
export const DESTINATION_SNIPPET_UTF16 = 400;
/** UTF-8 bound keeps the 32 KiB response gate script-independent. */
export const DESTINATION_SNIPPET_UTF8 = 512;
export const DESTINATION_MAX_MARKS = 16;
export const DESTINATION_CHECKPOINT_SPAN = 65_536;
export const DESTINATION_SCORE_SCALE = 65_536;
export const DESTINATION_COUNT_CAP = 4_096;
export const DESTINATION_MAX_RARITY_WEIGHT = 16 * DESTINATION_SCORE_SCALE;
const DESTINATION_COUNT_ROOT = Uint16Array.from(
  { length: DESTINATION_COUNT_CAP + 1 },
  (_, count) => Math.floor(Math.sqrt(DESTINATION_SCORE_SCALE * count)),
);

export type DestinationCheckpoint = () => Promise<void>;

export interface DestinationFocusV1 {
  readonly a: number;
  readonly b: number;
}

export interface DestinationsRequestV1 {
  readonly method: 'destinations/1';
  readonly windowTokens: typeof DESTINATION_WINDOW_TOKENS_V1;
  readonly limit: typeof DESTINATION_MAX_RESULTS;
  readonly focus: DestinationFocusV1 | null;
}

/** CLI-only policy comparison seam retained so the real planner, rather than
 * a toy duplicate, can reproduce the 300/400/600 decision. */
export interface DestinationWindowSpikeRequestV0 {
  readonly method: 'destinations/1';
  readonly windowTokens: DestinationWindowTokensV0;
  readonly limit: typeof DESTINATION_MAX_RESULTS;
  readonly focus: DestinationFocusV1 | null;
}

export interface DestinationTrackInputV1 {
  readonly seriesId: string;
  readonly groupId: string;
  readonly occurrences: NumericOccurrences;
}

export interface DestinationsScratchV1 {
  readonly documentSlices: readonly Uint32Array[];
  readonly countByDoc: Uint8Array;
  readonly score: Float64Array;
  readonly present: Uint8Array;
  readonly totalCount: Uint32Array;
  readonly tokenStart: Uint32Array;
  readonly tokenEnd: Uint32Array;
  readonly anchorToken: Uint32Array;
  readonly anchorTrack: Uint8Array;
  /** Fixed five-track stride for every candidate slot. */
  readonly trackCounts: Uint32Array;
}

export interface NumericDestinationV1 {
  readonly docOrdinal: number;
  readonly tokens: { readonly start: number; readonly end: number };
  readonly anchorToken: number;
  readonly anchorTrackOrdinal: number;
  readonly score: number;
  readonly presentTracks: number;
  readonly counts: readonly number[];
}

export interface NumericDestinationsPlanV1 {
  readonly method: 'destinations/1';
  readonly snapshot: CorpusSnapshotV1['id'];
  readonly selection: ResolvedSelection['hash'];
  readonly windowTokens: DestinationWindowTokensV0;
  readonly focus: DestinationFocusV1 | null;
  readonly tracks: readonly {
    readonly seriesId: string;
    readonly groupId: string;
    readonly total: number;
    readonly weight: number;
  }[];
  readonly destinations: readonly NumericDestinationV1[];
}

export interface DestinationMarkV1 {
  /** Index into the result's ordered track identity table. */
  readonly trackOrdinal: number;
  readonly tokens: { readonly start: number; readonly end: number };
  readonly charsUtf16: { readonly start: number; readonly end: number };
}

export interface DestinationResultItemV1 {
  readonly doc: string;
  readonly tokens: { readonly start: number; readonly end: number };
  readonly score: number;
  readonly presentTracks: number;
  readonly counts: readonly number[];
  readonly anchor: {
    readonly seriesId: string;
    readonly groupId: string;
    readonly token: number;
  };
  readonly snippet: {
    readonly tokens: { readonly start: number; readonly end: number };
    readonly docCharsUtf16: { readonly start: number; readonly end: number };
    readonly text: string;
    readonly marks: readonly DestinationMarkV1[];
    readonly marksTruncated: boolean;
  };
}

export interface DestinationsResultV1 {
  readonly method: 'destinations/1';
  readonly windowTokens: DestinationWindowTokensV0;
  readonly focus: DestinationFocusV1 | null;
  readonly tracks: NumericDestinationsPlanV1['tracks'];
  readonly destinations: readonly DestinationResultItemV1[];
}

interface Candidate {
  readonly docOrdinal: number;
  readonly score: number;
  readonly present: number;
  readonly totalCount: number;
  readonly tokenStart: number;
  readonly tokenEnd: number;
  readonly anchorToken: number;
  readonly anchorTrack: number;
  readonly counts: readonly number[];
}

const SLOT_STRIDE = DESTINATION_PER_DOC_KEEP;

function candidateOrder(left: Candidate, right: Candidate): number {
  return candidateValueOrder(
    left.score,
    left.present,
    left.totalCount,
    left.docOrdinal,
    left.tokenStart,
    left.anchorToken,
    left.anchorTrack,
    right.score,
    right.present,
    right.totalCount,
    right.docOrdinal,
    right.tokenStart,
    right.anchorToken,
    right.anchorTrack,
  );
}

function candidateValueOrder(
  leftScore: number,
  leftPresent: number,
  leftTotal: number,
  leftDoc: number,
  leftStart: number,
  leftAnchor: number,
  leftTrack: number,
  rightScore: number,
  rightPresent: number,
  rightTotal: number,
  rightDoc: number,
  rightStart: number,
  rightAnchor: number,
  rightTrack: number,
): number {
  return rightScore - leftScore
    || rightPresent - leftPresent
    || rightTotal - leftTotal
    || leftDoc - rightDoc
    || leftStart - rightStart
    || leftAnchor - rightAnchor
    || leftTrack - rightTrack;
}

function scratchSlotOrder(
  scratch: DestinationsScratchV1,
  left: number,
  rightScore: number,
  rightPresent: number,
  rightTotal: number,
  rightStart: number,
  rightAnchor: number,
  rightTrack: number,
): number {
  return candidateValueOrder(
    scratch.score[left]!,
    scratch.present[left]!,
    scratch.totalCount[left]!,
    0,
    scratch.tokenStart[left]!,
    scratch.anchorToken[left]!,
    scratch.anchorTrack[left]!,
    rightScore,
    rightPresent,
    rightTotal,
    0,
    rightStart,
    rightAnchor,
    rightTrack,
  );
}

export function destinationScratchBytes(scratch: DestinationsScratchV1): number {
  return scratch.documentSlices.reduce((sum, slices) => sum + slices.byteLength, 0)
    + scratch.countByDoc.byteLength
    + scratch.score.byteLength
    + scratch.present.byteLength
    + scratch.totalCount.byteLength
    + scratch.tokenStart.byteLength
    + scratch.tokenEnd.byteLength
    + scratch.anchorToken.byteLength
    + scratch.anchorTrack.byteLength
    + scratch.trackCounts.byteLength;
}

export function createDestinationsScratch(
  tracks: readonly DestinationTrackInputV1[],
  docCount: number,
): DestinationsScratchV1 {
  const slots = docCount * DESTINATION_PER_DOC_KEEP;
  return {
    documentSlices: tracks.map((track) => trackDocumentSlices(track.occurrences, docCount)),
    countByDoc: new Uint8Array(docCount),
    score: new Float64Array(slots),
    present: new Uint8Array(slots),
    totalCount: new Uint32Array(slots),
    tokenStart: new Uint32Array(slots),
    tokenEnd: new Uint32Array(slots),
    anchorToken: new Uint32Array(slots),
    anchorTrack: new Uint8Array(slots),
    trackCounts: new Uint32Array(slots * MAX_KWIC_TRACKS),
  };
}

function assertRequest(request: DestinationWindowSpikeRequestV0, trackCount: number): void {
  if (
    request.method !== 'destinations/1'
    || !DESTINATION_WINDOW_OPTIONS_V0.includes(request.windowTokens)
    || request.limit !== DESTINATION_MAX_RESULTS
  ) {
    throw new RangeError('destinations request does not match destinations/1 policy');
  }
  if (request.focus !== null && (
    !Number.isInteger(request.focus.a)
    || !Number.isInteger(request.focus.b)
    || request.focus.a < 0
    || request.focus.a >= request.focus.b
    || request.focus.b >= trackCount
  )) {
    throw new RangeError('destination focus must be a canonical in-range track pair');
  }
}

function assertScratch(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  tracks: readonly DestinationTrackInputV1[],
  scratch: DestinationsScratchV1,
): void {
  const docCount = snapshot.docs.length;
  const slots = docCount * DESTINATION_PER_DOC_KEEP;
  if (
    scratch.documentSlices.length !== tracks.length
    || !(scratch.countByDoc instanceof Uint8Array)
    || scratch.countByDoc.length !== docCount
    || !(scratch.score instanceof Float64Array)
    || scratch.score.length !== slots
    || !(scratch.present instanceof Uint8Array)
    || scratch.present.length !== slots
    || !(scratch.totalCount instanceof Uint32Array)
    || scratch.totalCount.length !== slots
    || !(scratch.tokenStart instanceof Uint32Array)
    || scratch.tokenStart.length !== slots
    || !(scratch.tokenEnd instanceof Uint32Array)
    || scratch.tokenEnd.length !== slots
    || !(scratch.anchorToken instanceof Uint32Array)
    || scratch.anchorToken.length !== slots
    || !(scratch.anchorTrack instanceof Uint8Array)
    || scratch.anchorTrack.length !== slots
    || !(scratch.trackCounts instanceof Uint32Array)
    || scratch.trackCounts.length !== slots * MAX_KWIC_TRACKS
  ) {
    throw new RangeError('destinations scratch does not match the supplied corpus');
  }
  for (let track = 0; track < tracks.length; track++) {
    assertOccurrenceDocumentSlices(
      'destinations',
      snapshot,
      selection,
      tracks[track]!.occurrences,
      scratch.documentSlices[track]!,
    );
  }
}

/** Exact floor square root for the bounded integer score domain. */
export function destinationIntegerSqrt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('integer square root requires a non-negative safe integer');
  }
  let root = Math.floor(Math.sqrt(value));
  while ((root + 1) * (root + 1) <= value) root++;
  while (root * root > value) root--;
  return root;
}

function writeScratchCandidate(
  scratch: DestinationsScratchV1,
  doc: number,
  trackCount: number,
  score: number,
  present: number,
  totalCount: number,
  tokenStart: number,
  tokenEnd: number,
  anchorToken: number,
  anchorTrack: number,
  counts: Uint32Array,
): void {
  const base = doc * SLOT_STRIDE;
  const used = scratch.countByDoc[doc]!;
  let slot: number;
  if (used < DESTINATION_PER_DOC_KEEP) {
    slot = base + used;
    scratch.countByDoc[doc] = used + 1;
  } else {
    let worst = base;
    for (let candidate = base + 1; candidate < base + DESTINATION_PER_DOC_KEEP; candidate++) {
      if (
        scratchSlotOrder(
          scratch,
          candidate,
          scratch.score[worst]!,
          scratch.present[worst]!,
          scratch.totalCount[worst]!,
          scratch.tokenStart[worst]!,
          scratch.anchorToken[worst]!,
          scratch.anchorTrack[worst]!,
        ) > 0
      ) worst = candidate;
    }
    if (
      scratchSlotOrder(
        scratch,
        worst,
        score,
        present,
        totalCount,
        tokenStart,
        anchorToken,
        anchorTrack,
      ) <= 0
    ) return;
    slot = worst;
  }
  scratch.score[slot] = score;
  scratch.present[slot] = present;
  scratch.totalCount[slot] = totalCount;
  scratch.tokenStart[slot] = tokenStart;
  scratch.tokenEnd[slot] = tokenEnd;
  scratch.anchorToken[slot] = anchorToken;
  scratch.anchorTrack[slot] = anchorTrack;
  const countBase = slot * MAX_KWIC_TRACKS;
  for (let track = 0; track < trackCount; track++) {
    scratch.trackCounts[countBase + track] = counts[track]!;
  }
}

function windowsOverlap(left: Candidate, right: Candidate): boolean {
  return left.docOrdinal === right.docOrdinal
    && left.tokenStart < right.tokenEnd
    && right.tokenStart < left.tokenEnd;
}

function mergeTrackBefore(
  left: number,
  right: number,
  nextPosition: readonly number[],
  weights: readonly number[],
): boolean {
  const leftPosition = nextPosition[left]!;
  const rightPosition = nextPosition[right]!;
  return leftPosition < rightPosition
    || (leftPosition === rightPosition && (
      weights[left]! > weights[right]!
      || (weights[left] === weights[right] && left < right)
    ));
}

/** Numeric planning only: no shard or source-text access. */
async function planDestinationsInternal(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  tracks: readonly DestinationTrackInputV1[],
  request: DestinationWindowSpikeRequestV0,
  scratch: DestinationsScratchV1,
  checkpoint: DestinationCheckpoint,
): Promise<NumericDestinationsPlanV1> {
  assertFullCorpusSelection('destinations', snapshot, selection);
  if (tracks.length < 1 || tracks.length > MAX_KWIC_TRACKS) {
    throw new RangeError(`destinations requires 1–${MAX_KWIC_TRACKS} tracks`);
  }
  assertRequest(request, tracks.length);
  assertScratch(snapshot, selection, tracks, scratch);
  scratch.countByDoc.fill(0);

  const totals = tracks.map((track) => track.occurrences.pos.length);
  const rarityMaximum = Math.max(0, ...totals);
  const weights = totals.map((total) => Math.min(
    DESTINATION_MAX_RARITY_WEIGHT,
    Math.floor((DESTINATION_SCORE_SCALE * rarityMaximum) / Math.max(total, 1)),
  ));
  const trackCount = tracks.length;
  const positions = tracks.map((track) => track.occurrences.pos);
  const cursors = Array.from({ length: trackCount }, () => 0);
  const ends = Array.from({ length: trackCount }, () => 0);
  const low = Array.from({ length: trackCount }, () => 0);
  const high = Array.from({ length: trackCount }, () => 0);
  const nextPosition = Array.from({ length: trackCount }, () => 0);
  const mergeHeap = Array.from({ length: trackCount }, () => 0);
  const counts = new Uint32Array(trackCount);
  const runCounts = new Uint32Array(trackCount);
  let examined = 0;
  const windowTokens = request.windowTokens;
  const halfWindow = Math.floor(windowTokens / 2);
  const runExtent = 4 * windowTokens;

  for (let doc = 0; doc < snapshot.docs.length; doc++) {
    const docTokens = snapshot.docs[doc]!.tokenCount;
    counts.fill(0);
    let windowPresent = 0;
    let windowTotal = 0;
    let windowWeighted = 0;
    for (let track = 0; track < trackCount; track++) {
      const slices = scratch.documentSlices[track]!;
      cursors[track] = slices[doc]!;
      ends[track] = slices[doc + 1]!;
      low[track] = slices[doc]!;
      high[track] = slices[doc]!;
      nextPosition[track] = cursors[track]! < ends[track]!
        ? positions[track]![cursors[track]!]!
        : Number.POSITIVE_INFINITY;
    }
    let mergeHeapSize = 0;
    for (let track = 0; track < trackCount; track++) {
      if (cursors[track]! >= ends[track]!) continue;
      let slot = mergeHeapSize++;
      mergeHeap[slot] = track;
      while (slot > 0) {
        const parent = Math.floor((slot - 1) / 2);
        if (mergeTrackBefore(
          mergeHeap[parent]!, mergeHeap[slot]!, nextPosition, weights,
        )) break;
        const parentTrack = mergeHeap[parent]!;
        mergeHeap[parent] = mergeHeap[slot]!;
        mergeHeap[slot] = parentTrack;
        slot = parent;
      }
    }

    let runFirstAnchor = -1;
    let previousAnchor = -1;
    let runScore = -1;
    let runPresent = 0;
    let runTotal = 0;
    let runStart = 0;
    let runEnd = 0;
    let runAnchor = 0;
    let runAnchorTrack = 0;
    const flushRun = (): void => {
      if (runScore < 0) return;
      writeScratchCandidate(
        scratch,
        doc,
        trackCount,
        runScore,
        runPresent,
        runTotal,
        runStart,
        runEnd,
        runAnchor,
        runAnchorTrack,
        runCounts,
      );
      runScore = -1;
    };

    while (mergeHeapSize > 0) {
      const anchorTrack = mergeHeap[0]!;
      const anchor = nextPosition[anchorTrack]!;

      const tokenStart = Math.min(
        Math.max(0, anchor - halfWindow),
        Math.max(0, docTokens - windowTokens),
      );
      const tokenEnd = Math.min(docTokens, tokenStart + windowTokens);
      for (let track = 0; track < trackCount; track++) {
        const trackPositions = positions[track]!;
        const end = ends[track]!;
        let lo = low[track]!;
        while (lo < end && trackPositions[lo]! < tokenStart) {
          lo++;
          examined++;
          if (examined === DESTINATION_CHECKPOINT_SPAN) {
            examined = 0;
            await checkpoint();
          }
        }
        low[track] = lo;
        let hi = Math.max(high[track]!, lo);
        while (hi < end && trackPositions[hi]! < tokenEnd) {
          hi++;
          examined++;
          if (examined === DESTINATION_CHECKPOINT_SPAN) {
            examined = 0;
            await checkpoint();
          }
        }
        high[track] = hi;
        const count = hi - lo;
        const prior = counts[track]!;
        if (count !== prior) {
          counts[track] = count;
          windowTotal += count - prior;
          if (prior === 0) windowPresent++;
          if (count === 0) windowPresent--;
          windowWeighted += weights[track]! * (
            DESTINATION_COUNT_ROOT[Math.min(count, DESTINATION_COUNT_CAP)]!
            - DESTINATION_COUNT_ROOT[Math.min(prior, DESTINATION_COUNT_CAP)]!
          );
        }
      }
      const eligible = request.focus === null
        || (counts[request.focus.a]! > 0 && counts[request.focus.b]! > 0);
      if (eligible) {
        if (
          runScore >= 0
          && (anchor - previousAnchor >= windowTokens || anchor - runFirstAnchor > runExtent)
        ) {
          flushRun();
          runFirstAnchor = -1;
        }
        if (runFirstAnchor < 0) runFirstAnchor = anchor;
        previousAnchor = anchor;
        const score = windowPresent * windowWeighted;
        const better = runScore < 0
          || score > runScore
          || (score === runScore && (
            windowPresent > runPresent
            || (windowPresent === runPresent && (
              windowTotal > runTotal
              || (windowTotal === runTotal && (
                tokenStart < runStart
                || (tokenStart === runStart && (
                  anchor < runAnchor
                  || (anchor === runAnchor && anchorTrack < runAnchorTrack)
                ))
              ))
            ))
          ));
        if (better) {
          runScore = score;
          runPresent = windowPresent;
          runTotal = windowTotal;
          runStart = tokenStart;
          runEnd = tokenEnd;
          runAnchor = anchor;
          runAnchorTrack = anchorTrack;
          runCounts.set(counts);
        }
      }

      while (
        mergeHeapSize > 0
        && nextPosition[mergeHeap[0]!] === anchor
      ) {
        const track = mergeHeap[0]!;
        const trackPositions = positions[track]!;
        let cursor = cursors[track]!;
        while (cursor < ends[track]! && trackPositions[cursor]! === anchor) {
          cursor++;
          examined++;
          if (examined === DESTINATION_CHECKPOINT_SPAN) {
            examined = 0;
            await checkpoint();
          }
        }
        cursors[track] = cursor;
        nextPosition[track] = cursor < ends[track]!
          ? trackPositions[cursor]!
          : Number.POSITIVE_INFINITY;
        if (cursor >= ends[track]!) {
          mergeHeapSize--;
          if (mergeHeapSize > 0) mergeHeap[0] = mergeHeap[mergeHeapSize]!;
        }
        let slot = 0;
        while (slot < mergeHeapSize) {
          const left = 2 * slot + 1;
          if (left >= mergeHeapSize) break;
          const right = left + 1;
          let earlier = left;
          if (
            right < mergeHeapSize
            && mergeTrackBefore(
              mergeHeap[right]!, mergeHeap[left]!, nextPosition, weights,
            )
          ) earlier = right;
          if (mergeTrackBefore(
            mergeHeap[slot]!, mergeHeap[earlier]!, nextPosition, weights,
          )) break;
          const slotTrack = mergeHeap[slot]!;
          mergeHeap[slot] = mergeHeap[earlier]!;
          mergeHeap[earlier] = slotTrack;
          slot = earlier;
        }
      }
    }
    flushRun();
    await checkpoint();
  }

  const byDoc: Candidate[][] = Array.from({ length: snapshot.docs.length }, () => []);
  for (let doc = 0; doc < snapshot.docs.length; doc++) {
    const base = doc * SLOT_STRIDE;
    for (let local = 0; local < scratch.countByDoc[doc]!; local++) {
      const slot = base + local;
      byDoc[doc]!.push({
        docOrdinal: doc,
        score: scratch.score[slot]!,
        present: scratch.present[slot]!,
        totalCount: scratch.totalCount[slot]!,
        tokenStart: scratch.tokenStart[slot]!,
        tokenEnd: scratch.tokenEnd[slot]!,
        anchorToken: scratch.anchorToken[slot]!,
        anchorTrack: scratch.anchorTrack[slot]!,
        counts: Array.from(
          scratch.trackCounts.subarray(
            slot * MAX_KWIC_TRACKS,
            slot * MAX_KWIC_TRACKS + trackCount,
          ),
        ),
      });
    }
    byDoc[doc]!.sort(candidateOrder);
  }
  const activeDocs = byDoc.filter((candidates) => candidates.length > 0).length;
  const perDocLimit = activeDocs === 0
    ? 0
    : Math.min(
        DESTINATION_PER_DOC_KEEP,
        Math.ceil(DESTINATION_MAX_RESULTS / Math.min(activeDocs, 4)),
      );
  const accepted: Candidate[] = [];
  const acceptedByDoc = new Uint8Array(snapshot.docs.length);
  for (let depth = 0; depth < DESTINATION_PER_DOC_KEEP; depth++) {
    const round: Candidate[] = [];
    for (const candidates of byDoc) {
      const candidate = candidates[depth];
      if (candidate !== undefined) round.push(candidate);
    }
    round.sort(candidateOrder);
    for (const candidate of round) {
      if (acceptedByDoc[candidate.docOrdinal]! >= perDocLimit) continue;
      if (accepted.some((prior) => windowsOverlap(prior, candidate))) continue;
      accepted.push(candidate);
      acceptedByDoc[candidate.docOrdinal] = acceptedByDoc[candidate.docOrdinal]! + 1;
      if (accepted.length === DESTINATION_MAX_RESULTS) break;
    }
    if (accepted.length === DESTINATION_MAX_RESULTS) break;
  }

  return {
    method: 'destinations/1',
    snapshot: snapshot.id,
    selection: selection.hash,
    windowTokens,
    focus: request.focus === null ? null : { ...request.focus },
    tracks: tracks.map((track, index) => ({
      seriesId: track.seriesId,
      groupId: track.groupId,
      total: totals[index]!,
      weight: weights[index]!,
    })),
    destinations: accepted.map((candidate) => ({
      docOrdinal: candidate.docOrdinal,
      tokens: { start: candidate.tokenStart, end: candidate.tokenEnd },
      anchorToken: candidate.anchorToken,
      anchorTrackOrdinal: candidate.anchorTrack,
      score: candidate.score,
      presentTracks: candidate.present,
      counts: [...candidate.counts],
    })),
  };
}

export async function planDestinations(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  tracks: readonly DestinationTrackInputV1[],
  request: DestinationsRequestV1,
  scratch: DestinationsScratchV1,
  checkpoint: DestinationCheckpoint,
): Promise<NumericDestinationsPlanV1> {
  if (request.windowTokens !== DESTINATION_WINDOW_TOKENS_V1) {
    throw new RangeError('destinations/1 requires a 400-token window');
  }
  return planDestinationsInternal(
    snapshot, selection, tracks, request, scratch, checkpoint,
  );
}

export async function planDestinationWindowSpikeV0(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  tracks: readonly DestinationTrackInputV1[],
  request: DestinationWindowSpikeRequestV0,
  scratch: DestinationsScratchV1,
  checkpoint: DestinationCheckpoint,
): Promise<NumericDestinationsPlanV1> {
  return planDestinationsInternal(
    snapshot, selection, tracks, request, scratch, checkpoint,
  );
}

function snippetTokenWindow(
  shard: ReturnType<typeof internalShardOf>,
  destination: NumericDestinationV1,
  source: string,
): readonly [number, number] {
  let start = destination.anchorToken;
  let end = destination.anchorToken + 1;
  let leftBlocked = false;
  let rightBlocked = false;
  while (end - start < DESTINATION_SNIPPET_TOKENS) {
    const leftCount = destination.anchorToken - start;
    const rightCount = end - destination.anchorToken - 1;
    const directions = leftCount <= rightCount ? ([-1, 1] as const) : ([1, -1] as const);
    let added = false;
    for (const direction of directions) {
      const nextStart = direction === -1 ? start - 1 : start;
      const nextEnd = direction === 1 ? end + 1 : end;
      if (
        (direction === -1 && (leftBlocked || nextStart < destination.tokens.start))
        || (direction === 1 && (rightBlocked || nextEnd > destination.tokens.end))
      ) continue;
      const charStart = shard.startsUtf16[nextStart]!;
      const charEnd = tokenEndChar(shard, nextEnd - 1);
      if (
        charEnd - charStart <= DESTINATION_SNIPPET_UTF16
        && utf8RangeBytes(source, charStart, charEnd, DESTINATION_SNIPPET_UTF8)
          <= DESTINATION_SNIPPET_UTF8
      ) {
        start = nextStart;
        end = nextEnd;
        added = true;
        break;
      }
      if (direction === -1) leftBlocked = true;
      else rightBlocked = true;
    }
    if (!added) break;
  }
  return [start, end];
}

function safeSnippetEnd(text: string, start: number, proposedEnd: number): number {
  let end = proposedEnd;
  if (
    end > start
    && end < text.length
    && text.charCodeAt(end - 1) >= 0xd800
    && text.charCodeAt(end - 1) <= 0xdbff
    && text.charCodeAt(end) >= 0xdc00
    && text.charCodeAt(end) <= 0xdfff
  ) end--;
  return end;
}

function utf8PrefixUnits(value: string, maxBytes: number): number {
  let units = 0;
  let bytes = 0;
  while (units < value.length) {
    const point = value.codePointAt(units)!;
    const pointUnits = point > 0xffff ? 2 : 1;
    const pointBytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + pointBytes > maxBytes) break;
    bytes += pointBytes;
    units += pointUnits;
  }
  return units;
}

function utf8RangeBytes(
  value: string,
  start: number,
  end: number,
  stopAfter: number,
): number {
  let units = start;
  let bytes = 0;
  while (units < end) {
    const point = value.codePointAt(units)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > stopAfter) return bytes;
    units += point > 0xffff ? 2 : 1;
  }
  return bytes;
}

/** Bind authenticated source text and bounded marks for numeric winners only. */
export function materializeDestinations(
  snapshot: CorpusSnapshotV1,
  plan: NumericDestinationsPlanV1,
  shards: BoundShards,
  texts: BoundTexts,
  tracks: readonly DestinationTrackInputV1[],
): DestinationsResultV1 {
  assertBoundShards(shards);
  assertBoundTexts(texts);
  if (
    plan.method !== 'destinations/1'
    || plan.snapshot !== snapshot.id
    || shards.snapshot !== snapshot.id
    || texts.snapshot !== snapshot.id
  ) {
    throw new RangeError('destination materialization inputs belong to different snapshots');
  }
  if (
    tracks.length !== plan.tracks.length
    || plan.destinations.length > DESTINATION_MAX_RESULTS
    || !DESTINATION_WINDOW_OPTIONS_V0.includes(plan.windowTokens)
    || (plan.focus !== null && (
      !Number.isInteger(plan.focus.a)
      || !Number.isInteger(plan.focus.b)
      || plan.focus.a < 0
      || plan.focus.a >= plan.focus.b
      || plan.focus.b >= tracks.length
    ))
  ) {
    throw new RangeError('destination plan does not match the supplied tracks or result cap');
  }
  const maximumTotal = Math.max(0, ...plan.tracks.map((track) => track.total));
  for (let track = 0; track < tracks.length; track++) {
    const input = tracks[track]!;
    const planned = plan.tracks[track]!;
    if (
      input.seriesId !== planned.seriesId
      || input.groupId !== planned.groupId
      || input.occurrences.snapshot !== snapshot.id
      || input.occurrences.selection !== plan.selection
      || input.occurrences.pos.length !== planned.total
      || planned.weight !== Math.min(
        DESTINATION_MAX_RARITY_WEIGHT,
        Math.floor(DESTINATION_SCORE_SCALE * maximumTotal / Math.max(planned.total, 1)),
      )
    ) {
      throw new RangeError('destination tracks do not match the numeric plan');
    }
  }

  const items = plan.destinations.map((destination): DestinationResultItemV1 => {
    const ref = snapshot.docs[destination.docOrdinal];
    const anchorTrack = tracks[destination.anchorTrackOrdinal];
    if (
      ref === undefined
      || anchorTrack === undefined
      || destination.tokens.start < 0
      || destination.tokens.start >= destination.tokens.end
      || destination.tokens.end > ref.tokenCount
      || destination.anchorToken < destination.tokens.start
      || destination.anchorToken >= destination.tokens.end
      || destination.counts.length !== tracks.length
      || destination.counts.some((count) => !Number.isSafeInteger(count) || count < 0)
      || destination.presentTracks !== destination.counts.filter((count) => count > 0).length
      || !Number.isSafeInteger(destination.score)
      || destination.score < 0
      || destination.tokens.end - destination.tokens.start
        !== Math.min(plan.windowTokens, ref.tokenCount)
      || (plan.focus !== null && (
        destination.counts[plan.focus.a] === 0
        || destination.counts[plan.focus.b] === 0
      ))
    ) {
      throw new RangeError('destination plan contains an invalid passage');
    }
    const expectedScore = destination.presentTracks * destination.counts.reduce(
      (sum, count, track) => sum + plan.tracks[track]!.weight
        * DESTINATION_COUNT_ROOT[Math.min(count, DESTINATION_COUNT_CAP)]!,
      0,
    );
    const anchorOccurrences = anchorTrack.occurrences;
    const docStart = lowerBound(anchorOccurrences.docOrdinal, destination.docOrdinal);
    const docEnd = lowerBound(anchorOccurrences.docOrdinal, destination.docOrdinal + 1);
    const anchorIndex = docStart + lowerBound(
      anchorOccurrences.pos.subarray(docStart, docEnd),
      destination.anchorToken,
    );
    if (
      destination.score !== expectedScore
      || anchorIndex >= docEnd
      || anchorOccurrences.pos[anchorIndex] !== destination.anchorToken
    ) {
      throw new RangeError('destination plan contains invalid score or anchor evidence');
    }
    const shard = internalShardOf(shards, ref.doc);
    if (shard.tokenTypeIds.length !== ref.tokenCount) {
      throw new RangeError(`shard for '${ref.doc}' does not match the snapshot token count`);
    }
    const source = internalTextOf(texts, ref.doc);
    const [snippetStart, snippetEnd] = snippetTokenWindow(shard, destination, source);
    const fullCharStart = shard.startsUtf16[snippetStart]!;
    const fullCharEnd = tokenEndChar(shard, snippetEnd - 1);
    let charEnd = safeSnippetEnd(
      source,
      fullCharStart,
      Math.min(fullCharEnd, fullCharStart + DESTINATION_SNIPPET_UTF16),
    );
    charEnd = fullCharStart + utf8PrefixUnits(
      source.slice(fullCharStart, charEnd),
      DESTINATION_SNIPPET_UTF8,
    );
    const limited = collectTokenWindowMarksLimited(
      shard,
      destination.docOrdinal,
      tracks.map((track) => track.occurrences),
      snippetStart,
      snippetEnd,
      DESTINATION_MAX_MARKS,
    );
    const marks = limited.marks.flatMap((mark): DestinationMarkV1[] => {
      const visibleStart = Math.max(mark.charStartUtf16, fullCharStart);
      const visibleEnd = Math.min(mark.charEndUtf16, charEnd);
      if (visibleStart >= visibleEnd) return [];
      return [{
        trackOrdinal: mark.trackOrdinal,
        tokens: { start: mark.tokenStart, end: mark.tokenEnd },
        charsUtf16: {
          start: visibleStart - fullCharStart,
          end: visibleEnd - fullCharStart,
        },
      }];
    });
    return {
      doc: ref.doc,
      tokens: { ...destination.tokens },
      score: destination.score,
      presentTracks: destination.presentTracks,
      counts: [...destination.counts],
      anchor: {
        seriesId: anchorTrack.seriesId,
        groupId: anchorTrack.groupId,
        token: destination.anchorToken,
      },
      snippet: {
        tokens: { start: snippetStart, end: snippetEnd },
        docCharsUtf16: { start: fullCharStart, end: charEnd },
        text: source.slice(fullCharStart, charEnd),
        marks,
        marksTruncated: limited.truncated || marks.length < limited.marks.length,
      },
    };
  });

  return {
    method: 'destinations/1',
    windowTokens: plan.windowTokens,
    focus: plan.focus === null ? null : { ...plan.focus },
    tracks: plan.tracks.map((track) => ({ ...track })),
    destinations: items,
  };
}
