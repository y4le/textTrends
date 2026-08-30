/** Snapshot-fenced intent shared by views that can open the full Reader. */

export type ReaderAnchorKind = 'occurrence' | 'position';

export interface ReaderOpenIntent {
  readonly snapshot: string;
  readonly doc: string;
  readonly token: number;
  readonly from: 'kwic' | 'barcode' | 'footer' | 'occurrence';
  /** The evidence claim at this location. A density midpoint is a position,
   * even though its numeric token is exact. */
  readonly anchor: ReaderAnchorKind;
}

export interface ReaderPlace {
  readonly snapshot: string;
  readonly doc: string;
  readonly cursor:
    | { readonly kind: 'around'; readonly token: number }
    | { readonly kind: 'from'; readonly token: number }
    | { readonly kind: 'before'; readonly token: number };
  readonly from: ReaderOpenIntent['from'];
  readonly anchor: ReaderAnchorKind;
}

const READER_ORIGINS = new Set<ReaderOpenIntent['from']>([
  'kwic',
  'barcode',
  'footer',
  'occurrence',
]);
const READER_CURSOR_KINDS = new Set<ReaderPlace['cursor']['kind']>([
  'around',
  'from',
  'before',
]);
const READER_ANCHOR_KINDS = new Set<ReaderAnchorKind>([
  'occurrence',
  'position',
]);

/**
 * Layer targets are deliberately typed `unknown`; browser history retains
 * only their ids, and the in-memory registry supplies the target on restore.
 * Revalidate that target against both its shape and the live snapshot before
 * a restored reader can issue a query.
 */
export function liveReaderPlace(
  value: unknown,
  liveSnapshot: string | null,
  readyDocs: readonly string[],
): ReaderPlace | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ReaderPlace>;
  const cursor = candidate.cursor;
  if (
    candidate.snapshot !== liveSnapshot
    || typeof candidate.doc !== 'string'
    || !readyDocs.includes(candidate.doc)
    || typeof candidate.from !== 'string'
    || !READER_ORIGINS.has(candidate.from as ReaderOpenIntent['from'])
    || typeof candidate.anchor !== 'string'
    || !READER_ANCHOR_KINDS.has(candidate.anchor as ReaderAnchorKind)
    || typeof cursor !== 'object'
    || cursor === null
  ) {
    return null;
  }
  const shapedCursor = cursor as Partial<ReaderPlace['cursor']>;
  if (
    typeof shapedCursor.kind !== 'string'
    || !READER_CURSOR_KINDS.has(shapedCursor.kind as ReaderPlace['cursor']['kind'])
    || !Number.isSafeInteger(shapedCursor.token)
    || (shapedCursor.token ?? -1) < 0
    || (shapedCursor.kind === 'before' && (shapedCursor.token ?? 0) < 1)
  ) {
    return null;
  }
  return value as ReaderPlace;
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
    || !READER_ANCHOR_KINDS.has(intent.anchor)
  ) {
    return null;
  }
  return {
    snapshot: intent.snapshot,
    doc: intent.doc,
    cursor: { kind: 'around', token: intent.token },
    from: intent.from,
    anchor: intent.anchor,
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
      && left.anchor === right.anchor
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
