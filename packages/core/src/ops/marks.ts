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

export interface LimitedTokenWindowMarks {
  readonly marks: readonly TokenWindowMark[];
  readonly truncated: boolean;
}

interface MarkHeap {
  readonly track: Uint32Array;
  readonly occurrence: Uint32Array;
  readonly tokenStart: Uint32Array;
  readonly tokenEnd: Uint32Array;
  readonly charStart: Uint32Array;
  readonly charEnd: Uint32Array;
  readonly clippedStart: Uint8Array;
  readonly clippedEnd: Uint8Array;
  size: number;
  seen: number;
}

function compareMarkSlots(heap: MarkHeap, left: number, right: number): number {
  return heap.charStart[left]! - heap.charStart[right]!
    || heap.charEnd[left]! - heap.charEnd[right]!
    || heap.track[left]! - heap.track[right]!
    || heap.tokenStart[left]! - heap.tokenStart[right]!
    || heap.occurrence[left]! - heap.occurrence[right]!;
}

function swapMarkValues(
  values: Uint32Array | Uint8Array,
  left: number,
  right: number,
): void {
  const value = values[left]!;
  values[left] = values[right]!;
  values[right] = value;
}

function swapMarkSlots(heap: MarkHeap, left: number, right: number): void {
  swapMarkValues(heap.track, left, right);
  swapMarkValues(heap.occurrence, left, right);
  swapMarkValues(heap.tokenStart, left, right);
  swapMarkValues(heap.tokenEnd, left, right);
  swapMarkValues(heap.charStart, left, right);
  swapMarkValues(heap.charEnd, left, right);
  swapMarkValues(heap.clippedStart, left, right);
  swapMarkValues(heap.clippedEnd, left, right);
}

/**
 * Collect only the first `limit` marks in the same render order as the full
 * collector. A fixed-size max heap retains numeric references while scanning,
 * so a dense/repeated window cannot allocate one object per occurrence merely
 * to discover that all but a handful will be omitted.
 */
export function collectTokenWindowMarksLimited(
  shard: DocumentIndexV1,
  docOrdinal: number,
  tracks: readonly NumericOccurrences[],
  tokenStart: number,
  tokenEnd: number,
  limit: number,
): LimitedTokenWindowMarks {
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
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError('mark limit must be a non-negative integer');
  }

  const heap: MarkHeap = {
    track: new Uint32Array(limit),
    occurrence: new Uint32Array(limit),
    tokenStart: new Uint32Array(limit),
    tokenEnd: new Uint32Array(limit),
    charStart: new Uint32Array(limit),
    charEnd: new Uint32Array(limit),
    clippedStart: new Uint8Array(limit),
    clippedEnd: new Uint8Array(limit),
    size: 0,
    seen: 0,
  };

  const offer = (trackOrdinal: number, occurrenceIndex: number): void => {
    const occurrence = tracks[trackOrdinal]!;
    const occurrenceStart = occurrence.pos[occurrenceIndex]!;
    const span = occurrence.spanTokens[occurrenceIndex]!;
    const occurrenceEnd = occurrenceStart + span;
    if (span < 1 || occurrenceEnd > tokenCount) {
      throw new RangeError(
        `track ${trackOrdinal} occurrence ${occurrenceIndex} exceeds document extent`,
      );
    }
    heap.seen++;
    if (limit === 0) return;

    const visibleStart = Math.max(occurrenceStart, tokenStart);
    const visibleEnd = Math.min(occurrenceEnd, tokenEnd);
    const charStart = shard.startsUtf16[visibleStart]!;
    const charEnd = tokenEndChar(shard, visibleEnd - 1);
    let slot = heap.size;
    if (slot === limit) {
      const candidateIsEarlier = charStart < heap.charStart[0]!
        || (charStart === heap.charStart[0]! && (
          charEnd < heap.charEnd[0]!
          || (charEnd === heap.charEnd[0]! && (
            trackOrdinal < heap.track[0]!
            || (trackOrdinal === heap.track[0]! && (
              occurrenceStart < heap.tokenStart[0]!
              || (occurrenceStart === heap.tokenStart[0]!
                && occurrenceIndex < heap.occurrence[0]!)
            ))
          ))
        ));
      if (!candidateIsEarlier) return;
      slot = 0;
    } else {
      heap.size++;
    }
    heap.track[slot] = trackOrdinal;
    heap.occurrence[slot] = occurrenceIndex;
    heap.tokenStart[slot] = occurrenceStart;
    heap.tokenEnd[slot] = occurrenceEnd;
    heap.charStart[slot] = charStart;
    heap.charEnd[slot] = charEnd;
    heap.clippedStart[slot] = occurrenceStart < tokenStart ? 1 : 0;
    heap.clippedEnd[slot] = occurrenceEnd > tokenEnd ? 1 : 0;

    // Max heap: slot zero is the latest (worst) retained render key.
    if (slot === 0 && heap.size === limit) {
      while (true) {
        const left = 2 * slot + 1;
        if (left >= heap.size) break;
        const right = left + 1;
        let worse = left;
        if (right < heap.size && compareMarkSlots(heap, right, left) > 0) worse = right;
        if (compareMarkSlots(heap, slot, worse) >= 0) break;
        swapMarkSlots(heap, slot, worse);
        slot = worse;
      }
    } else {
      while (slot > 0) {
        const parent = Math.floor((slot - 1) / 2);
        if (compareMarkSlots(heap, parent, slot) >= 0) break;
        swapMarkSlots(heap, parent, slot);
        slot = parent;
      }
    }
  };

  const maxMemberSpan = TERM_GROUP_LIMITS_V1.maxPhraseElements;
  for (let trackOrdinal = 0; trackOrdinal < tracks.length; trackOrdinal++) {
    const occurrence = tracks[trackOrdinal]!;
    const sliceStart = lowerBound(occurrence.docOrdinal, docOrdinal);
    const sliceEnd = lowerBound(occurrence.docOrdinal, docOrdinal + 1);
    if (sliceStart === sliceEnd) continue;
    const positions = occurrence.pos.subarray(sliceStart, sliceEnd);
    const firstInside = sliceStart + lowerBound(positions, tokenStart);
    const high = sliceStart + lowerBound(positions, tokenEnd);
    for (let index = firstInside - 1; index >= sliceStart; index--) {
      const position = occurrence.pos[index]!;
      if (position + occurrence.spanTokens[index]! > tokenStart) offer(trackOrdinal, index);
      else if (position + maxMemberSpan <= tokenStart) break;
    }
    for (let index = firstInside; index < high; index++) offer(trackOrdinal, index);
  }

  const order = Array.from({ length: heap.size }, (_, index) => index)
    .sort((left, right) => compareMarkSlots(heap, left, right));
  const marks = order.map((slot): TokenWindowMark => {
    const trackOrdinal = heap.track[slot]!;
    const occurrenceIndex = heap.occurrence[slot]!;
    const occurrence = tracks[trackOrdinal]!;
    return {
      trackOrdinal,
      tokenStart: heap.tokenStart[slot]!,
      tokenEnd: heap.tokenEnd[slot]!,
      charStartUtf16: heap.charStart[slot]!,
      charEndUtf16: heap.charEnd[slot]!,
      clippedStart: heap.clippedStart[slot] === 1,
      clippedEnd: heap.clippedEnd[slot] === 1,
      members: Array.from(occurrence.memberOrdinals.subarray(
        occurrence.memberOffsets[occurrenceIndex]!,
        occurrence.memberOffsets[occurrenceIndex + 1]!,
      )),
    };
  });
  return { marks, truncated: heap.seen > limit };
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
