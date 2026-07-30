/** Snapshot-fenced intent shared by every evidence surface that can open the
 * full reader. F lands the place boundary; H attaches reader-page queries. */

export interface ReaderOpenIntent {
  readonly snapshot: string;
  readonly doc: string;
  readonly token: number;
  readonly from: 'kwic' | 'barcode' | 'pin' | 'passage';
}

export interface ReaderPlace {
  readonly snapshot: string;
  readonly doc: string;
  readonly cursor:
    | { readonly kind: 'around'; readonly token: number }
    | { readonly kind: 'from'; readonly token: number }
    | { readonly kind: 'before'; readonly token: number };
  readonly from: ReaderOpenIntent['from'];
}

export function readerPlaceFor(
  intent: ReaderOpenIntent,
  liveSnapshot: string | null,
  readyDocs: readonly string[],
): ReaderPlace | null {
  if (
    intent.snapshot !== liveSnapshot
    || !readyDocs.includes(intent.doc)
    || !Number.isSafeInteger(intent.token)
    || intent.token < 0
  ) {
    return null;
  }
  return {
    snapshot: intent.snapshot,
    doc: intent.doc,
    cursor: { kind: 'around', token: intent.token },
    from: intent.from,
  };
}

export function sameReaderPlace(
  left: ReaderPlace | null,
  right: ReaderPlace | null,
): boolean {
  return left === right
    || (
      left !== null
      && right !== null
      && left.snapshot === right.snapshot
      && left.doc === right.doc
      && left.from === right.from
      && left.cursor.kind === right.cursor.kind
      && left.cursor.token === right.cursor.token
  );
}

export function sameReaderCursor(
  left: ReaderPlace['cursor'] | null,
  right: ReaderPlace['cursor'] | null,
): boolean {
  return left === right
    || (
      left !== null
      && right !== null
      && left.kind === right.kind
      && left.token === right.token
    );
}
