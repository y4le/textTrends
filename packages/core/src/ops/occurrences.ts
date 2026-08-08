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

import { CapError, type LocalTypeId } from '../contract/brands.ts';
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
import type { ResolvedSelection, TokenRangeSpan } from '../snapshot/selection.ts';
import { lowerBound } from '../structure/project.ts';
import { DISPERSION_EXACT_MAX } from './dispersion.ts';

export type { TokenRangeSpan } from '../snapshot/selection.ts';

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

/** V1 admission bounds for a term group — ONE authority shared by the kernel
 *  validator below, the wire narrower, and (later) the app's authoring UI, so
 *  a group the app accepts is exactly a group the kernel accepts. Bounds are
 *  in UTF-16 code units on the raw (pre-fold) strings. */
export const TERM_GROUP_LIMITS_V1 = {
  /** Members per group (≥1 — an empty group matches nothing and is a bug). */
  maxMembers: 32,
  /** Ordered surfaces per phrase member (≥1). */
  maxPhraseSurfaces: 16,
  /** Each token surface / affix stem / phrase surface. */
  maxSurfaceUnits: 256,
  /** Caller-owned provenance ids (group id, member id). */
  maxIdUnits: 128,
} as const;

/** Hard construction bounds for one (snapshot, selection, group) result.
 * `maxOccurrences` is four times the exact-dispersion threshold: common terms
 * can cross the 50k density switch without being rejected, while one result's
 * four occurrence-indexed Uint32 arrays stay near 3.2 MiB. CSR provenance is
 * capped separately at eight members per emitted span on average, bounding a
 * maximal typed payload near 9.6 MiB even though a group may declare 32
 * members. Raw matches share `maxOccurrences`; that stricter work bound is
 * what prevents overlap merging from hiding an unbounded object-array peak. */
export const OCCURRENCE_LIMITS_V1 = {
  maxOccurrences: 4 * DISPERSION_EXACT_MAX,
  maxMemberOrdinals: 8 * 4 * DISPERSION_EXACT_MAX,
} as const;

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

export function occurrencePayloadBytes(occurrences: NumericOccurrences): number {
  return occurrences.docOrdinal.byteLength
    + occurrences.pos.byteLength
    + occurrences.spanTokens.byteLength
    + occurrences.memberOffsets.byteLength
    + occurrences.memberOrdinals.byteLength;
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

/** Semantic group validation against `TERM_GROUP_LIMITS_V1` — every PUBLIC
 *  kernel entry (occurrences, planPassage) must run this exactly once so a
 *  malformed group classifies as RangeError/REQUEST_INVALID, never as an
 *  internal fault. Exported through the barrel (slice-1 ruling): the app's
 *  authoring surface must accept exactly the groups the kernel accepts.
 *
 *  Emptiness is judged on the RAW strings; a surface that folds/normalizes to
 *  nothing (e.g. a bare combining mark under a folded mode) is caught at
 *  resolution instead, where `resolveAffix` refuses an empty folded stem
 *  rather than matching the entire vocabulary. */
export function validateGroup(group: TermGroupSpec): void {
  const L = TERM_GROUP_LIMITS_V1;
  // Narrowing guard, not just a check: returns the PROVEN string so no error
  // label (or later use) can touch an unvalidated id — a template literal
  // evaluates before the callee runs, so deriving a label from `m.id` at the
  // call site would throw TypeError for a missing id (review-A round 2).
  const boundedId = (id: unknown, what: string): string => {
    if (typeof id !== 'string' || id.length === 0 || id.length > L.maxIdUnits) {
      throw new RangeError(`${what} id must be 1–${L.maxIdUnits} code units`);
    }
    return id;
  };
  const boundedSurface = (s: unknown, what: string): void => {
    // `typeof` guard: a SPARSE surfaces array (holes iterate as undefined)
    // must classify as the same RangeError family, never a TypeError.
    if (typeof s !== 'string' || s.length === 0 || s.length > L.maxSurfaceUnits) {
      throw new RangeError(`${what} must be 1–${L.maxSurfaceUnits} code units`);
    }
  };
  boundedId(group.id, 'group');
  if (group.members.length === 0 || group.members.length > L.maxMembers) {
    throw new RangeError(`a group must have 1–${L.maxMembers} members`);
  }
  const seenIds = new Set<string>();
  for (const m of group.members) {
    // A hole in a sparse members array iterates as undefined — defensive
    // RangeError so classification stays REQUEST_INVALID, never a fault.
    if (typeof m !== 'object' || m === null) throw new RangeError('a group member must be a record');
    const mid = boundedId(m.id, 'a member');
    if (seenIds.has(mid)) throw new RangeError(`duplicate member id '${mid.slice(0, 32)}'`);
    seenIds.add(mid);
    switch (m.kind) {
      case 'token':
        boundedSurface(m.surface, `token member '${mid}' surface`);
        break;
      case 'phrase':
        if (m.surfaces.length === 0 || m.surfaces.length > L.maxPhraseSurfaces) {
          throw new RangeError(`phrase member '${mid}' must have 1–${L.maxPhraseSurfaces} surfaces`);
        }
        for (const s of m.surfaces) boundedSurface(s, `phrase member '${mid}' surface`);
        break;
      default:
        boundedSurface(m.stem, `${m.kind} member '${mid}' stem`);
        break;
    }
  }
}

export interface RawMatch {
  pos: number;
  span: number;
  member: number;
}

function crossesSentence(shard: DocumentIndexV1, start: number, span: number): boolean {
  // First bound strictly greater than `start` (lowerBound is >=, hence +1);
  // half-open: a bound at `start` or at `start + span` does not cross.
  const bounds = shard.sentenceBounds;
  const i = lowerBound(bounds, start + 1);
  return i < bounds.length && (bounds[i] as number) < start + span;
}

/**
 * All member matches of one group within a document, restricted to the given
 * half-open token ranges (null = whole document). Range pruning happens at
 * the POSTINGS level via binary search — the work is bounded by the selected
 * window, never by the document (a scrub sample over 200 tokens must not
 * walk a whole book's postings for a common word). A match counts only when
 * FULLY contained in a single range.
 *
 * PRECONDITION: `group` has passed `validateGroup` — the public kernel entry
 * (occurrences, planPassage) validates once; this matcher does not re-check.
 */
export function matchGroupInTokenRanges(
  shard: DocumentIndexV1,
  resolverFor: (mode: MatchMode) => Resolver,
  group: TermGroupSpec,
  ranges: readonly TokenRangeSpan[] | null,
): RawMatch[] {
  const out: RawMatch[] = [];
  const pushMatch = (match: RawMatch) => {
    const observed = out.length + 1;
    if (observed > OCCURRENCE_LIMITS_V1.maxOccurrences) {
      throw new CapError(
        `raw occurrence matches exceed the cap of ${OCCURRENCE_LIMITS_V1.maxOccurrences} (reached ${observed})`,
      );
    }
    out.push(match);
  };
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
            pushMatch({ pos: postings[i] as number, span: 1, member: m });
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
          if (ok) pushMatch({ pos: start, span, member: m });
        }
      }
    }
  }
  out.sort((a, b) => a.pos - b.pos || b.span - a.span || a.member - b.member);
  // Anchoring can find the same (pos, span, member) once per anchor id.
  // Compact in place so deduplication does not transiently allocate a second
  // object array at the construction cap.
  let write = 0;
  for (let read = 0; read < out.length; read++) {
    const row = out[read]!;
    const previous = write === 0 ? null : out[write - 1]!;
    if (previous && row.pos === previous.pos && row.span === previous.span && row.member === previous.member) {
      continue;
    }
    out[write++] = row;
  }
  out.length = write;
  return out;
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
  let memberCount = 0;
  let curStart = -1;
  let curEnd = -1;
  let curMembers = new Set<number>();
  const flush = () => {
    if (curStart < 0) return;
    const members = [...curMembers].sort((a, b) => a - b);
    const observed = memberCount + members.length;
    if (observed > OCCURRENCE_LIMITS_V1.maxMemberOrdinals) {
      throw new CapError(
        `occurrence member ordinals exceed the cap of ${OCCURRENCE_LIMITS_V1.maxMemberOrdinals} (reached ${observed})`,
      );
    }
    memberCount = observed;
    out.push({ pos: curStart, span: curEnd - curStart, members });
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

  for (let ord = 0; ord < snapshot.docs.length; ord++) {
    const ref = snapshot.docs[ord]!;
    if (!selection.docSet.has(ref.doc)) continue;
    const shard = shards.get(ref.doc);
    const docResolvers = resolvers.get(ref.doc);
    if (!shard || !docResolvers) throw new RangeError(`missing shard/resolvers for '${ref.doc}'`);

    const resolverFor = checkedResolverFor(ref.doc, ref.index, shard, docResolvers);
    const matches = matchGroupInTokenRanges(
      shard,
      resolverFor,
      group,
      selection.rangesByDoc.get(ref.doc) ?? null,
    );
    if (matches.length === 0) continue;

    for (const s of mergeGroupSpans(matches, group.countOverlaps)) {
      const observedOccurrences = docOrdinal.length + 1;
      if (observedOccurrences > OCCURRENCE_LIMITS_V1.maxOccurrences) {
        throw new CapError(
          `occurrences exceed the cap of ${OCCURRENCE_LIMITS_V1.maxOccurrences} (reached ${observedOccurrences})`,
        );
      }
      const observedMembers = memberOrdinals.length + s.members.length;
      if (observedMembers > OCCURRENCE_LIMITS_V1.maxMemberOrdinals) {
        throw new CapError(
          `occurrence member ordinals exceed the cap of ${OCCURRENCE_LIMITS_V1.maxMemberOrdinals} (reached ${observedMembers})`,
        );
      }
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
