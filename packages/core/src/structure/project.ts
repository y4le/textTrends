/**
 * Section char ranges → token ranges — contract §12.7. TOKEN-START
 * ownership: a token belongs to a section iff its start offset lies in the
 * section's half-open char range, so adjacent siblings get DISJOINT token
 * ranges even when a boundary lands inside a token. Any-overlap assignment
 * is forbidden and never used here.
 *
 * This is the derived SectionTokenView, computed lazily and memoized by the
 * worker (not persisted in v1); the projection itself is pure.
 */

import type { StructureSectionRecordV2 } from './sections.ts';

export interface TokenRange {
  readonly start: number; // token index, inclusive
  readonly end: number;   // token index, exclusive
}

/** First index i in [0, n) with starts[i] >= value (lower bound). */
export function lowerBound(starts: Uint32Array, value: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function charRangeToTokenRange(
  startsUtf16: Uint32Array,
  chars: { readonly start: number; readonly end: number },
): TokenRange {
  return {
    start: lowerBound(startsUtf16, chars.start),
    end: lowerBound(startsUtf16, chars.end),
  };
}

/**
 * Project a whole validated section table (canonical order) to token ranges
 * parallel to the input. `startsUtf16` is the shard's token start offsets.
 */
export function projectSections(
  sections: readonly StructureSectionRecordV2[],
  startsUtf16: Uint32Array,
): readonly TokenRange[] {
  return sections.map((s) => charRangeToTokenRange(startsUtf16, s.chars));
}
