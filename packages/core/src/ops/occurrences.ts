/**
 * Occurrence kernel — Phase 1 plan, Milestone 2. The shared primitive that
 * trend, barcode, and KWIC all consume; they must never re-derive group
 * semantics independently.
 *
 * Semantics (fixing the plan §d.7 open edges):
 * - Each member owns its MatchMode (contract §6) — mixed-mode groups are
 *   first-class; resolvers are looked up per (document, member mode).
 * - A phrase matches strictly adjacent lexical tokens (gap 0, contract §6);
 *   `crossSentence: false` rejects matches spanning a sentence bound;
 *   document boundaries are never crossed. Empty phrases are rejected.
 * - A match must be FULLY contained in one selected token range.
 * - `countOverlaps: true` emits every member match individually.
 * - `countOverlaps: false` merges matches whose covered-token spans overlap
 *   into maximal union spans (per document). Every emitted span reports ALL
 *   contributing member ordinals via a CSR (evidence is never silently
 *   discarded); spans are emitted in (declared doc order, start) order.
 * - Binding discipline: the selection must be bound to THIS snapshot, and
 *   each resolver/shard pair must carry the exact index identity named by
 *   the snapshot's doc ref — a foreign pair cannot answer for a document.
 */

import type { LocalTypeId } from '../contract/brands.ts';
import { canonicalJson } from '../contract/hash.ts';
import type { DocumentIndexV1 } from '../index/build.ts';
import { postingsFor } from '../index/build.ts';
import {
  modeKey,
  resolveAffix,
  resolveToken,
  type MatchMode,
  type Resolver,
} from '../resolve/fold.ts';
import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { ResolvedSelection } from '../snapshot/selection.ts';

export type GroupMember =
  | { readonly id: string; readonly kind: 'token'; readonly surface: string;
      readonly match: MatchMode }
  | { readonly id: string; readonly kind: 'phrase'; readonly surfaces: readonly string[];
      readonly match: MatchMode; readonly crossSentence: boolean }
  | { readonly id: string; readonly kind: 'prefix' | 'suffix'; readonly stem: string;
      readonly match: MatchMode };

export interface TermGroupSpec {
  readonly id: string;
  readonly members: readonly GroupMember[];
  readonly countOverlaps: boolean;
}

/** Resolvers per document, per match mode (key = modeKey(mode)). */
export type ResolverTable = ReadonlyMap<string, ReadonlyMap<string, Resolver>>;

/** Parallel arrays; members via CSR. All positions are document-local. */
export interface NumericOccurrences {
  /** Provenance: the coordinates these occurrences were computed under —
   *  downstream kernels verify both before reinterpreting the positions. */
  readonly snapshot: CorpusSnapshotV1['id'];
  readonly selection: ResolvedSelection['hash'];
  readonly docOrdinal: Uint32Array;
  readonly pos: Uint32Array;
  readonly spanTokens: Uint32Array;
  readonly memberOffsets: Uint32Array;   // length = count + 1
  readonly memberOrdinals: Uint32Array;  // indexes into group.members
}

/**
 * The canonical MATCHING identity of a term group — the coordinates that fully
 * determine the `NumericOccurrences` a group produces against a fixed
 * (snapshot, selection). It captures every member's matching semantics (kind,
 * surface/surfaces/stem, resolved match mode, and a phrase's crossSentence
 * flag), member ORDER (the emitted `memberOrdinals` index into `members`), and
 * `countOverlaps`. It deliberately EXCLUDES the caller-owned provenance ids
 * (`group.id`, each member's `id`), which never reach the numeric output — so a
 * cache keyed on this identity is sound where one keyed on `group.id` is not:
 * `group.id` is presentation provenance and two groups may share it while
 * matching differently (e.g. surfaces `I` vs `İ` fold alike under a guessed
 * `en` locale but resolve differently per document). Callers that memoize
 * occurrences MUST key on this, never on `group.id`.
 *
 * This is a pure serialization: it does NOT semantically validate the group
 * (that is `occurrences`' job, which every caller reaches). Computing an
 * identity for a to-be-run group therefore never changes when a malformed
 * group surfaces its error — a batch of track keys can be built up front
 * without eagerly rejecting a later track.
 */
export function termGroupIdentity(group: TermGroupSpec): string {
  const members = group.members.map((m) => {
    const mode = modeKey(m.match);
    switch (m.kind) {
      case 'token':
        return { k: 'token', mode, surface: m.surface };
      case 'phrase':
        return { k: 'phrase', mode, surfaces: [...m.surfaces], crossSentence: m.crossSentence };
      default:
        return { k: m.kind, mode, stem: m.stem };
    }
  });
  return canonicalJson({ members, countOverlaps: group.countOverlaps });
}

function validateGroup(group: TermGroupSpec): void {
  for (const m of group.members) {
    if (m.kind === 'phrase' && m.surfaces.length === 0) {
      throw new RangeError(`phrase member '${m.id}' has no surfaces`);
    }
  }
}

export interface RawMatch {
  pos: number;
  span: number;
  member: number;
}

/** Half-open document-local token range. */
export interface TokenRangeSpan {
  readonly start: number;
  readonly end: number;
}

function crossesSentence(shard: DocumentIndexV1, start: number, span: number): boolean {
  const bounds = shard.sentenceBounds;
  for (let i = 0; i < bounds.length; i++) {
    const b = bounds[i] as number;
    if (b > start && b < start + span) return true;
    if (b >= start + span) break;
  }
  return false;
}

/** First index whose posting is >= value (postings are position-sorted). */
function lowerBound(postings: Uint32Array, value: number): number {
  let lo = 0;
  let hi = postings.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((postings[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * All member matches of one group within a document, restricted to the given
 * half-open token ranges (null = whole document). Range pruning happens at
 * the POSTINGS level via binary search — the work is bounded by the selected
 * window, never by the document (a scrub sample over 200 tokens must not
 * walk a whole book's postings for a common word). A match counts only when
 * FULLY contained in a single range.
 */
export function matchGroupInTokenRanges(
  shard: DocumentIndexV1,
  resolverFor: (mode: MatchMode) => Resolver,
  group: TermGroupSpec,
  ranges: readonly TokenRangeSpan[] | null,
): RawMatch[] {
  // Semantic validation lives WITH the matcher — every entry point (trend/
  // kwic via occurrences, passage via planPassage) must classify a malformed
  // group as RangeError/REQUEST_INVALID, never as an internal fault.
  validateGroup(group);
  const out: RawMatch[] = [];
  const n = shard.tokenTypeIds.length;
  const whole: readonly TokenRangeSpan[] = [{ start: 0, end: n }];
  const spans = ranges ?? whole;

  for (let m = 0; m < group.members.length; m++) {
    const member = group.members[m] as GroupMember;
    const resolver = resolverFor(member.match);

    if (member.kind !== 'phrase') {
      const ids =
        member.kind === 'token'
          ? resolveToken(resolver, member.surface)
          : resolveAffix(resolver, member.kind, member.stem);
      for (const id of ids) {
        const postings = postingsFor(shard, id as number);
        for (const r of spans) {
          const from = lowerBound(postings, r.start);
          const to = lowerBound(postings, r.end); // span 1: pos < r.end
          for (let i = from; i < to; i++) {
            out.push({ pos: postings[i] as number, span: 1, member: m });
          }
        }
      }
      continue;
    }

    // Phrase: anchor on the member surface with the smallest posting count,
    // verify neighbors at relative offsets (plan M2 / contract Q3).
    const resolved: (readonly LocalTypeId[])[] = member.surfaces.map((s) =>
      resolveToken(resolver, s),
    );
    if (resolved.some((ids) => ids.length === 0)) continue;
    const counts = resolved.map((ids) =>
      ids.reduce((sum, id) => sum + postingsFor(shard, id as number).length, 0),
    );
    let anchor = 0;
    for (let i = 1; i < resolved.length; i++) {
      if ((counts[i] as number) < (counts[anchor] as number)) anchor = i;
    }
    const idSets: Set<number>[] = resolved.map((ids) => new Set<number>(ids as readonly number[]));
    const tokenIds = shard.tokenTypeIds;
    const span = member.surfaces.length;
    for (const id of resolved[anchor] as readonly LocalTypeId[]) {
      const postings = postingsFor(shard, id as number);
      for (const r of spans) {
        // Containment: start >= r.start && start + span <= r.end, with
        // start = posting - anchor — prune the posting slice accordingly.
        const from = lowerBound(postings, r.start + anchor);
        const to = lowerBound(postings, Math.max(r.start + anchor, r.end - span + anchor + 1));
        for (let i = from; i < to; i++) {
          const start = (postings[i] as number) - anchor;
          if (start < 0 || start + span > n) continue;
          let ok = true;
          for (let k = 0; k < span; k++) {
            if (!(idSets[k] as Set<number>).has(tokenIds[start + k] as number)) {
              ok = false;
              break;
            }
          }
          if (ok && !member.crossSentence && crossesSentence(shard, start, span)) ok = false;
          if (ok) out.push({ pos: start, span, member: m });
        }
      }
    }
  }
  out.sort((a, b) => a.pos - b.pos || b.span - a.span || a.member - b.member);
  // Anchoring can find the same (pos, span, member) once per anchor id —
  // dedup exact duplicates.
  return out.filter(
    (r, i) =>
      i === 0 ||
      r.pos !== (out[i - 1] as RawMatch).pos ||
      r.span !== (out[i - 1] as RawMatch).span ||
      r.member !== (out[i - 1] as RawMatch).member,
  );
}

/** One emitted occurrence span with its contributing member ordinals. */
export interface GroupSpan {
  readonly pos: number;
  readonly span: number;
  readonly members: readonly number[];
}

/** Apply the group's overlap semantics to sorted raw matches: overlaps=true
 *  emits every member match; overlaps=false merges into maximal covered-token
 *  union spans reporting ALL contributing members (evidence never dropped). */
export function mergeGroupSpans(matches: readonly RawMatch[], countOverlaps: boolean): GroupSpan[] {
  if (countOverlaps) {
    return matches.map((m) => ({ pos: m.pos, span: m.span, members: [m.member] }));
  }
  const out: GroupSpan[] = [];
  let curStart = -1;
  let curEnd = -1;
  let curMembers = new Set<number>();
  const flush = () => {
    if (curStart < 0) return;
    out.push({ pos: curStart, span: curEnd - curStart, members: [...curMembers].sort((a, b) => a - b) });
  };
  for (const m of matches) {
    if (curStart < 0 || m.pos >= curEnd) {
      flush();
      curStart = m.pos;
      curEnd = m.pos + m.span;
      curMembers = new Set([m.member]);
    } else {
      curEnd = Math.max(curEnd, m.pos + m.span);
      curMembers.add(m.member);
    }
  }
  flush();
  return out;
}

/** The identity-checked resolver lookup shared by every kernel that matches
 *  against a snapshot-named document: the table entry must PROVE it was built
 *  for the requested mode and the exact shard/index the snapshot names. */
export function checkedResolverFor(
  doc: string,
  index: Resolver['index'],
  shard: DocumentIndexV1,
  byMode: ReadonlyMap<string, Resolver>,
): (mode: MatchMode) => Resolver {
  return (mode) => {
    const r = byMode.get(modeKey(mode));
    if (!r) throw new RangeError(`missing resolver for '${doc}' mode ${modeKey(mode)}`);
    // The table is a structural map — the entry must PROVE it was built for
    // the requested mode, not merely be filed under its key (round-2 finding).
    if (modeKey(r.mode) !== modeKey(mode)) {
      throw new RangeError(
        `resolver filed under '${modeKey(mode)}' for '${doc}' was built for '${modeKey(r.mode)}'`,
      );
    }
    if (r.shard !== shard) {
      throw new RangeError(`resolver for '${doc}' is bound to a different shard`);
    }
    // The pair must be the artifact the SNAPSHOT names — a foreign
    // shard+resolver pair must not answer for this document (review round 1).
    if (r.index !== index) {
      throw new RangeError(`resolver/shard pair for '${doc}' does not match the snapshot ref`);
    }
    return r;
  };
}

export function occurrences(
  snapshot: CorpusSnapshotV1,
  shards: ReadonlyMap<string, DocumentIndexV1>,
  resolvers: ResolverTable,
  selection: ResolvedSelection,
  group: TermGroupSpec,
): NumericOccurrences {
  if (selection.snapshot !== snapshot.id) {
    throw new RangeError('selection is bound to a different snapshot');
  }
  validateGroup(group);

  const docOrdinal: number[] = [];
  const pos: number[] = [];
  const spanTokens: number[] = [];
  const memberOffsets: number[] = [0];
  const memberOrdinals: number[] = [];

  const selectedRanges = new Map<string, readonly { start: number; end: number }[]>();
  for (const r of selection.spec.ranges ?? []) {
    const list = selectedRanges.get(r.doc) ?? [];
    selectedRanges.set(r.doc, [...list, { start: r.tokens.start, end: r.tokens.end }]);
  }

  for (let ord = 0; ord < snapshot.docs.length; ord++) {
    const ref = snapshot.docs[ord]!;
    if (!selection.spec.docs.includes(ref.doc)) continue;
    const shard = shards.get(ref.doc);
    const docResolvers = resolvers.get(ref.doc);
    if (!shard || !docResolvers) throw new RangeError(`missing shard/resolvers for '${ref.doc}'`);

    const resolverFor = checkedResolverFor(ref.doc, ref.index, shard, docResolvers);
    const matches = matchGroupInTokenRanges(
      shard,
      resolverFor,
      group,
      selectedRanges.get(ref.doc) ?? null,
    );
    if (matches.length === 0) continue;

    for (const s of mergeGroupSpans(matches, group.countOverlaps)) {
      docOrdinal.push(ord);
      pos.push(s.pos);
      spanTokens.push(s.span);
      for (const m of s.members) memberOrdinals.push(m);
      memberOffsets.push(memberOrdinals.length);
    }
  }

  return {
    snapshot: snapshot.id,
    selection: selection.hash,
    docOrdinal: Uint32Array.from(docOrdinal),
    pos: Uint32Array.from(pos),
    spanTokens: Uint32Array.from(spanTokens),
    memberOffsets: Uint32Array.from(memberOffsets),
    memberOrdinals: Uint32Array.from(memberOrdinals),
  };
}
