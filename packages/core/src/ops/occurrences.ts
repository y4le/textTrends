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
  readonly docOrdinal: Uint32Array;
  readonly pos: Uint32Array;
  readonly spanTokens: Uint32Array;
  readonly memberOffsets: Uint32Array;   // length = count + 1
  readonly memberOrdinals: Uint32Array;  // indexes into group.members
}

function validateGroup(group: TermGroupSpec): void {
  for (const m of group.members) {
    if (m.kind === 'phrase' && m.surfaces.length === 0) {
      throw new RangeError(`phrase member '${m.id}' has no surfaces`);
    }
  }
}

interface RawMatch {
  pos: number;
  span: number;
  member: number;
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

/** All member matches within one document, unfiltered by selection. */
function matchDocument(
  shard: DocumentIndexV1,
  resolverFor: (mode: MatchMode) => Resolver,
  group: TermGroupSpec,
): RawMatch[] {
  const out: RawMatch[] = [];
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
        for (let i = 0; i < postings.length; i++) {
          out.push({ pos: postings[i] as number, span: 1, member: m });
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
    const n = tokenIds.length;
    const span = member.surfaces.length;
    for (const id of resolved[anchor] as readonly LocalTypeId[]) {
      const postings = postingsFor(shard, id as number);
      for (let i = 0; i < postings.length; i++) {
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

    const resolverFor = (mode: MatchMode): Resolver => {
      const r = docResolvers.get(modeKey(mode));
      if (!r) throw new RangeError(`missing resolver for '${ref.doc}' mode ${modeKey(mode)}`);
      // The table is a structural map — the entry must PROVE it was built for
      // the requested mode, not merely be filed under its key (round-2 finding).
      if (modeKey(r.mode) !== modeKey(mode)) {
        throw new RangeError(
          `resolver filed under '${modeKey(mode)}' for '${ref.doc}' was built for '${modeKey(r.mode)}'`,
        );
      }
      if (r.shard !== shard) {
        throw new RangeError(`resolver for '${ref.doc}' is bound to a different shard`);
      }
      // The pair must be the artifact the SNAPSHOT names — a foreign
      // shard+resolver pair must not answer for this document (review round 1).
      if (r.index !== ref.index) {
        throw new RangeError(`resolver/shard pair for '${ref.doc}' does not match the snapshot ref`);
      }
      return r;
    };

    let matches = matchDocument(shard, resolverFor, group);
    const ranges = selectedRanges.get(ref.doc);
    if (ranges) {
      matches = matches.filter((m) =>
        ranges.some((r) => m.pos >= r.start && m.pos + m.span <= r.end),
      );
    }
    if (matches.length === 0) continue;

    if (group.countOverlaps) {
      for (const m of matches) {
        docOrdinal.push(ord);
        pos.push(m.pos);
        spanTokens.push(m.span);
        memberOrdinals.push(m.member);
        memberOffsets.push(memberOrdinals.length);
      }
      continue;
    }

    // Covered-token union: merge overlapping matched spans; report every
    // contributing member (sorted, deduplicated) per emitted span.
    let curStart = -1;
    let curEnd = -1;
    let curMembers = new Set<number>();
    const flush = () => {
      if (curStart < 0) return;
      docOrdinal.push(ord);
      pos.push(curStart);
      spanTokens.push(curEnd - curStart);
      const members = [...curMembers].sort((a, b) => a - b);
      for (const m of members) memberOrdinals.push(m);
      memberOffsets.push(memberOrdinals.length);
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
  }

  return {
    docOrdinal: Uint32Array.from(docOrdinal),
    pos: Uint32Array.from(pos),
    spanTokens: Uint32Array.from(spanTokens),
    memberOffsets: Uint32Array.from(memberOffsets),
    memberOrdinals: Uint32Array.from(memberOrdinals),
  };
}
