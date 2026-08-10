/**
 * reader-page/1 kernel — a bounded, directional source slice for the
 * full-document Reader. Visual pages are layout-dependent and belong to the
 * browser; this kernel supplies authenticated text and occurrence marks
 * around an exact token boundary without pretending a token budget is a
 * screen page.
 *
 * Layering follows KWIC exactly: `planReaderPage` is numeric
 * (offsets only, no text; track identity by ORDINAL), `materializeReaderPage`
 * binds authenticated text via the BoundTexts discipline.
 *
 * Invariants (all ranges half-open, all char offsets UTF-16 code units):
 * - `from(t)` begins exactly at t and grows forward; `before(t)` ends exactly
 *   at t and grows backward; `around(t)` grows on both sides while retaining
 *   t. This makes every served edge a useful visual-page measurement seam.
 * - Slices are bounded by min(maxTokens, READER_MAX_TOKENS) and
 *   READER_MAX_TEXT_UTF16. A single oversized token is still served whole:
 *   the browser's emergency wrapping is more useful than an un-crossable
 *   error island.
 * - `cappedBy` reports why the requested direction stopped. Server cursors
 *   describe the served slice edges; the browser replaces them with the
 *   smaller range it actually displayed after layout measurement.
 * - Separator characters between slices are intentionally not served because
 *   all source ranges are token-bounded.
 * - Marks are projected from caller-supplied per-track `NumericOccurrences`
 *   (the SHARED occurrence cache) by binary-searching this document's
 *   slice — the kernel never re-matches text, so `countOverlaps`, merged
 *   spans, and contributing members keep one semantic and an occurrence that
 *   begins before the page but intersects it is found. Intersection is
 *   (start < pageEnd && start + span > pageStart); a cross-page occurrence
 *   is served CLIPPED with explicit `clippedStart`/`clippedEnd`, never
 *   silently omitted or presented as complete.
 * - All output arrays are FRESH — a caller may transfer them without
 *   detaching the occurrence cache's buffers.
 */

import type { DocumentIndexV1 } from '../index/build.ts';
import { lowerBound, tokenEndChar } from '../index/build.ts';
import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import { internalTextOf, type BoundTexts } from './binding.ts';
import { MAX_KWIC_TRACKS } from './kwic.ts';
import { TERM_GROUP_LIMITS_V1, type NumericOccurrences } from './occurrences.ts';

/** Requested source-slice cap; a larger `maxTokens` is clamped and reported. */
export const READER_MAX_TOKENS = 4_096;
/** Served text extent cap, UTF-16 code units. */
export const READER_MAX_TEXT_UTF16 = 32_768;
/** Total marks per page across all tracks; excess is truncated WITH a flag. */
export const READER_MAX_MARKS = 5_000;
/** One track-cap authority with KWIC — the same notebook feeds both. */
export const READER_MAX_TRACKS = MAX_KWIC_TRACKS;

export type ReaderCursor =
  | { readonly kind: 'around'; readonly token: number }
  | { readonly kind: 'from'; readonly token: number }
  | { readonly kind: 'before'; readonly token: number };

export type ReaderCappedBy = 'tokens' | 'text' | null;

export interface ReaderPageMark {
  /** Self-describing occurrence identity bound from the ordered request tracks. */
  readonly seriesId: string;
  readonly groupId: string;
  /** ABSOLUTE document-local token span of the FULL occurrence (unclipped —
   *  occurrence identity survives page edges; a click opens the full KWIC row). */
  readonly tokens: { readonly start: number; readonly end: number };
  /** Contributing member ordinals (CSR slice — contributors never dropped). */
  readonly members: readonly number[];
  /** Half-open UTF-16 offsets RELATIVE to `text`, CLIPPED to the page. */
  readonly charsUtf16: { readonly start: number; readonly end: number };
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
}

export interface ReaderPageResult {
  readonly doc: string;
  /** Document-local half-open token range actually served. */
  readonly tokens: { readonly start: number; readonly end: number };
  /** Document-global half-open UTF-16 range `text` was sliced from. */
  readonly docCharsUtf16: { readonly start: number; readonly end: number };
  readonly text: string;
  /** Per served token, RELATIVE to `text`; length = tokens.end - tokens.start. */
  readonly tokenStartsUtf16: readonly number[];
  readonly tokenEndsUtf16: readonly number[];
  /** Present exactly for `around` cursors: the retained anchor's absolute
   *  token, page-relative token index, and relative char span. */
  readonly anchor: {
    readonly token: number;
    readonly relToken: number;
    readonly charsUtf16: { readonly start: number; readonly end: number };
  } | null;
  /** Directional source-slice cursors; visual pages replace these after fit. */
  readonly previous: { readonly kind: 'before'; readonly token: number } | null;
  readonly next: { readonly kind: 'from'; readonly token: number } | null;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly docTokenCount: number;
  readonly cappedBy: ReaderCappedBy;
  readonly marks: readonly ReaderPageMark[];
  readonly marksTruncated: boolean;
}

export interface NumericReaderPagePlan {
  readonly snapshot: CorpusSnapshotV1['id'];
  readonly docOrdinal: number;
  readonly cursorKind: ReaderCursor['kind'];
  /** Absolute anchor token for 'around'; -1 otherwise. */
  readonly anchorToken: number;
  readonly tokenStart: number;
  readonly tokenEnd: number;
  readonly charStartUtf16: number; // document-global
  readonly charEndUtf16: number;
  readonly tokenStartsUtf16: Uint32Array; // relative to charStartUtf16
  readonly tokenEndsUtf16: Uint32Array;
  readonly docTokenCount: number;
  readonly cappedBy: ReaderCappedBy;
  /** Parallel mark arrays; track identity by request ordinal only. */
  readonly markTrackOrdinal: Uint32Array;
  readonly markTokenStart: Uint32Array; // absolute, UNclipped
  readonly markTokenEnd: Uint32Array;
  readonly markCharStartUtf16: Uint32Array; // relative, CLIPPED
  readonly markCharEndUtf16: Uint32Array;
  readonly markClippedStart: Uint8Array; // 0 | 1
  readonly markClippedEnd: Uint8Array;
  /** CSR contributing members per mark (length = marks + 1). */
  readonly markMemberOffsets: Uint32Array;
  readonly markMemberOrdinals: Uint32Array;
  readonly marksTruncated: boolean;
}

interface CollectedMark {
  ordinal: number;
  tokenStart: number;
  tokenEnd: number;
  charStart: number;
  charEnd: number;
  clippedStart: boolean;
  clippedEnd: boolean;
  members: readonly number[];
}

/** The ordered track identity table the materializer binds marks against —
 *  the same order the numeric plan's `trackOrdinal` indexes. */
export interface ReaderTrackIdentity {
  readonly seriesId: string;
  readonly groupId: string;
}

function charExtent(
  shard: DocumentIndexV1,
  start: number,
  end: number,
): number {
  return tokenEndChar(shard, end - 1) - (shard.startsUtf16[start] as number);
}

function forwardSlice(
  shard: DocumentIndexV1,
  start: number,
  maxEnd: number,
): readonly [start: number, end: number, textCapped: boolean] {
  if (charExtent(shard, start, start + 1) > READER_MAX_TEXT_UTF16) {
    return [start, start + 1, start + 1 < maxEnd];
  }
  let lo = start + 1;
  let hi = maxEnd;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (charExtent(shard, start, mid) <= READER_MAX_TEXT_UTF16) lo = mid;
    else hi = mid - 1;
  }
  return [start, lo, lo < maxEnd];
}

function backwardSlice(
  shard: DocumentIndexV1,
  minStart: number,
  end: number,
): readonly [start: number, end: number, textCapped: boolean] {
  if (charExtent(shard, end - 1, end) > READER_MAX_TEXT_UTF16) {
    return [end - 1, end, end - 1 > minStart];
  }
  let lo = minStart;
  let hi = end - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (charExtent(shard, mid, end) <= READER_MAX_TEXT_UTF16) hi = mid;
    else lo = mid + 1;
  }
  return [lo, end, lo > minStart];
}

function aroundSlice(
  shard: DocumentIndexV1,
  tokenCount: number,
  anchor: number,
  budget: number,
): readonly [start: number, end: number, textCapped: boolean] {
  let start = anchor;
  let end = anchor + 1;
  if (charExtent(shard, start, end) > READER_MAX_TEXT_UTF16) {
    return [start, end, Math.min(budget, tokenCount) > 1];
  }
  let leftBlocked = false;
  let rightBlocked = false;
  while (end - start < budget) {
    const leftCount = anchor - start;
    const rightCount = end - anchor - 1;
    const preferLeft = leftCount <= rightCount;
    const directions = preferLeft ? ([-1, 1] as const) : ([1, -1] as const);
    let added = false;
    for (const direction of directions) {
      if (direction === -1) {
        if (leftBlocked || start === 0) continue;
        if (charExtent(shard, start - 1, end) <= READER_MAX_TEXT_UTF16) {
          start--;
          added = true;
          break;
        }
        leftBlocked = true;
      } else {
        if (rightBlocked || end === tokenCount) continue;
        if (charExtent(shard, start, end + 1) <= READER_MAX_TEXT_UTF16) {
          end++;
          added = true;
          break;
        }
        rightBlocked = true;
      }
    }
    if (!added) break;
  }
  const available = Math.min(budget, tokenCount);
  return [start, end, end - start < available];
}

export function planReaderPage(
  snapshot: CorpusSnapshotV1,
  doc: string,
  shard: DocumentIndexV1,
  cursor: ReaderCursor,
  maxTokens: number,
  tracks: readonly NumericOccurrences[],
): NumericReaderPagePlan {
  const ord = snapshot.docs.findIndex((r) => r.doc === doc);
  if (ord < 0) throw new RangeError(`'${doc}' is not a member of snapshot ${snapshot.id}`);
  const ref = snapshot.docs[ord]!;
  const tokenCount = shard.tokenTypeIds.length;
  if (tokenCount !== ref.tokenCount) {
    throw new RangeError(`shard for '${doc}' does not match the snapshot ref's token count`);
  }
  // maxTokens above READER_MAX_TOKENS is CLAMPED (and reported via cappedBy),
  // per the ruling's min(maxTokens, READER_MAX_TOKENS, text cap); a
  // non-positive or fractional request is a broken caller and is rejected.
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError('maxTokens must be a positive integer');
  }
  const token = cursor.token;
  if (!Number.isInteger(token)) throw new RangeError('cursor token must be an integer');
  // Rejection, not clamping — an out-of-range cursor is a stale or broken
  // caller and silent correction would hide it. Covers tokenCount === 0
  // (an empty document has no readable positions under any cursor).
  switch (cursor.kind) {
    case 'around':
    case 'from':
      if (token < 0 || token >= tokenCount) {
        throw new RangeError(`cursor token ${token} outside [0, ${tokenCount}) for '${doc}'`);
      }
      break;
    case 'before':
      // A before-page ENDS (exclusive) at the cursor: it must have at least
      // one token before it. before(0) never exists — the client sees
      // atStart and a null previous cursor instead of issuing it.
      if (token < 1 || token > tokenCount) {
        throw new RangeError(`cursor token ${token} outside [1, ${tokenCount}] for '${doc}'`);
      }
      break;
    default:
      throw new RangeError(`unknown cursor kind '${(cursor as { kind: string }).kind}'`);
  }

  const budget = Math.min(maxTokens, READER_MAX_TOKENS);
  let range: readonly [start: number, end: number, textCapped: boolean];
  switch (cursor.kind) {
    case 'from':
      range = forwardSlice(shard, token, Math.min(tokenCount, token + budget));
      break;
    case 'before':
      range = backwardSlice(shard, Math.max(0, token - budget), token);
      break;
    case 'around':
      range = aroundSlice(shard, tokenCount, token, budget);
      break;
  }
  const [start, end, textCapped] = range;
  const reachedDirectionalEdge = cursor.kind === 'before'
    ? start === 0
    : cursor.kind === 'from'
      ? end === tokenCount
      : start === 0 && end === tokenCount;
  const cappedBy: ReaderCappedBy = textCapped
    ? 'text'
    : reachedDirectionalEdge
      ? null
      : 'tokens';

  const charStart = shard.startsUtf16[start] as number;
  const charEnd = tokenEndChar(shard, end - 1);
  const count = end - start;
  const tokenStarts = new Uint32Array(count);
  const tokenEnds = new Uint32Array(count);
  for (let t = 0; t < count; t++) {
    tokenStarts[t] = (shard.startsUtf16[start + t] as number) - charStart;
    tokenEnds[t] = tokenEndChar(shard, start + t) - charStart;
  }

  // Tracks are validated ONCE here, immediately before mark projection —
  // after the document/cursor/cap checks above (their error precedence over
  // a bad notebook payload is contractual, mirroring KWIC's discipline).
  // ZERO tracks is first-class — reading must not depend on the notebook.
  if (tracks.length > READER_MAX_TRACKS) {
    throw new RangeError(`reader accepts at most ${READER_MAX_TRACKS} tracks`);
  }
  for (const occ of tracks) {
    if (occ.snapshot !== snapshot.id) {
      throw new RangeError('occurrences were computed under a different snapshot');
    }
    // Mutual consistency only: every track must have been computed under the
    // SAME selection. The engine supplies the base full-corpus selection and
    // the wire op carries no selection; this kernel cannot prove base-ness
    // from a single NumericOccurrences value alone. A mixed set would render
    // marks of two different worlds on one page.
    if (occ.selection !== (tracks[0] as NumericOccurrences).selection) {
      throw new RangeError('tracks were computed under differing selections');
    }
  }

  // ── Marks: binary-search each track's slice for THIS doc, then clip. ──
  // Straddler discipline (why the bounded backward walk below is complete):
  // within one document a track's `pos` is strictly ascending, and either
  // - countOverlaps=false: merged spans are DISJOINT, so span ends are also
  //   ascending — once one occurrence fails (start+span <= pageStart) every
  //   earlier one fails too; or
  // - countOverlaps=true: every member match spans at most
  //   maxPhraseElements tokens, so nothing starting at or before
  //   pageStart - maxPhraseElements can reach pageStart.
  // The combined stop rule below is sound for both without knowing which
  // regime produced the set.
  const maxMemberSpan = TERM_GROUP_LIMITS_V1.maxPhraseElements;
  const collected: CollectedMark[] = [];
  const pushMark = (occ: NumericOccurrences, ordinal: number, i: number, into: CollectedMark[]) => {
    const occStart = occ.pos[i] as number;
    const span = occ.spanTokens[i] as number;
    const occEnd = occStart + span;
    if (span < 1 || occEnd > tokenCount) {
      // A track that names positions this shard cannot hold was computed
      // against some other artifact — refuse, never read garbage offsets.
      throw new RangeError(`track ${ordinal} occurrence ${i} exceeds '${doc}' extent`);
    }
    const visStart = Math.max(occStart, start);
    const visEnd = Math.min(occEnd, end);
    into.push({
      ordinal,
      tokenStart: occStart,
      tokenEnd: occEnd,
      charStart: (shard.startsUtf16[visStart] as number) - charStart,
      charEnd: tokenEndChar(shard, visEnd - 1) - charStart,
      clippedStart: occStart < start,
      clippedEnd: occEnd > end,
      members: Array.from(
        occ.memberOrdinals.subarray(
          occ.memberOffsets[i] as number,
          occ.memberOffsets[i + 1] as number,
        ),
      ),
    });
  };
  for (let g = 0; g < tracks.length; g++) {
    const occ = tracks[g] as NumericOccurrences;
    // Doc slice: docOrdinal is ascending by contract.
    const sliceStart = lowerBound(occ.docOrdinal, ord);
    const sliceEnd = lowerBound(occ.docOrdinal, ord + 1);
    if (sliceStart === sliceEnd) continue;
    const posView = occ.pos.subarray(sliceStart, sliceEnd);
    // First occurrence starting inside the page, and the exclusive upper
    // bound (starts at/after pageEnd never intersect).
    const firstIn = sliceStart + lowerBound(posView, start);
    const hi = sliceStart + lowerBound(posView, end);
    // Backward walk for straddlers that START before the page but reach in.
    const straddlers: CollectedMark[] = [];
    for (let i = firstIn - 1; i >= sliceStart; i--) {
      const p = occ.pos[i] as number;
      const reaches = p + (occ.spanTokens[i] as number) > start;
      if (reaches) pushMark(occ, g, i, straddlers);
      else if (p + maxMemberSpan <= start) break; // see discipline note above
    }
    straddlers.reverse();
    for (const m of straddlers) collected.push(m);
    for (let i = firstIn; i < hi; i++) pushMark(occ, g, i, collected);
  }

  // Render order, then the HONEST mark cap: keep the first READER_MAX_MARKS
  // and say so — a page never silently hides occurrences.
  collected.sort(
    (a, b) =>
      a.charStart - b.charStart ||
      a.charEnd - b.charEnd ||
      a.ordinal - b.ordinal ||
      a.tokenStart - b.tokenStart,
  );
  const marksTruncated = collected.length > READER_MAX_MARKS;
  const kept = marksTruncated ? collected.slice(0, READER_MAX_MARKS) : collected;

  const n = kept.length;
  const markTrackOrdinal = new Uint32Array(n);
  const markTokenStart = new Uint32Array(n);
  const markTokenEnd = new Uint32Array(n);
  const markCharStartUtf16 = new Uint32Array(n);
  const markCharEndUtf16 = new Uint32Array(n);
  const markClippedStart = new Uint8Array(n);
  const markClippedEnd = new Uint8Array(n);
  const markMemberOffsets = new Uint32Array(n + 1);
  const memberOrdinals: number[] = [];
  for (let i = 0; i < n; i++) {
    const m = kept[i] as CollectedMark;
    markTrackOrdinal[i] = m.ordinal;
    markTokenStart[i] = m.tokenStart;
    markTokenEnd[i] = m.tokenEnd;
    markCharStartUtf16[i] = m.charStart;
    markCharEndUtf16[i] = m.charEnd;
    markClippedStart[i] = m.clippedStart ? 1 : 0;
    markClippedEnd[i] = m.clippedEnd ? 1 : 0;
    for (const mo of m.members) memberOrdinals.push(mo);
    markMemberOffsets[i + 1] = memberOrdinals.length;
  }

  return {
    snapshot: snapshot.id,
    docOrdinal: ord,
    cursorKind: cursor.kind,
    anchorToken: cursor.kind === 'around' ? token : -1,
    tokenStart: start,
    tokenEnd: end,
    charStartUtf16: charStart,
    charEndUtf16: charEnd,
    tokenStartsUtf16: tokenStarts,
    tokenEndsUtf16: tokenEnds,
    docTokenCount: tokenCount,
    cappedBy,
    markTrackOrdinal,
    markTokenStart,
    markTokenEnd,
    markCharStartUtf16,
    markCharEndUtf16,
    markClippedStart,
    markClippedEnd,
    markMemberOffsets,
    markMemberOrdinals: Uint32Array.from(memberOrdinals),
    marksTruncated,
  };
}

/** Materialize the plan against VERIFIED texts, mapping track ordinals back
 *  to caller series/group identities exactly as KWIC does. */
export function materializeReaderPage(
  snapshot: CorpusSnapshotV1,
  plan: NumericReaderPagePlan,
  texts: BoundTexts,
  tracks: readonly ReaderTrackIdentity[],
): ReaderPageResult {
  if (plan.snapshot !== snapshot.id) {
    throw new RangeError('plan was computed against a different snapshot');
  }
  if (texts.snapshot !== snapshot.id) {
    throw new RangeError('texts are bound to a different snapshot');
  }
  const doc = snapshot.docs[plan.docOrdinal]?.doc;
  if (doc === undefined) throw new RangeError(`unknown doc ordinal ${plan.docOrdinal}`);
  const text = internalTextOf(texts, doc).slice(plan.charStartUtf16, plan.charEndUtf16);

  const marks: ReaderPageMark[] = [];
  for (let i = 0; i < plan.markTrackOrdinal.length; i++) {
    const ordinal = plan.markTrackOrdinal[i] as number;
    const track = tracks[ordinal];
    if (track === undefined) throw new RangeError(`mark references unknown track ordinal ${ordinal}`);
    marks.push({
      seriesId: track.seriesId,
      groupId: track.groupId,
      tokens: { start: plan.markTokenStart[i] as number, end: plan.markTokenEnd[i] as number },
      members: Array.from(
        plan.markMemberOrdinals.subarray(
          plan.markMemberOffsets[i] as number,
          plan.markMemberOffsets[i + 1] as number,
        ),
      ),
      charsUtf16: {
        start: plan.markCharStartUtf16[i] as number,
        end: plan.markCharEndUtf16[i] as number,
      },
      clippedStart: plan.markClippedStart[i] === 1,
      clippedEnd: plan.markClippedEnd[i] === 1,
    });
  }

  const atStart = plan.tokenStart === 0;
  const atEnd = plan.tokenEnd === plan.docTokenCount;
  let anchor: ReaderPageResult['anchor'] = null;
  if (plan.cursorKind === 'around') {
    const rel = plan.anchorToken - plan.tokenStart;
    anchor = {
      token: plan.anchorToken,
      relToken: rel,
      charsUtf16: {
        start: plan.tokenStartsUtf16[rel] as number,
        end: plan.tokenEndsUtf16[rel] as number,
      },
    };
  }

  return {
    doc,
    tokens: { start: plan.tokenStart, end: plan.tokenEnd },
    docCharsUtf16: { start: plan.charStartUtf16, end: plan.charEndUtf16 },
    text,
    tokenStartsUtf16: Array.from(plan.tokenStartsUtf16),
    tokenEndsUtf16: Array.from(plan.tokenEndsUtf16),
    anchor,
    previous: atStart ? null : { kind: 'before', token: plan.tokenStart },
    next: atEnd ? null : { kind: 'from', token: plan.tokenEnd },
    atStart,
    atEnd,
    docTokenCount: plan.docTokenCount,
    cappedBy: plan.cappedBy,
    marks,
    marksTruncated: plan.marksTruncated,
  };
}
