/**
 * The linked token-range selection (slice-2 commit E, recorded ruling §2).
 *
 * ONE transient, store-owned selection: single-document, half-open,
 * nonempty, snapshot-bound. It is NOT the durable char-anchored `Brush`
 * from the analysis contract — token coordinates from an old snapshot are
 * never durable authority, so this object is deliberately unserialized and
 * cleared on snapshot replacement. "Save selection as brush" belongs to the
 * persistence/share slice, where a worker conversion anchors chars +
 * TextHash.
 */

import type { WireSelectionV4 } from '../shared/analysis-contract.ts';

export interface TokenRangeSelectionV1 {
  /** The snapshot this range was authored against — a different published
   *  snapshot invalidates it (documents can re-tokenize). */
  readonly snapshot: string;
  readonly doc: string;
  /** Half-open [start, end), end > start. */
  readonly tokens: { readonly start: number; readonly end: number };
}

/** Validate shape + snapshot binding; the store refuses anything else. */
export function isValidSelection(
  sel: TokenRangeSelectionV1,
  liveSnapshot: string | null,
  readyDocs: readonly string[],
): boolean {
  return sel.snapshot === liveSnapshot
    && readyDocs.includes(sel.doc)
    && Number.isSafeInteger(sel.tokens.start) && Number.isSafeInteger(sel.tokens.end)
    && sel.tokens.start >= 0 && sel.tokens.end > sel.tokens.start;
}

/**
 * The ONE wire-selection builder every analytical-detail consumer uses
 * (KWIC now; selected trends/dispersion this slice; slice-3 inventory and
 * statistics later — the ruling forbids a second selection state).
 *
 * THE `[doc]` IS LOAD-BEARING: `ranges` scopes only the documents it names —
 * an absent per-doc range means "whole document". Sending every ready doc
 * plus one range would mean "that range in this doc AND every other document
 * in full" (the ruling's round-1 named trap; pinned by a unit test).
 */
export function detailSelection(
  readyDocs: readonly string[],
  selection: TokenRangeSelectionV1 | null,
): WireSelectionV4 {
  if (selection === null) return { docs: [...readyDocs] };
  return {
    docs: [selection.doc],
    ranges: [{ doc: selection.doc, tokens: { start: selection.tokens.start, end: selection.tokens.end } }],
  };
}

/** Clamp a pointer/keyboard endpoint pair into a committed half-open range
 *  within one document (inclusive endpoint tokens → half-open; a crossing
 *  into another book never creates a multi-document range — the caller
 *  clamps the endpoint to the ORIGIN document before calling). */
export function commitRange(
  snapshot: string,
  doc: string,
  anchorToken: number,
  headToken: number,
  docTokenCount: number,
): TokenRangeSelectionV1 | null {
  if (docTokenCount <= 0) return null;
  const clamp = (t: number) => Math.max(0, Math.min(docTokenCount - 1, Math.floor(t)));
  const a = clamp(anchorToken);
  const h = clamp(headToken);
  const start = Math.min(a, h);
  const end = Math.max(a, h) + 1; // inclusive endpoints → half-open
  return { snapshot, doc, tokens: { start, end } };
}
