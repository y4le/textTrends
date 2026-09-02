/**
 * Pure declared-order policy used by Reader paging. The document ruler and
 * Atlas will consume this same authority. A partially restored session may
 * briefly expose ready documents that are absent from project metadata; those
 * remain reachable after every declared ready document without letting arrival
 * order override declarations.
 */

export interface ReaderBoundaryTarget {
  readonly doc: string;
  readonly cursor:
    | { readonly kind: 'from'; readonly token: 0 }
    | { readonly kind: 'before'; readonly token: number };
}

export interface ReaderRelativeTarget {
  readonly doc: string;
  readonly token: number;
}

export function readyReaderDocumentOrder(
  declaredOrder: readonly string[] | undefined,
  readyDocs: readonly string[],
): readonly string[] {
  const ready = new Set(readyDocs);
  const order: string[] = [];
  const seen = new Set<string>();
  const appendReady = (doc: string) => {
    if (ready.has(doc) && !seen.has(doc)) {
      seen.add(doc);
      order.push(doc);
    }
  };
  for (const doc of declaredOrder ?? []) appendReady(doc);
  for (const doc of readyDocs) appendReady(doc);
  return order;
}

export function adjacentReadableDocument(
  order: readonly string[],
  doc: string,
  direction: 1 | -1,
  tokenCountOf: (candidate: string) => number | undefined,
): ReaderBoundaryTarget | null {
  const current = order.indexOf(doc);
  if (current < 0) return null;
  for (
    let index = current + direction;
    index >= 0 && index < order.length;
    index += direction
  ) {
    const candidate = order[index]!;
    const tokenCount = tokenCountOf(candidate);
    if (tokenCount === undefined || tokenCount <= 0) continue;
    return {
      doc: candidate,
      cursor: direction === 1
        ? { kind: 'from', token: 0 }
        : { kind: 'before', token: tokenCount },
    };
  }
  return null;
}

/** Preserve within-text progress when moving to a differently sized text.
 * The endpoint-aware denominator makes first and last tokens map exactly. */
export function readerRelativeToken(
  token: number,
  currentTokenCount: number,
  targetTokenCount: number,
): number | null {
  if (
    !Number.isSafeInteger(token)
    || !Number.isSafeInteger(currentTokenCount)
    || !Number.isSafeInteger(targetTokenCount)
    || currentTokenCount < 1
    || targetTokenCount < 1
  ) return null;
  const current = Math.max(0, Math.min(currentTokenCount - 1, token));
  return Math.round(
    (current / Math.max(1, currentTokenCount - 1))
    * Math.max(0, targetTokenCount - 1),
  );
}

/** Dedicated previous/next-text movement. Unlike fitted page rollover, this
 * skips empty/unknown extents and transfers the active relative position. */
export function adjacentReadableDocumentAtRelativePosition(
  order: readonly string[],
  doc: string,
  direction: -1 | 1,
  token: number,
  tokenCountOf: (doc: string) => number | undefined,
): ReaderRelativeTarget | null {
  const currentIndex = order.indexOf(doc);
  const currentTokenCount = tokenCountOf(doc);
  if (currentIndex < 0 || currentTokenCount === undefined || currentTokenCount < 1) return null;
  for (
    let index = currentIndex + direction;
    index >= 0 && index < order.length;
    index += direction
  ) {
    const targetDoc = order[index]!;
    const targetTokenCount = tokenCountOf(targetDoc);
    if (targetTokenCount === undefined || targetTokenCount < 1) continue;
    const targetToken = readerRelativeToken(token, currentTokenCount, targetTokenCount);
    if (targetToken !== null) return { doc: targetDoc, token: targetToken };
  }
  return null;
}
