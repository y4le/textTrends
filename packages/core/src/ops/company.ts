/**
 * company/1 — exact, bounded proximity evidence among tracked term groups.
 *
 * The event space is one occurrence. For every unordered track pair, two
 * directional sweeps place each occurrence into the nearest peer's span-gap
 * bucket. No pair counts, modeled expectation, association score, document
 * structure, or corpus-wide merged event list is involved.
 *
 * Input occurrence vectors inherit the occurrence-cache invariant: rows are
 * ordered by `(docOrdinal, pos)`. Validating that invariant here would add a
 * redundant O(M) pass before the O((k - 1)M) pair sweeps.
 */

import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { ResolvedSelection } from '../snapshot/selection.ts';
import { MAX_KWIC_TRACKS } from './kwic.ts';
import {
  trackDocumentSlices,
  type NumericOccurrences,
} from './occurrences.ts';
import {
  assertFullCorpusSelection,
  assertOccurrenceDocumentSlices,
} from './overview.ts';

export const COMPANY_GAP_EDGES_V1 = [
  0, 1, 2, 3, 4, 5, 7, 10, 15, 25, 50, 100, 200,
] as const;
// Bucket zero contains both proper span overlap and zero-token touching. The
// separate overlap counters preserve that distinction for presentation.
const COMPANY_GAP_BUCKET_BY_VALUE = (() => {
  const lastEdge = COMPANY_GAP_EDGES_V1[COMPANY_GAP_EDGES_V1.length - 1]!;
  const table = new Uint8Array(lastEdge + 1);
  let bucket = 0;
  for (let gap = 0; gap <= lastEdge; gap++) {
    while (
      bucket + 1 < COMPANY_GAP_EDGES_V1.length
      && COMPANY_GAP_EDGES_V1[bucket + 1]! <= gap
    ) bucket++;
    table[gap] = bucket;
  }
  return table;
})();
export const COMPANY_CHECKPOINT_SPAN = 65_536;

export type CompanyCheckpoint = () => Promise<void>;

export interface CompanyRequestV1 {
  readonly method: 'company/1';
  readonly gapEdges: readonly number[];
}

export interface CompanyTrackInputV1 {
  readonly seriesId: string;
  readonly groupId: string;
  readonly occurrences: NumericOccurrences;
}

export interface CompanyScratchV1 {
  /** One fresh doc-offset vector per input track. */
  readonly documentSlices: readonly Uint32Array[];
}

export interface CompanyPairV1 {
  readonly a: number;
  readonly b: number;
  readonly fromA: readonly number[];
  readonly fromB: readonly number[];
  readonly noneA: number;
  readonly noneB: number;
  readonly forwardA: number;
  readonly backwardA: number;
  readonly tiedA: number;
  readonly overlapA: number;
  readonly forwardB: number;
  readonly backwardB: number;
  readonly tiedB: number;
  readonly overlapB: number;
  readonly docsWithBoth: number;
}

export interface CompanyResultV1 {
  readonly method: 'company/1';
  readonly gapEdges: readonly number[];
  readonly tracks: readonly {
    readonly seriesId: string;
    readonly groupId: string;
    readonly total: number;
    readonly docCount: number;
  }[];
  readonly corpusTokens: number;
  readonly pairs: readonly CompanyPairV1[];
}

interface DirectionResult {
  readonly histogram: number[];
  none: number;
  forward: number;
  backward: number;
  tied: number;
  overlap: number;
}

function assertRequest(request: CompanyRequestV1): void {
  if (
    request.method !== 'company/1'
    || request.gapEdges.length !== COMPANY_GAP_EDGES_V1.length
    || request.gapEdges.some((edge, index) => edge !== COMPANY_GAP_EDGES_V1[index])
  ) {
    throw new RangeError('company request does not match company/1 policy');
  }
}

function bucketFor(gap: number): number {
  return gap < COMPANY_GAP_BUCKET_BY_VALUE.length
    ? COMPANY_GAP_BUCKET_BY_VALUE[gap]!
    : COMPANY_GAP_EDGES_V1.length - 1;
}

export function createCompanyScratch(
  tracks: readonly CompanyTrackInputV1[],
  docCount: number,
): CompanyScratchV1 {
  return {
    documentSlices: tracks.map((track) => trackDocumentSlices(track.occurrences, docCount)),
  };
}

async function scanDirection(
  source: NumericOccurrences,
  peer: NumericOccurrences,
  sourceSlices: Uint32Array,
  peerSlices: Uint32Array,
  checkpoint: CompanyCheckpoint,
  examined: { value: number },
): Promise<DirectionResult> {
  const result: DirectionResult = {
    histogram: Array.from({ length: COMPANY_GAP_EDGES_V1.length }, () => 0),
    none: 0,
    forward: 0,
    backward: 0,
    tied: 0,
    overlap: 0,
  };
  const docCount = sourceSlices.length - 1;
  const sourcePos = source.pos;
  const sourceSpan = source.spanTokens;
  const peerPos = peer.pos;
  const peerSpan = peer.spanTokens;

  for (let doc = 0; doc < docCount; doc++) {
    const sourceStart = sourceSlices[doc]!;
    const sourceEnd = sourceSlices[doc + 1]!;
    const peerStart = peerSlices[doc]!;
    const peerEnd = peerSlices[doc + 1]!;
    if (peerStart === peerEnd) {
      result.none += sourceEnd - sourceStart;
      examined.value += sourceEnd - sourceStart;
      while (examined.value >= COMPANY_CHECKPOINT_SPAN) {
        examined.value -= COMPANY_CHECKPOINT_SPAN;
        await checkpoint();
      }
      continue;
    }

    let cursor = peerStart;
    let maxPriorEnd = -1;
    for (let sourceIndex = sourceStart; sourceIndex < sourceEnd; sourceIndex++) {
      const start = sourcePos[sourceIndex]!;
      const end = start + sourceSpan[sourceIndex]!;
      while (cursor < peerEnd && peerPos[cursor]! < start) {
        maxPriorEnd = Math.max(maxPriorEnd, peerPos[cursor]! + peerSpan[cursor]!);
        cursor++;
      }

      const leftOverlaps = maxPriorEnd > start;
      const rightOverlaps = cursor < peerEnd && peerPos[cursor]! < end;
      if (leftOverlaps || rightOverlaps) {
        result.histogram[0] = result.histogram[0]! + 1;
        result.overlap++;
      } else {
        const leftGap = maxPriorEnd < 0 ? Number.POSITIVE_INFINITY : start - maxPriorEnd;
        const rightGap = cursor >= peerEnd ? Number.POSITIVE_INFINITY : peerPos[cursor]! - end;
        const gap = Math.min(leftGap, rightGap);
        const bucket = bucketFor(gap);
        result.histogram[bucket] = result.histogram[bucket]! + 1;
        if (leftGap === rightGap) result.tied++;
        else if (rightGap < leftGap) result.forward++;
        else result.backward++;
      }

      examined.value++;
      if (examined.value >= COMPANY_CHECKPOINT_SPAN) {
        examined.value -= COMPANY_CHECKPOINT_SPAN;
        await checkpoint();
      }
    }
  }
  return result;
}

/**
 * Compute all canonical unordered pairs. `scratch` is caller-owned and small;
 * the hot sweeps allocate nothing per occurrence. All emitted arrays are fresh
 * plain values and therefore cannot alias or detach cached occurrence buffers.
 */
export async function company(
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  tracks: readonly CompanyTrackInputV1[],
  request: CompanyRequestV1,
  scratch: CompanyScratchV1,
  checkpoint: CompanyCheckpoint,
): Promise<CompanyResultV1> {
  assertFullCorpusSelection('company', snapshot, selection);
  assertRequest(request);
  if (tracks.length < 2 || tracks.length > MAX_KWIC_TRACKS) {
    throw new RangeError(`company requires 2–${MAX_KWIC_TRACKS} tracks`);
  }
  if (scratch.documentSlices.length !== tracks.length) {
    throw new RangeError('company scratch must contain one document index per track');
  }
  const docCount = snapshot.docs.length;
  for (let track = 0; track < tracks.length; track++) {
    const occurrences = tracks[track]!.occurrences;
    const slices = scratch.documentSlices[track]!;
    assertOccurrenceDocumentSlices('company', snapshot, selection, occurrences, slices);
  }

  const pairs: CompanyPairV1[] = [];
  const examined = { value: 0 };
  for (let a = 0; a < tracks.length; a++) {
    for (let b = a + 1; b < tracks.length; b++) {
      const trackA = tracks[a]!;
      const trackB = tracks[b]!;
      const slicesA = scratch.documentSlices[a]!;
      const slicesB = scratch.documentSlices[b]!;
      let docsWithBoth = 0;
      for (let doc = 0; doc < docCount; doc++) {
        if (slicesA[doc] !== slicesA[doc + 1] && slicesB[doc] !== slicesB[doc + 1]) {
          docsWithBoth++;
        }
      }
      const fromA = await scanDirection(
        trackA.occurrences, trackB.occurrences, slicesA, slicesB, checkpoint, examined,
      );
      const fromB = await scanDirection(
        trackB.occurrences, trackA.occurrences, slicesB, slicesA, checkpoint, examined,
      );
      pairs.push({
        a,
        b,
        fromA: fromA.histogram,
        fromB: fromB.histogram,
        noneA: fromA.none,
        noneB: fromB.none,
        forwardA: fromA.forward,
        backwardA: fromA.backward,
        tiedA: fromA.tied,
        overlapA: fromA.overlap,
        forwardB: fromB.forward,
        backwardB: fromB.backward,
        tiedB: fromB.tied,
        overlapB: fromB.overlap,
        docsWithBoth,
      });
      await checkpoint();
    }
  }

  return {
    method: 'company/1',
    gapEdges: [...COMPANY_GAP_EDGES_V1],
    tracks: tracks.map((track, index) => {
      const slices = scratch.documentSlices[index]!;
      let count = 0;
      for (let doc = 0; doc < docCount; doc++) {
        if (slices[doc] !== slices[doc + 1]) count++;
      }
      return {
        seriesId: track.seriesId,
        groupId: track.groupId,
        total: track.occurrences.pos.length,
        docCount: count,
      };
    }),
    corpusTokens: snapshot.docs.reduce((sum, doc) => sum + doc.tokenCount, 0),
    pairs,
  };
}
