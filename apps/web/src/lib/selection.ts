/**
 * One transient, snapshot-bound linked selection. A selection is a contiguous
 * reading-order gesture projected into one non-empty half-open token range per
 * participating document. Keeping every document range explicit avoids the
 * wire contract's "missing range means the whole document" ambiguity.
 *
 * This is not the durable char-anchored selection from research state. Token
 * coordinates are cleared when a new snapshot is published because documents
 * may have re-tokenized.
 */

import type { WireSelectionV4 } from '../shared/analysis-contract.ts';

export interface TokenRangeSelectionSpanV1 {
  readonly doc: string;
  /** Half-open [start, end), end > start. */
  readonly tokens: { readonly start: number; readonly end: number };
}

export interface TokenRangeSelectionV1 {
  readonly snapshot: string;
  /** Declared-document order; one explicit, non-empty range per document. */
  readonly ranges: readonly TokenRangeSelectionSpanV1[];
}

export interface SelectionPoint {
  readonly doc: string;
  /** Inclusive document-local token position. */
  readonly token: number;
}

/** Validate shape, snapshot binding, ready-document membership, and order. */
export function isValidSelection(
  selection: TokenRangeSelectionV1,
  liveSnapshot: string | null,
  readyDocs: readonly string[],
): boolean {
  if (selection.snapshot !== liveSnapshot || selection.ranges.length === 0) return false;
  let previousOrdinal = -1;
  for (const range of selection.ranges) {
    const ordinal = readyDocs.indexOf(range.doc);
    if (
      ordinal <= previousOrdinal
      || !Number.isSafeInteger(range.tokens.start)
      || !Number.isSafeInteger(range.tokens.end)
      || range.tokens.start < 0
      || range.tokens.end <= range.tokens.start
    ) return false;
    previousOrdinal = ordinal;
  }
  return true;
}

/** The one wire-selection builder used by every analytical-detail consumer. */
export function detailSelection(
  readyDocs: readonly string[],
  selection: TokenRangeSelectionV1 | null,
): WireSelectionV4 {
  if (selection === null) return { docs: [...readyDocs] };
  const byDoc = new Map(selection.ranges.map((range) => [range.doc, range]));
  const ranges = readyDocs.flatMap((doc) => {
    const range = byDoc.get(doc);
    return range ? [{ doc, tokens: { ...range.tokens } }] : [];
  });
  if (ranges.length !== selection.ranges.length) {
    throw new RangeError('linked selection references a document outside the ready snapshot');
  }
  return {
    docs: ranges.map((range) => range.doc),
    ranges,
  };
}

/** Build the exact corpus complement of one linked range. Untouched documents
 * stay whole (and therefore carry no range records); a selected document can
 * contribute both a prefix and a suffix because the wire selection supports
 * multiple disjoint ranges per document. Null means the input is malformed or
 * stale, its token geometry is unavailable, or the range covers the corpus. */
export function selectionComplement(
  selection: TokenRangeSelectionV1,
  readyDocs: readonly string[],
  tokenCountOf: (doc: string) => number | undefined,
): WireSelectionV4 | null {
  if (selection.ranges.length === 0) return null;
  const selectedByDoc = new Map<string, TokenRangeSelectionSpanV1>();
  for (const range of selection.ranges) {
    if (selectedByDoc.has(range.doc) || !readyDocs.includes(range.doc)) return null;
    selectedByDoc.set(range.doc, range);
  }

  const docs: string[] = [];
  const ranges: NonNullable<WireSelectionV4['ranges']>[number][] = [];
  for (const doc of readyDocs) {
    const selected = selectedByDoc.get(doc);
    if (selected === undefined) {
      docs.push(doc);
      continue;
    }
    const tokenCount = tokenCountOf(doc);
    if (
      tokenCount === undefined
      || !Number.isSafeInteger(tokenCount)
      || tokenCount < 0
      || !Number.isSafeInteger(selected.tokens.start)
      || !Number.isSafeInteger(selected.tokens.end)
      || selected.tokens.start < 0
      || selected.tokens.end <= selected.tokens.start
      || selected.tokens.end > tokenCount
    ) return null;

    const outside: NonNullable<WireSelectionV4['ranges']>[number][] = [];
    if (selected.tokens.start > 0) {
      outside.push({
        doc,
        tokens: { start: 0, end: selected.tokens.start },
      });
    }
    if (selected.tokens.end < tokenCount) {
      outside.push({
        doc,
        tokens: { start: selected.tokens.end, end: tokenCount },
      });
    }
    if (outside.length > 0) {
      docs.push(doc);
      ranges.push(...outside);
    }
  }
  return docs.length === 0
    ? null
    : ranges.length === 0
      ? { docs }
      : { docs, ranges };
}

export function selectionRangeForDoc(
  selection: TokenRangeSelectionV1 | null,
  doc: string,
): TokenRangeSelectionSpanV1 | null {
  return selection?.ranges.find((range) => range.doc === doc) ?? null;
}

export function selectionContains(
  selection: TokenRangeSelectionV1 | null,
  doc: string,
  token: number,
): boolean {
  const range = selectionRangeForDoc(selection, doc);
  return range !== null && token >= range.tokens.start && token < range.tokens.end;
}

export function selectionTokenCount(selection: TokenRangeSelectionV1): number {
  return selection.ranges.reduce(
    (total, range) => total + range.tokens.end - range.tokens.start,
    0,
  );
}

export function sameSelection(
  left: TokenRangeSelectionV1 | null,
  right: TokenRangeSelectionV1 | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.snapshot === right.snapshot
    && left.ranges.length === right.ranges.length
    && left.ranges.every((range, index) => {
      const other = right.ranges[index];
      return other !== undefined
        && range.doc === other.doc
        && range.tokens.start === other.tokens.start
        && range.tokens.end === other.tokens.end;
    });
}

/**
 * Clamp two inclusive endpoints, order them by the declared document
 * sequence, and expand the contiguous gesture into explicit per-book spans.
 * Intermediate non-empty books are selected in full.
 */
export function commitRange(
  snapshot: string,
  anchor: SelectionPoint,
  head: SelectionPoint,
  docs: readonly string[],
  docTokenCounts: readonly number[],
): TokenRangeSelectionV1 | null {
  const anchorOrdinal = docs.indexOf(anchor.doc);
  const headOrdinal = docs.indexOf(head.doc);
  if (anchorOrdinal < 0 || headOrdinal < 0) return null;
  const anchorCount = docTokenCounts[anchorOrdinal] ?? 0;
  const headCount = docTokenCounts[headOrdinal] ?? 0;
  if (anchorCount <= 0 || headCount <= 0) return null;
  const clamp = (token: number, count: number) =>
    Math.max(0, Math.min(count - 1, Math.floor(token)));
  const a = { doc: anchor.doc, token: clamp(anchor.token, anchorCount), ordinal: anchorOrdinal };
  const h = { doc: head.doc, token: clamp(head.token, headCount), ordinal: headOrdinal };
  const [first, last] = a.ordinal < h.ordinal || (a.ordinal === h.ordinal && a.token <= h.token)
    ? [a, h]
    : [h, a];
  const ranges: TokenRangeSelectionSpanV1[] = [];
  for (let ordinal = first.ordinal; ordinal <= last.ordinal; ordinal++) {
    const doc = docs[ordinal];
    const count = docTokenCounts[ordinal] ?? 0;
    if (doc === undefined || count <= 0) continue;
    const start = ordinal === first.ordinal ? first.token : 0;
    const end = ordinal === last.ordinal ? last.token + 1 : count;
    if (end > start) ranges.push({ doc, tokens: { start, end } });
  }
  return ranges.length > 0 ? { snapshot, ranges } : null;
}
