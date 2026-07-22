/**
 * KWIC kernels — method `kwic/2` (concordance amendment, 2026-07-22).
 *
 * `kwic/2` merges up to `MAX_KWIC_TRACKS` term groups into ONE globally-ordered
 * concordance and can order by proximity to an axis position. Two layers, as in
 * `kwic/1`: the NUMERIC kernel plans, orders, and pages over per-track
 * occurrences and emits char spans + member evidence tagged by TRACK ORDINAL; a
 * separate materializer slices verified texts for exactly the paged rows and
 * binds the public series/group identity. UI identities never enter the numeric
 * kernel; text is sliced only for the ≤ KWIC_MAX_PAGE paged rows.
 *
 * Order (planner ruling req_consult_1458236f5790b275): with a `center`, primary
 * key is ascending distance from the center's GLOBAL declared-sequence position
 * (`sequenceTokenBase + occurrence start`), then the caller's `sort` keys, then
 * deterministic finals (doc ordinal, start, span, track ordinal, member
 * ordinals). WITHOUT a center the caller's `sort` is primary — reading order is
 * the caller's `[doc,pos]` request, never a core override. Paging is an EXACT
 * bounded top-K: the page is the true global slice; a lossy per-track prefix or
 * a full five-way sort is not used.
 */

import { tokenEndChar, type DocumentIndexV1 } from '../index/build.ts';
import {
  assertBoundShards,
  assertBoundTexts,
  internalShardOf,
  internalTextOf,
  type BoundShards,
  type BoundTexts,
} from './binding.ts';
import type { NumericOccurrences } from './occurrences.ts';
import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import type { ResolvedSelection } from '../snapshot/selection.ts';

export type KwicSortKey = 'L3' | 'L2' | 'L1' | 'R1' | 'R2' | 'R3' | 'doc' | 'pos';
const SORT_KEYS: ReadonlySet<string> = new Set(['L3', 'L2', 'L1', 'R1', 'R2', 'R3', 'doc', 'pos']);

/** One authority for the max compared/concordance terms (the store's MAX_SERIES
 *  and the protocol track cap both derive from this). */
export const MAX_KWIC_TRACKS = 5;
export const KWIC_MAX_PAGE = 500;

export interface KwicRequest {
  readonly contextTokens: number;
  /** Optional axis position; occurrences are ordered by distance from its
   *  GLOBAL declared-sequence position. When absent, `sort` is the primary key. */
  readonly center?: { readonly doc: string; readonly token: number };
  readonly sort: readonly { readonly at: KwicSortKey; readonly dir: 1 | -1 }[];
  readonly page: { readonly offset: number; readonly limit: number };
}

export interface NumericKwicRow {
  /** Which track (index into the request's ordered track table) produced this. */
  readonly trackOrdinal: number;
  readonly docOrdinal: number;
  readonly pos: number;
  readonly spanTokens: number;
  /** Contributing member ordinals — occurrence evidence, preserved. */
  readonly members: readonly number[];
  readonly leftCharStart: number;
  readonly nodeCharStart: number;
  readonly nodeCharEnd: number;
  readonly rightCharEnd: number;
}

export interface NumericKwicPage {
  /** The snapshot these rows were planned against — verified downstream. */
  readonly snapshot: CorpusSnapshotV1['id'];
  /** Sum of ALL tracks' occurrence counts (each track/occurrence is one row). */
  readonly total: number;
  readonly rows: readonly NumericKwicRow[];
}

function contextKeyAt(
  shard: DocumentIndexV1,
  pos: number,
  span: number,
  at: Exclude<KwicSortKey, 'doc' | 'pos'>,
): string {
  const offset = Number(at.slice(1));
  const t = at.startsWith('L') ? pos - offset : pos + span - 1 + offset;
  if (t < 0 || t >= shard.tokenTypeIds.length) return ''; // absent context sorts first
  return shard.vocabulary[shard.tokenTypeIds[t] as number] as string;
}

/** A (track, occurrence-index) candidate — the numeric kernel's unit of order. */
interface Candidate {
  readonly t: number;
  readonly i: number;
}

/**
 * The numeric KWIC plan over 1..MAX_KWIC_TRACKS per-track occurrence sets.
 * `tracks[t]` are the occurrences of track `t` (same snapshot + selection). The
 * page is materialized only for the retained top-K rows.
 */
export function kwicPage(
  snapshot: CorpusSnapshotV1,
  bound: BoundShards,
  selection: ResolvedSelection,
  tracks: readonly NumericOccurrences[],
  request: KwicRequest,
): NumericKwicPage {
  assertBoundShards(bound); // eager — forged contexts fail before any row work
  if (bound.snapshot !== snapshot.id) throw new RangeError('bound shards belong to a different snapshot');
  if (selection.snapshot !== snapshot.id) throw new RangeError('selection is bound to a different snapshot');
  if (tracks.length < 1 || tracks.length > MAX_KWIC_TRACKS) {
    throw new RangeError(`kwic requires 1..${MAX_KWIC_TRACKS} tracks`);
  }
  for (const occ of tracks) {
    if (occ.snapshot !== snapshot.id) throw new RangeError('occurrences were computed under a different snapshot');
    if (occ.selection !== selection.hash) throw new RangeError('occurrences were computed under a different selection');
  }

  const { contextTokens, center, sort, page } = request;
  if (!Number.isInteger(contextTokens) || contextTokens < 0) {
    throw new RangeError('contextTokens must be a non-negative integer');
  }
  for (const s of sort) {
    if (!SORT_KEYS.has(s.at) || (s.dir !== 1 && s.dir !== -1)) {
      throw new RangeError(`invalid sort entry ${JSON.stringify(s)}`);
    }
  }
  if (
    !Number.isInteger(page.offset) || page.offset < 0 ||
    !Number.isInteger(page.limit) || page.limit <= 0 || page.limit > KWIC_MAX_PAGE ||
    !Number.isSafeInteger(page.offset + page.limit)
  ) {
    throw new RangeError(`page must satisfy offset >= 0, 0 < limit <= ${KWIC_MAX_PAGE}, safe offset+limit`);
  }

  const baseOf = (ord: number): number => {
    const ref = snapshot.docs[ord];
    if (!ref) throw new RangeError(`occurrence references unknown doc ordinal ${ord}`);
    return ref.sequenceTokenBase;
  };
  const shardOf = (ord: number): DocumentIndexV1 => internalShardOf(bound, snapshot.docs[ord]!.doc);

  // Resolve the center (if any) to a GLOBAL declared-sequence anchor. A stale
  // center is rejected, never clamped.
  let centerGlobal: number | null = null;
  if (center !== undefined) {
    const ord = snapshot.docs.findIndex((d) => d.doc === center.doc);
    if (ord < 0) throw new RangeError(`center doc '${center.doc}' is not in the snapshot`);
    const ref = snapshot.docs[ord]!;
    if (!Number.isInteger(center.token) || center.token < 0 || center.token >= ref.tokenCount) {
      throw new RangeError(`center token ${center.token} out of range [0, ${ref.tokenCount})`);
    }
    centerGlobal = ref.sequenceTokenBase + center.token;
  }

  const globalStart = (c: Candidate): number => baseOf(tracks[c.t]!.docOrdinal[c.i] as number) + (tracks[c.t]!.pos[c.i] as number);
  const membersOf = (t: number, i: number): Uint32Array => {
    const occ = tracks[t]!;
    return occ.memberOrdinals.slice(occ.memberOffsets[i] as number, occ.memberOffsets[i + 1] as number);
  };

  /** Full comparator: negative when `a` ranks before `b`. */
  const cmp = (a: Candidate, b: Candidate): number => {
    if (centerGlobal !== null) {
      const d = Math.abs(globalStart(a) - centerGlobal) - Math.abs(globalStart(b) - centerGlobal);
      if (d !== 0) return d;
    }
    const oa = tracks[a.t]!;
    const ob = tracks[b.t]!;
    for (const s of sort) {
      let c = 0;
      if (s.at === 'doc') {
        c = (oa.docOrdinal[a.i] as number) - (ob.docOrdinal[b.i] as number);
      } else if (s.at === 'pos') {
        c = (oa.pos[a.i] as number) - (ob.pos[b.i] as number);
      } else {
        const ka = contextKeyAt(shardOf(oa.docOrdinal[a.i] as number), oa.pos[a.i] as number, oa.spanTokens[a.i] as number, s.at);
        const kb = contextKeyAt(shardOf(ob.docOrdinal[b.i] as number), ob.pos[b.i] as number, ob.spanTokens[b.i] as number, s.at);
        c = ka < kb ? -1 : ka > kb ? 1 : 0;
      }
      if (c !== 0) return c * s.dir;
    }
    // Deterministic finals: doc ordinal, start, span, track ordinal, members.
    let c =
      (oa.docOrdinal[a.i] as number) - (ob.docOrdinal[b.i] as number) ||
      (oa.pos[a.i] as number) - (ob.pos[b.i] as number) ||
      (oa.spanTokens[a.i] as number) - (ob.spanTokens[b.i] as number) ||
      a.t - b.t;
    if (c !== 0) return c;
    const ma = membersOf(a.t, a.i);
    const mb = membersOf(b.t, b.i);
    const n = Math.min(ma.length, mb.length);
    for (let k = 0; k < n; k++) {
      c = (ma[k] as number) - (mb[k] as number);
      if (c !== 0) return c;
    }
    return ma.length - mb.length;
  };

  // Exact bounded top-K: retain the K = offset+limit best under `cmp` in a
  // max-heap (root = worst retained), scanning every candidate track by track;
  // then sort only the retained rows and slice at `offset`.
  const K = page.offset + page.limit;
  const heap: Candidate[] = [];
  const swap = (i: number, j: number) => { const x = heap[i]!; heap[i] = heap[j]!; heap[j] = x; };
  const siftUp = (n: number) => {
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (cmp(heap[n]!, heap[p]!) > 0) { swap(n, p); n = p; } else break;
    }
  };
  const siftDown = (n: number) => {
    const len = heap.length;
    for (;;) {
      const l = 2 * n + 1;
      const r = l + 1;
      let worst = n;
      if (l < len && cmp(heap[l]!, heap[worst]!) > 0) worst = l;
      if (r < len && cmp(heap[r]!, heap[worst]!) > 0) worst = r;
      if (worst === n) break;
      swap(n, worst);
      n = worst;
    }
  };
  let total = 0;
  for (let t = 0; t < tracks.length; t++) {
    const count = tracks[t]!.pos.length;
    total += count;
    for (let i = 0; i < count; i++) {
      const cand: Candidate = { t, i };
      if (heap.length < K) {
        heap.push(cand);
        siftUp(heap.length - 1);
      } else if (cmp(cand, heap[0]!) < 0) {
        heap[0] = cand;
        siftDown(0);
      }
    }
  }
  const ordered = heap.sort(cmp);
  const slice = ordered.slice(page.offset, page.offset + page.limit);

  const rows: NumericKwicRow[] = slice.map(({ t, i }) => {
    const occ = tracks[t]!;
    const ord = occ.docOrdinal[i] as number;
    const shard = shardOf(ord);
    const pos = occ.pos[i] as number;
    const span = occ.spanTokens[i] as number;
    const leftTok = Math.max(0, pos - contextTokens);
    const rightTok = Math.min(shard.tokenTypeIds.length - 1, pos + span - 1 + contextTokens);
    return {
      trackOrdinal: t,
      docOrdinal: ord,
      pos,
      spanTokens: span,
      members: Array.from(membersOf(t, i)),
      leftCharStart: shard.startsUtf16[leftTok] as number,
      nodeCharStart: shard.startsUtf16[pos] as number,
      nodeCharEnd: tokenEndChar(shard, pos + span - 1),
      rightCharEnd: tokenEndChar(shard, rightTok),
    };
  });

  return { snapshot: snapshot.id, total, rows };
}

/** The ordered track identity table the materializer binds rows against — the
 *  same order the numeric plan's `trackOrdinal` indexes. */
export interface KwicTrackIdentity {
  readonly seriesId: string;
  readonly groupId: string;
}

export interface KwicRow {
  /** The track that produced this row — self-describing evidence when several
   *  groups share one result. */
  readonly seriesId: string;
  readonly groupId: string;
  readonly doc: string;
  readonly pos: number;
  readonly members: readonly number[];
  /** Stable evidence span in the doc's extracted text (contract KwicResult). */
  readonly node: { readonly start: number; readonly end: number };
  readonly left: string;
  readonly nodeText: string;
  readonly right: string;
}

/** Materialize page strings from VERIFIED texts — paged docs only. The track
 *  table must be the SAME order the numeric plan indexed; every `trackOrdinal`
 *  is validated against it. */
export function materializeKwicPage(
  snapshot: CorpusSnapshotV1,
  page: NumericKwicPage,
  texts: BoundTexts,
  tracks: readonly KwicTrackIdentity[],
): readonly KwicRow[] {
  assertBoundTexts(texts); // eager — forged contexts fail even for empty pages
  if (page.snapshot !== snapshot.id) throw new RangeError('page was planned against a different snapshot');
  if (texts.snapshot !== snapshot.id) throw new RangeError('texts are bound to a different snapshot');
  return page.rows.map((r) => {
    const track = tracks[r.trackOrdinal];
    if (track === undefined) throw new RangeError(`row references unknown track ordinal ${r.trackOrdinal}`);
    const doc = snapshot.docs[r.docOrdinal]?.doc;
    if (doc === undefined) throw new RangeError(`unknown doc ordinal ${r.docOrdinal}`);
    const text = internalTextOf(texts, doc); // authenticated; throws DependencyError
    return {
      seriesId: track.seriesId,
      groupId: track.groupId,
      doc,
      pos: r.pos,
      members: r.members,
      node: { start: r.nodeCharStart, end: r.nodeCharEnd },
      left: text.slice(r.leftCharStart, r.nodeCharStart),
      nodeText: text.slice(r.nodeCharStart, r.nodeCharEnd),
      right: text.slice(r.nodeCharEnd, r.rightCharEnd),
    };
  });
}
