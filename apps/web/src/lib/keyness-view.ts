/** Pure comparison selection and document-frequency policy. */
import type { KeynessViewV1, KeynessScope } from './app-state.ts';
import type { WireSelectionV4 } from '../shared/analysis-contract.ts';
import { detailSelection, selectionComplement, type TokenRangeSelectionV1 } from './selection.ts';
import { DEFAULT_KEYNESS_VIEW } from './app-defaults.ts';

/**
 * A linked passage is an active, deliberately non-durable comparison. Keep
 * the authored text comparison intact so it resumes when the passage clears.
 */
export function effectiveKeynessView(
  view: KeynessViewV1,
  selection: TokenRangeSelectionV1 | null,
): KeynessViewV1 {
  return selection === null || view.mode === 'selection-rest'
    ? view
    : { ...view, mode: 'selection-rest' };
}

export function reconcileKeynessView(
  view: KeynessViewV1,
  readyDocs: readonly string[],
): KeynessViewV1 {
  const documentA = view.documentA !== null && readyDocs.includes(view.documentA)
    ? view.documentA
    : readyDocs[0] ?? null;
  const documentB = view.documentB !== null
    && readyDocs.includes(view.documentB)
    && view.documentB !== documentA
    ? view.documentB
    : readyDocs.find((doc) => doc !== documentA) ?? null;
  const mode = readyDocs.length === 1
    ? 'selection-rest'
    : readyDocs.length >= 2
      && view.mode === 'selection-rest'
      && view.documentB === null
      ? DEFAULT_KEYNESS_VIEW.mode
      : view.mode;
  if (
    mode === view.mode
    && documentA === view.documentA
    && documentB === view.documentB
  ) return view;
  return { ...view, mode, documentA, documentB };
}

export function keynessSelections(
  scope: KeynessScope,
): { readonly a: WireSelectionV4; readonly b: WireSelectionV4 } | null {
  const { view, readyDocs, selection, tokenCountOf } = scope;
  if (view.mode === 'selection-rest') {
    if (selection === null) return null;
    const outside = selectionComplement(selection, readyDocs, tokenCountOf);
    return outside === null
      ? null
      : {
          a: detailSelection(readyDocs, selection),
          b: outside,
        };
  }
  if (
    view.documentA === null ||
    view.documentB === null ||
    !readyDocs.includes(view.documentA) ||
    !readyDocs.includes(view.documentB) ||
    view.documentA === view.documentB
  ) {
    return null;
  }
  if (view.mode === 'documents') {
    return {
      a: { docs: [view.documentA] },
      b: { docs: [view.documentB] },
    };
  }
  if (view.restOn === 'b') {
    const rest = readyDocs.filter((doc) => doc !== view.documentA);
    return rest.length === 0
      ? null
      : { a: { docs: [view.documentA] }, b: { docs: rest } };
  }
  const rest = readyDocs.filter((doc) => doc !== view.documentB);
  return rest.length === 0
    ? null
    : { a: { docs: rest }, b: { docs: [view.documentB] } };
}

/** In a range comparison, keep terms that occur on only one side reachable:
 * their combined range cannot exceed that side's number of document parts.
 * Other comparison modes preserve the authored document-range filter. */
export function effectiveKeynessMinDocFreq(
  view: KeynessViewV1,
  pair: { readonly a: WireSelectionV4; readonly b: WireSelectionV4 },
): number {
  return effectiveKeynessMinDocFreqForParts(
    view,
    pair.a.docs.length,
    pair.b.docs.length,
  );
}

export function effectiveKeynessMinDocFreqForParts(
  view: KeynessViewV1,
  partsA: number,
  partsB: number,
): number {
  if (view.mode !== 'selection-rest') return view.minDocFreqTotal;
  const smallerSideParts = Math.min(partsA, partsB);
  return Math.min(view.minDocFreqTotal, Math.max(1, smallerSideParts));
}
