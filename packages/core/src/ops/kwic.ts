/**
 * KWIC kernels — Phase 1 Milestone 3; method `kwic/1`.
 *
 * Two layers per the plan (§d.2): the NUMERIC kernel plans, sorts, and pages
 * over occurrences and emits char spans plus member evidence; a separate
 * materializer slices verified extracted texts for exactly the paged rows.
 * Binding discipline (review round 1): kernels accept only BoundShards /
 * BoundTexts contexts, pages carry their snapshot identity, and mismatches
 * throw. Sorting by L/R context compares vocabulary KEYS, never source
 * slices; final tie-breakers are (declared doc ordinal, position, span,
 * first member) so paging is stable even among identical spans. Token char
 * ends honor the overflow table via the centralized helper.
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

export interface KwicRequest {
  readonly contextTokens: number;
  readonly sort: readonly { readonly at: KwicSortKey; readonly dir: 1 | -1 }[];
  readonly page: { readonly offset: number; readonly limit: number };
}

export interface NumericKwicRow {
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
  readonly total: number;
  readonly rows: readonly NumericKwicRow[];
}

export const KWIC_MAX_PAGE = 500;

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

export function kwicPage(
  snapshot: CorpusSnapshotV1,
  bound: BoundShards,
  selection: ResolvedSelection,
  occ: NumericOccurrences,
  request: KwicRequest,
): NumericKwicPage {
  assertBoundShards(bound); // eager — forged contexts fail before any row work
  if (bound.snapshot !== snapshot.id) {
    throw new RangeError('bound shards belong to a different snapshot');
  }
  if (selection.snapshot !== snapshot.id) {
    throw new RangeError('selection is bound to a different snapshot');
  }
  if (occ.snapshot !== snapshot.id) {
    throw new RangeError('occurrences were computed under a different snapshot');
  }
  if (occ.selection !== selection.hash) {
    throw new RangeError('occurrences were computed under a different selection');
  }
  const { contextTokens, sort, page } = request;
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
    !Number.isInteger(page.limit) || page.limit <= 0 || page.limit > KWIC_MAX_PAGE
  ) {
    throw new RangeError(`page must satisfy offset >= 0, 0 < limit <= ${KWIC_MAX_PAGE}`);
  }

  const shardOf = (ord: number): DocumentIndexV1 => {
    const ref = snapshot.docs[ord];
    if (!ref) throw new RangeError(`occurrence references unknown doc ordinal ${ord}`);
    return internalShardOf(bound, ref.doc); // authenticated residency lookup
  };

  const membersOf = (i: number): number[] =>
    Array.from(
      occ.memberOrdinals.slice(occ.memberOffsets[i] as number, occ.memberOffsets[i + 1] as number),
    );

  const order = Array.from(occ.pos, (_, i) => i);
  order.sort((ia, ib) => {
    for (const s of sort) {
      let cmp = 0;
      if (s.at === 'doc') {
        cmp = (occ.docOrdinal[ia] as number) - (occ.docOrdinal[ib] as number);
      } else if (s.at === 'pos') {
        cmp = (occ.pos[ia] as number) - (occ.pos[ib] as number);
      } else {
        const ka = contextKeyAt(
          shardOf(occ.docOrdinal[ia] as number),
          occ.pos[ia] as number,
          occ.spanTokens[ia] as number,
          s.at,
        );
        const kb = contextKeyAt(
          shardOf(occ.docOrdinal[ib] as number),
          occ.pos[ib] as number,
          occ.spanTokens[ib] as number,
          s.at,
        );
        cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
      }
      if (cmp !== 0) return cmp * s.dir;
    }
    // Deterministic final tie-breakers: doc ordinal, position, span, first member.
    return (
      (occ.docOrdinal[ia] as number) - (occ.docOrdinal[ib] as number) ||
      (occ.pos[ia] as number) - (occ.pos[ib] as number) ||
      (occ.spanTokens[ia] as number) - (occ.spanTokens[ib] as number) ||
      ((occ.memberOrdinals[occ.memberOffsets[ia] as number] as number) -
        (occ.memberOrdinals[occ.memberOffsets[ib] as number] as number))
    );
  });

  const slice = order.slice(page.offset, page.offset + page.limit);
  const rows: NumericKwicRow[] = slice.map((i) => {
    const ord = occ.docOrdinal[i] as number;
    const shard = shardOf(ord);
    const pos = occ.pos[i] as number;
    const span = occ.spanTokens[i] as number;
    const leftTok = Math.max(0, pos - contextTokens);
    const rightTok = Math.min(shard.tokenTypeIds.length - 1, pos + span - 1 + contextTokens);
    return {
      docOrdinal: ord,
      pos,
      spanTokens: span,
      members: membersOf(i),
      leftCharStart: shard.startsUtf16[leftTok] as number,
      nodeCharStart: shard.startsUtf16[pos] as number,
      nodeCharEnd: tokenEndChar(shard, pos + span - 1),
      rightCharEnd: tokenEndChar(shard, rightTok),
    };
  });

  return { snapshot: snapshot.id, total: occ.pos.length, rows };
}

export interface KwicRow {
  readonly doc: string;
  readonly pos: number;
  readonly members: readonly number[];
  /** Stable evidence span in the doc's extracted text (contract KwicResult). */
  readonly node: { readonly start: number; readonly end: number };
  readonly left: string;
  readonly nodeText: string;
  readonly right: string;
}

/** Materialize page strings from VERIFIED texts — paged docs only. */
export function materializeKwicPage(
  snapshot: CorpusSnapshotV1,
  page: NumericKwicPage,
  texts: BoundTexts,
): readonly KwicRow[] {
  assertBoundTexts(texts); // eager — forged contexts fail even for empty pages
  if (page.snapshot !== snapshot.id) {
    throw new RangeError('page was planned against a different snapshot');
  }
  if (texts.snapshot !== snapshot.id) {
    throw new RangeError('texts are bound to a different snapshot');
  }
  return page.rows.map((r) => {
    const doc = snapshot.docs[r.docOrdinal]?.doc;
    if (doc === undefined) throw new RangeError(`unknown doc ordinal ${r.docOrdinal}`);
    const text = internalTextOf(texts, doc); // authenticated; throws DependencyError
    return {
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
