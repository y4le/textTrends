/**
 * Passage kernel — the text-scrubbing evidence read (UI phase 3, Codex-
 * consulted contract). Given a document, a center token, and the active
 * term-group tracks, serve a bounded token block of VERIFIED text with
 * per-track occurrence marks, plus per-token char extents so the UI can
 * scrub locally within the block without further worker round trips.
 *
 * Layering follows KWIC exactly: `planPassage` is numeric (offsets only,
 * no text; track identity by ORDINAL), `materializePassage` binds
 * authenticated text and maps ordinals back to caller identities.
 *
 * Invariants (all ranges half-open, all char offsets UTF-16 code units):
 * - centerToken must lie in [0, tokenCount) — a stale or out-of-range
 *   center is REJECTED (RangeError), never silently clamped: silent clamps
 *   hide snapshot/geometry races. A zero-token document has no positions.
 * - The block is chosen token-symmetric around the center, shifted at
 *   document edges to preserve size where possible.
 * - A token cap alone does not bound the message: the block shrinks
 *   (around the center) until its char extent fits PASSAGE_MAX_UTF16;
 *   `truncatedByCharCap` reports that shrink. If the center token ALONE
 *   exceeds the cap, that is CapError — never a partial token.
 * - Marks are complete group occurrences FULLY contained in the served
 *   block (fragments at the edges are not colored as occurrences), sorted
 *   by (charStart, charEnd, track ordinal), overlaps across tracks kept.
 */

import { CapError } from '../contract/brands.ts';
import type { DocumentIndexV1 } from '../index/build.ts';
import { tokenEndChar } from '../index/build.ts';
import type { MatchMode, Resolver } from '../resolve/fold.ts';
import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import { internalTextOf, type BoundTexts } from './binding.ts';
import {
  matchGroupInTokenRanges,
  mergeGroupSpans,
  type TermGroupSpec,
} from './occurrences.ts';

export const PASSAGE_MAX_TOKENS = 200;
export const PASSAGE_MAX_UTF16 = 16_384;

export interface PassageRequest {
  readonly doc: string;
  /** Document-local token position, integer in [0, tokenCount). */
  readonly centerToken: number;
  /** Total requested block size in tokens, 1..PASSAGE_MAX_TOKENS. */
  readonly maxTokens: number;
  readonly tracks: readonly PassageTrackSpec[];
}

export interface PassageTrackSpec {
  /** Opaque UI correlation key; unique within one request. */
  readonly seriesId: string;
  readonly group: TermGroupSpec;
}

export interface PassageMark {
  readonly seriesId: string;
  /** Evidence identity — the group that matched, not a UI concern. */
  readonly groupId: string;
  /** Document-local half-open token span of the occurrence. */
  readonly tokens: { readonly start: number; readonly end: number };
  /** Half-open UTF-16 offsets RELATIVE to `text`. */
  readonly charsUtf16: { readonly start: number; readonly end: number };
}

export interface PassageResult {
  readonly doc: string;
  readonly centerToken: number;
  /** Document-local half-open token range actually served. */
  readonly tokens: { readonly start: number; readonly end: number };
  /** Document-global half-open UTF-16 range `text` was sliced from. */
  readonly docCharsUtf16: { readonly start: number; readonly end: number };
  readonly text: string;
  /** Per served token, RELATIVE to `text`; length = tokens.end - tokens.start. */
  readonly tokenStartsUtf16: readonly number[];
  readonly tokenEndsUtf16: readonly number[];
  /** Relative char span of the requested center token. */
  readonly centerCharsUtf16: { readonly start: number; readonly end: number };
  readonly marks: readonly PassageMark[];
  readonly truncatedByCharCap: boolean;
}

export interface NumericPassagePlan {
  readonly snapshot: CorpusSnapshotV1['id'];
  readonly docOrdinal: number;
  readonly centerToken: number;
  readonly tokenStart: number;
  readonly tokenEnd: number;
  readonly charStartUtf16: number; // document-global
  readonly charEndUtf16: number;
  readonly tokenStartsUtf16: Uint32Array; // relative to charStartUtf16
  readonly tokenEndsUtf16: Uint32Array;
  readonly truncatedByCharCap: boolean;
  /** Parallel mark arrays; track identity by request ordinal only. */
  readonly markTrackOrdinal: Uint32Array;
  readonly markTokenStart: Uint32Array;
  readonly markTokenEnd: Uint32Array;
  readonly markCharStartUtf16: Uint32Array; // relative
  readonly markCharEndUtf16: Uint32Array;
}

export function planPassage(
  snapshot: CorpusSnapshotV1,
  doc: string,
  shard: DocumentIndexV1,
  resolverFor: (mode: MatchMode) => Resolver,
  groups: readonly TermGroupSpec[],
  centerToken: number,
  maxTokens: number,
): NumericPassagePlan {
  const ord = snapshot.docs.findIndex((r) => r.doc === doc);
  if (ord < 0) throw new RangeError(`'${doc}' is not a member of snapshot ${snapshot.id}`);
  const ref = snapshot.docs[ord]!;
  const tokenCount = shard.tokenTypeIds.length;
  if (tokenCount !== ref.tokenCount) {
    throw new RangeError(`shard for '${doc}' does not match the snapshot ref's token count`);
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > PASSAGE_MAX_TOKENS) {
    throw new RangeError(`maxTokens must be an integer in [1, ${PASSAGE_MAX_TOKENS}]`);
  }
  if (!Number.isInteger(centerToken) || centerToken < 0 || centerToken >= tokenCount) {
    // Rejection, not clamping — an out-of-range center is a stale or broken
    // caller and silent correction would hide it. Covers tokenCount === 0.
    throw new RangeError(
      `centerToken ${centerToken} outside [0, ${tokenCount}) for '${doc}'`,
    );
  }

  // Token-symmetric block, shifted (not shrunk) at document edges.
  let start = Math.max(0, Math.min(centerToken - (maxTokens >> 1), tokenCount - maxTokens));
  let end = Math.min(tokenCount, start + maxTokens);

  // Char cap: shrink around the center, dropping from whichever side is
  // currently farther from it, until the extent fits.
  const extent = () =>
    tokenEndChar(shard, end - 1) - (shard.startsUtf16[start] as number);
  let truncated = false;
  while (extent() > PASSAGE_MAX_UTF16) {
    if (end - start === 1) {
      throw new CapError(
        `center token ${centerToken} of '${doc}' alone exceeds PASSAGE_MAX_UTF16`,
      );
    }
    if (centerToken - start >= end - 1 - centerToken) start++;
    else end--;
    truncated = true;
  }

  const charStart = shard.startsUtf16[start] as number;
  const charEnd = tokenEndChar(shard, end - 1);
  const count = end - start;
  const tokenStarts = new Uint32Array(count);
  const tokenEnds = new Uint32Array(count);
  for (let t = 0; t < count; t++) {
    tokenStarts[t] = (shard.startsUtf16[start + t] as number) - charStart;
    tokenEnds[t] = tokenEndChar(shard, start + t) - charStart;
  }

  const markTrackOrdinal: number[] = [];
  const markTokenStart: number[] = [];
  const markTokenEnd: number[] = [];
  const markCharStart: number[] = [];
  const markCharEnd: number[] = [];
  const collected: {
    ordinal: number; tokenStart: number; tokenEnd: number; charStart: number; charEnd: number;
  }[] = [];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!;
    const matches = matchGroupInTokenRanges(shard, resolverFor, group, [{ start, end }]);
    for (const s of mergeGroupSpans(matches, group.countOverlaps)) {
      collected.push({
        ordinal: g,
        tokenStart: s.pos,
        tokenEnd: s.pos + s.span,
        charStart: (shard.startsUtf16[s.pos] as number) - charStart,
        charEnd: tokenEndChar(shard, s.pos + s.span - 1) - charStart,
      });
    }
  }
  collected.sort(
    (a, b) => a.charStart - b.charStart || a.charEnd - b.charEnd || a.ordinal - b.ordinal,
  );
  for (const m of collected) {
    markTrackOrdinal.push(m.ordinal);
    markTokenStart.push(m.tokenStart);
    markTokenEnd.push(m.tokenEnd);
    markCharStart.push(m.charStart);
    markCharEnd.push(m.charEnd);
  }

  return {
    snapshot: snapshot.id,
    docOrdinal: ord,
    centerToken,
    tokenStart: start,
    tokenEnd: end,
    charStartUtf16: charStart,
    charEndUtf16: charEnd,
    tokenStartsUtf16: tokenStarts,
    tokenEndsUtf16: tokenEnds,
    truncatedByCharCap: truncated,
    markTrackOrdinal: Uint32Array.from(markTrackOrdinal),
    markTokenStart: Uint32Array.from(markTokenStart),
    markTokenEnd: Uint32Array.from(markTokenEnd),
    markCharStartUtf16: Uint32Array.from(markCharStart),
    markCharEndUtf16: Uint32Array.from(markCharEnd),
  };
}

/** Materialize the plan against VERIFIED texts, mapping track ordinals back
 *  to the caller's series/group identities. */
export function materializePassage(
  snapshot: CorpusSnapshotV1,
  plan: NumericPassagePlan,
  texts: BoundTexts,
  tracks: readonly PassageTrackSpec[],
): PassageResult {
  if (plan.snapshot !== snapshot.id) {
    throw new RangeError('plan was computed against a different snapshot');
  }
  if (texts.snapshot !== snapshot.id) {
    throw new RangeError('texts are bound to a different snapshot');
  }
  const doc = snapshot.docs[plan.docOrdinal]?.doc;
  if (doc === undefined) throw new RangeError(`unknown doc ordinal ${plan.docOrdinal}`);
  const text = internalTextOf(texts, doc).slice(plan.charStartUtf16, plan.charEndUtf16);

  const marks: PassageMark[] = [];
  for (let i = 0; i < plan.markTrackOrdinal.length; i++) {
    const track = tracks[plan.markTrackOrdinal[i] as number];
    if (!track) throw new RangeError(`mark references unknown track ordinal ${plan.markTrackOrdinal[i]}`);
    marks.push({
      seriesId: track.seriesId,
      groupId: track.group.id,
      tokens: { start: plan.markTokenStart[i] as number, end: plan.markTokenEnd[i] as number },
      charsUtf16: {
        start: plan.markCharStartUtf16[i] as number,
        end: plan.markCharEndUtf16[i] as number,
      },
    });
  }

  const centerRel = plan.centerToken - plan.tokenStart;
  return {
    doc,
    centerToken: plan.centerToken,
    tokens: { start: plan.tokenStart, end: plan.tokenEnd },
    docCharsUtf16: { start: plan.charStartUtf16, end: plan.charEndUtf16 },
    text,
    tokenStartsUtf16: Array.from(plan.tokenStartsUtf16),
    tokenEndsUtf16: Array.from(plan.tokenEndsUtf16),
    centerCharsUtf16: {
      start: plan.tokenStartsUtf16[centerRel] as number,
      end: plan.tokenEndsUtf16[centerRel] as number,
    },
    marks,
    truncatedByCharCap: plan.truncatedByCharCap,
  };
}
