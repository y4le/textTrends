/** Shared coordinate validation for full-corpus overview analyses. */

import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { ResolvedSelection } from '../snapshot/selection.ts';
import type { NumericOccurrences } from './occurrences.ts';

export function assertFullCorpusSelection(
  operation: string,
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
    throw new RangeError(`${operation} requires the full corpus selection`);
  }
}

/** Validate a caller-owned CSR document index against one cached vector. */
export function assertOccurrenceDocumentSlices(
  operation: string,
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  occurrences: NumericOccurrences,
  slices: Uint32Array,
): void {
  if (occurrences.snapshot !== snapshot.id || occurrences.selection !== selection.hash) {
    throw new RangeError(`${operation} occurrences were computed under different coordinates`);
  }
  const docCount = snapshot.docs.length;
  if (
    !(slices instanceof Uint32Array)
    || slices.length !== docCount + 1
    || slices[0] !== 0
    || slices[docCount] !== occurrences.pos.length
  ) {
    throw new RangeError(`${operation} scratch does not index the supplied occurrences`);
  }
  for (let doc = 0; doc < docCount; doc++) {
    const start = slices[doc]!;
    const end = slices[doc + 1]!;
    if (
      start > end
      || end > occurrences.pos.length
      || (start < end && (
        occurrences.docOrdinal[start] !== doc
        || occurrences.docOrdinal[end - 1] !== doc
      ))
      || (start > 0 && occurrences.docOrdinal[start - 1]! >= doc)
      || (end < occurrences.pos.length && occurrences.docOrdinal[end]! <= doc)
    ) {
      throw new RangeError(`${operation} scratch contains invalid document boundaries`);
    }
  }
}
