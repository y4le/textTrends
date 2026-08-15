/**
 * Shared projection of admitted occurrence tracks into one document-local
 * token window. Consumers own their presentation caps and materialization;
 * this module owns the subtle occurrence-order and straddler semantics.
 */

import type { DocumentIndexV1 } from '../index/build.ts';
import { lowerBound, tokenEndChar } from '../index/build.ts';
import {
  TERM_GROUP_LIMITS_V1,
  type NumericOccurrences,
} from './occurrences.ts';

export interface TokenWindowMark {
  readonly trackOrdinal: number;
  /** Full, unclipped document-local occurrence span. */
  readonly tokenStart: number;
  readonly tokenEnd: number;
  /** Absolute document-local UTF-16 span, clipped to the requested window. */
  readonly charStartUtf16: number;
  readonly charEndUtf16: number;
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
  readonly members: readonly number[];
}

/**
 * Collect every occurrence intersecting [tokenStart, tokenEnd) in one
 * document. Output records and member arrays are fresh: callers may retain or
 * transfer their own derived payload without touching shared occurrence data.
 */
export function collectTokenWindowMarks(
  shard: DocumentIndexV1,
  docOrdinal: number,
  tracks: readonly NumericOccurrences[],
  tokenStart: number,
  tokenEnd: number,
): TokenWindowMark[] {
  const tokenCount = shard.tokenTypeIds.length;
  if (
    !Number.isInteger(docOrdinal)
    || docOrdinal < 0
    || !Number.isInteger(tokenStart)
    || !Number.isInteger(tokenEnd)
    || tokenStart < 0
    || tokenStart >= tokenEnd
    || tokenEnd > tokenCount
  ) {
    throw new RangeError('mark window is outside the document token extent');
  }

  // Completeness of the backward walk:
  // - countOverlaps=false tracks contain disjoint ascending spans, so after
  //   one span ends before the window, every earlier span does too;
  // - countOverlaps=true members span at most maxPhraseElements, so an
  //   occurrence starting that far before the window cannot intersect it.
  const maxMemberSpan = TERM_GROUP_LIMITS_V1.maxPhraseElements;
  const collected: TokenWindowMark[] = [];
  const pushMark = (
    occurrence: NumericOccurrences,
    trackOrdinal: number,
    index: number,
    into: TokenWindowMark[],
  ) => {
    const occurrenceStart = occurrence.pos[index] as number;
    const span = occurrence.spanTokens[index] as number;
    const occurrenceEnd = occurrenceStart + span;
    if (span < 1 || occurrenceEnd > tokenCount) {
      throw new RangeError(
        `track ${trackOrdinal} occurrence ${index} exceeds document extent`,
      );
    }
    const visibleStart = Math.max(occurrenceStart, tokenStart);
    const visibleEnd = Math.min(occurrenceEnd, tokenEnd);
    into.push({
      trackOrdinal,
      tokenStart: occurrenceStart,
      tokenEnd: occurrenceEnd,
      charStartUtf16: shard.startsUtf16[visibleStart] as number,
      charEndUtf16: tokenEndChar(shard, visibleEnd - 1),
      clippedStart: occurrenceStart < tokenStart,
      clippedEnd: occurrenceEnd > tokenEnd,
      members: Array.from(
        occurrence.memberOrdinals.subarray(
          occurrence.memberOffsets[index] as number,
          occurrence.memberOffsets[index + 1] as number,
        ),
      ),
    });
  };

  for (let trackOrdinal = 0; trackOrdinal < tracks.length; trackOrdinal++) {
    const occurrence = tracks[trackOrdinal] as NumericOccurrences;
    // Occurrences are ordered by (docOrdinal, pos), so position searches must
    // be restricted to this document's slice.
    const sliceStart = lowerBound(occurrence.docOrdinal, docOrdinal);
    const sliceEnd = lowerBound(occurrence.docOrdinal, docOrdinal + 1);
    if (sliceStart === sliceEnd) continue;
    const positions = occurrence.pos.subarray(sliceStart, sliceEnd);
    const firstInside = sliceStart + lowerBound(positions, tokenStart);
    const high = sliceStart + lowerBound(positions, tokenEnd);

    const straddlers: TokenWindowMark[] = [];
    for (let index = firstInside - 1; index >= sliceStart; index--) {
      const position = occurrence.pos[index] as number;
      if (position + (occurrence.spanTokens[index] as number) > tokenStart) {
        pushMark(occurrence, trackOrdinal, index, straddlers);
      } else if (position + maxMemberSpan <= tokenStart) {
        break;
      }
    }
    straddlers.reverse();
    collected.push(...straddlers);
    for (let index = firstInside; index < high; index++) {
      pushMark(occurrence, trackOrdinal, index, collected);
    }
  }

  collected.sort(
    (left, right) =>
      left.charStartUtf16 - right.charStartUtf16
      || left.charEndUtf16 - right.charEndUtf16
      || left.trackOrdinal - right.trackOrdinal
      || left.tokenStart - right.tokenStart,
  );
  return collected;
}
