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
