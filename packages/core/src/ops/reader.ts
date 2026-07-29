/**
 * reader-page/1 kernel — the full-document, one-document-at-a-time, cursor-
 * paged reader (slice-2 ruling §3/§G). A reader page is NOT a repeated
 * passage block: passage centers are not stable pages, and char-cap
 * shrinkage makes naïve next/previous arithmetic overlap or skip text. This
 * kernel owns the paging contract so the client never does cursor math.
 *
 * Layering follows passage/KWIC exactly: `planReaderPage` is numeric
 * (offsets only, no text; track identity by ORDINAL), `materializeReaderPage`
 * binds authenticated text via the BoundTexts discipline.
 *
 * Invariants (all ranges half-open, all char offsets UTF-16 code units):
 * - One canonical partition is greedily derived FORWARD from token zero
 *   under the effective budget min(maxTokens, READER_MAX_TOKENS) and
 *   READER_MAX_TEXT_UTF16. `maxTokens` therefore belongs to the partition
 *   identity and clients keep it constant while paging.
 * - Every cursor resolves onto that partition: `from(t)` and `around(t)`
 *   serve the canonical page CONTAINING t; `before(t)` serves the page
 *   containing t - 1. `from(t)` need not start at t, and `around(t)` retains
 *   but need not center its anchor (the result reports `anchor.relToken`).
 * - `cappedBy` is derived from the canonical page: 'text' when the character
 *   cap stopped a non-final page below the token budget, 'tokens' when the
 *   budget stopped it, and null when the document edge did. A SINGLE token
 *   exceeding the text cap is an unservable one-token island: requesting
 *   that page is CapError, never a partial token. The internal partition is
 *   still total after the island, but a cursor-only client cannot cross it:
 *   the server-issued cursor targets the island and throws, so serving the
 *   tail requires an explicit out-of-band post-island cursor.
 * - Stable cursors: previous = before(served start), next = from(served
 *   end). Both re-resolve onto the same canonical partition, so forward and
 *   backward walks across SERVABLE pages are exact token-range reverses until
 *   an oversized island. Token ranges are adjacent; separator characters
 *   between pages are intentionally not served because page char ranges are
 *   token-bounded. Cursors are omitted (null) at document edges, which are
 *   also flagged (`atStart`/`atEnd`) alongside `docTokenCount`.
 * - Marks are projected from caller-supplied per-track `NumericOccurrences`
 *   (the SHARED occurrence cache) by binary-searching this document's
 *   slice — the kernel never re-matches text, so `countOverlaps`, merged
 *   spans, and member evidence keep one semantic and an occurrence that
 *   begins before the page but intersects it is found. Intersection is
 *   (start < pageEnd && start + span > pageStart); a cross-page occurrence
 *   is served CLIPPED with explicit `clippedStart`/`clippedEnd`, never
 *   silently omitted or presented as complete.
 * - All output arrays are FRESH — a caller may transfer them without
 *   detaching the occurrence cache's buffers.
 */

import { CapError } from '../contract/brands.ts';
import type { DocumentIndexV1 } from '../index/build.ts';
import { tokenEndChar } from '../index/build.ts';
import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import { lowerBound } from '../structure/project.ts';
import { internalTextOf, type BoundTexts } from './binding.ts';
import { MAX_KWIC_TRACKS } from './kwic.ts';
import { TERM_GROUP_LIMITS_V1, type NumericOccurrences } from './occurrences.ts';

/** Requested-tokens cap; a larger `maxTokens` is clamped (and reported). */
export const READER_MAX_TOKENS = 400;
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
  /** Self-describing evidence identity bound from the ordered request tracks. */
  readonly seriesId: string;
  readonly groupId: string;
  /** ABSOLUTE document-local token span of the FULL occurrence (unclipped —
   *  occurrence identity survives page edges; a click opens the full KWIC row). */
  readonly tokens: { readonly start: number; readonly end: number };
  /** Contributing member ordinals (CSR slice — evidence never dropped). */
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
  /** Stable cursors — no client arithmetic; null exactly at document edges. */
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
  /** CSR member evidence per mark (length = marks + 1). */
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

/**
 * Resolve `target` onto the ONE canonical greedy-forward partition for this
 * document and effective token budget. The walk remains total across a token
 * that alone exceeds the text cap by treating it as a one-token island; that
 * island throws only when it is the requested page.
 */
function canonicalPage(
  doc: string,
  shard: DocumentIndexV1,
  tokenCount: number,
  target: number,
  budget: number,
): readonly [start: number, end: number] {
  let start = 0;
  for (;;) {
    const maxEnd = Math.min(tokenCount, start + budget);
    const charStart = shard.startsUtf16[start] as number;
    const oversized = tokenEndChar(shard, start) - charStart > READER_MAX_TEXT_UTF16;
    let end = start + 1;
    if (!oversized) {
      // The extent predicate is monotone in the exclusive token end, so find
      // the largest admissible end in O(log budget).
      let lo = start + 1;
      let hi = maxEnd;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        const extent = tokenEndChar(shard, mid - 1) - charStart;
        if (extent <= READER_MAX_TEXT_UTF16) lo = mid;
        else hi = mid - 1;
      }
      end = lo;
    }
    if (target < end) {
      if (oversized) {
        throw new CapError(
          `token ${start} of '${doc}' alone exceeds READER_MAX_TEXT_UTF16`,
        );
      }
      return [start, end];
    }
    start = end;
  }
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

  // All modes resolve to the canonical page containing one target token:
  // from/around target t, while before(t) targets t - 1. Partition identity
  // is the EFFECTIVE budget, so clamped maxTokens values partition equally.
  const budget = Math.min(maxTokens, READER_MAX_TOKENS);
  const target = cursor.kind === 'before' ? token - 1 : token;
  const [start, end] = canonicalPage(doc, shard, tokenCount, target, budget);
  const cappedBy: ReaderCappedBy =
    end === tokenCount ? null : end - start === budget ? 'tokens' : 'text';

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
  // a bad notebook payload is contractual, mirroring passage's discipline).
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
  //   maxPhraseSurfaces tokens, so nothing starting at or before
  //   pageStart - maxPhraseSurfaces can reach pageStart.
  // The combined stop rule below is sound for both without knowing which
  // regime produced the set.
  const maxMemberSpan = TERM_GROUP_LIMITS_V1.maxPhraseSurfaces;
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
  // and say so — a page never silently hides evidence.
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
 *  to caller series/group identities exactly as KWIC and passage do. */
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
