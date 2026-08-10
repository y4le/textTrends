import { describe, expect, it } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { buildDocumentIndex, createDocumentIndex, type DocumentIndexV1 } from '../src/index/build.ts';
import { bindShards, bindTexts, DependencyError, type BoundShards, type BoundTexts } from '../src/ops/binding.ts';
import { validateShardStructure } from '../src/index/build.ts';
import { kwicPage, KWIC_MAX_PAGE, materializeKwicPage, type KwicSortKey, type NumericKwicPage } from '../src/ops/kwic.ts';

// kwic/2 is multi-track; these single-track wrappers keep the kwic/1 legacy
// tests terse. New multi-track/proximity behavior is covered separately below.
function kwic1(
  snapshot: Parameters<typeof kwicPage>[0], bound: Parameters<typeof kwicPage>[1],
  sel: Parameters<typeof kwicPage>[2], occ: Parameters<typeof kwicPage>[3][number],
  req: Parameters<typeof kwicPage>[4],
) { return kwicPage(snapshot, bound, sel, [occ], req); }
function matk1(
  snapshot: Parameters<typeof materializeKwicPage>[0], page: Parameters<typeof materializeKwicPage>[1],
  texts: Parameters<typeof materializeKwicPage>[2],
) { return materializeKwicPage(snapshot, page, texts, [{ seriesId: 's', groupId: 'g' }]); }
import { occurrences, type NumericOccurrences, type TermGroupSpec } from '../src/ops/occurrences.ts';
import { trend } from '../src/ops/trend.ts';
import { buildResolver, modeKey, type MatchMode, type Resolver } from '../src/resolve/fold.ts';
import { segment } from '../src/segment/intl.ts';
import { composeSnapshot, makeReadyDocument, type CorpusSnapshotV1 } from '../src/snapshot/compose.ts';
import { resolveSelection, type ResolvedSelection } from '../src/snapshot/selection.ts';

const R = DEFAULT_INDEX_RECIPE;
const GEN = 'g' as BuildGeneration;
const FOLD: MatchMode = { case: 'folded', diacritics: 'sensitive' };

interface World {
  snapshot: CorpusSnapshotV1;
  shards: Map<string, DocumentIndexV1>;
  resolvers: Map<string, Map<string, Resolver>>;
  bound: BoundShards;
  texts: BoundTexts;
  all: ResolvedSelection;
}

async function world(texts: Record<string, string>, expected?: string[]): Promise<World> {
  const shards = new Map<string, DocumentIndexV1>();
  const resolvers = new Map<string, Map<string, Resolver>>();
  const textMap = new Map<string, string>();
  const ready = new Map();
  const ids = Object.keys(texts) as ProjectDocId[];
  for (const id of ids) {
    const text = texts[id] as string;
    textMap.set(id, text);
    const shard = await createDocumentIndex(text, await segment(text, 'en'), R);
    shards.set(id, shard);
    resolvers.set(id, new Map([[modeKey(FOLD), await buildResolver(shard, R, FOLD)]]));
    ready.set(id, await makeReadyDocument(id, shard));
  }
  const snapshot = await composeSnapshot(GEN, (expected ?? ids) as ProjectDocId[], ready);
  const bound = await bindShards(snapshot, shards);
  const boundTexts = await bindTexts(snapshot, bound, textMap);
  const all = await resolveSelection(snapshot, { docs: ids });
  return { snapshot, shards, resolvers, bound, texts: boundTexts, all };
}

const wolfGroup: TermGroupSpec = {
  id: 'g1',
  members: [{ id: 'm1', kind: 'token', surface: 'wolf', match: FOLD }],
  countOverlaps: false,
};
const direWolfGroup = (countOverlaps: boolean): TermGroupSpec => ({
  id: 'g2',
  members: [
    { id: 'p', kind: 'phrase', elements: [{ kind: 'token', surface: 'dire' }, { kind: 'token', surface: 'wolf' }], match: FOLD, crossSentence: false },
    { id: 't', kind: 'token', surface: 'wolf', match: FOLD },
  ],
  countOverlaps,
});
const SORT_POS = [{ at: 'pos', dir: 1 }] as const;

describe('trend/1', () => {
  it('bins restart per document; counts land by start token; final bin may be short', async () => {
    const w = await world({ a: 'wolf b c d wolf', b: 'x wolf y' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const t = trend(w.snapshot, w.all, occ, { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } });
    expect(Array.from(t.binTokens)).toEqual([2, 2, 1, 0, 1, 1, 1, 0]);
    expect(Array.from(t.count)).toEqual([1, 0, 1, 0, 0, 1, 0, 0]);
    expect(t.ratePer10k[0]).toBeCloseTo((1 / 2) * 10_000, 6);
    expect(t.bins).toEqual({ mode: 'per-doc', count: 4 });
    expect(Array.from(t.rowOffsets)).toEqual([0, 4, 8]);
    expect(t.order).toEqual(['a', 'b']);
    expect(t.sequenceBases).toBeNull(); // document-relative carries no bases
    // Full extents parallel to order — the coordinate geometry, NOT the
    // selected denominator (binTokens).
    expect(t.docTokenCount).toEqual([5, 3]);
  });

  it('declared-sequence differs exactly by carrying bases', async () => {
    const w = await world({ a: 'wolf b c', b: 'x wolf y' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const rel = trend(w.snapshot, w.all, occ, { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } });
    const seq = trend(w.snapshot, w.all, occ, { coordinate: 'declared-sequence', bins: { mode: 'per-doc', count: 4 } });
    expect(Array.from(seq.count)).toEqual(Array.from(rel.count));
    expect(seq.sequenceBases).toEqual([0, 3]);
    expect(rel.sequenceBases).toBeNull();
  });

  it('a phrase occurrence counts once, in its start-token bin', async () => {
    // 'dire' ends bin 0, 'wolf' starts bin 1 — the span counts in bin 0 (start rule).
    const w = await world({ a: 'x dire wolf y' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, direWolfGroup(false));
    const t = trend(w.snapshot, w.all, occ, { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } });
    expect(Array.from(t.count)).toEqual([0, 1, 0, 0]);
  });

  it('overlap mode changes trend counts (union vs raw)', async () => {
    const w = await world({ a: 'the dire wolf howled' });
    const union = occurrences(w.snapshot, w.shards, w.resolvers, w.all, direWolfGroup(false));
    const raw = occurrences(w.snapshot, w.shards, w.resolvers, w.all, direWolfGroup(true));
    const req = { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } as const;
    expect(Array.from(trend(w.snapshot, w.all, union, req).count)).toEqual([0, 1, 0, 0]);
    expect(Array.from(trend(w.snapshot, w.all, raw, req).count)).toEqual([0, 1, 1, 0]);
  });

  it('missing (uncomposed) documents simply have no rows; bases skip them', async () => {
    const w = await world({ a: 'wolf here', c: 'wolf there' }, ['a', 'b', 'c']);
    expect(w.snapshot.missingDocs).toEqual(['b']);
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const t = trend(w.snapshot, w.all, occ, { coordinate: 'declared-sequence', bins: { mode: 'per-doc', count: 4 } });
    expect(t.order).toEqual(['a', 'c']);
    expect(t.sequenceBases).toEqual([0, 2]); // c's base counts only composed a
    expect(Array.from(t.count)).toEqual([1, 0, 0, 0, 1, 0, 0, 0]);
  });

  it('empty documents contribute an honest empty row span', async () => {
    const w = await world({ a: '' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const t = trend(w.snapshot, w.all, occ, { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } });
    expect(Array.from(t.binTokens)).toEqual([]);
    expect(Array.from(t.ratePer10k)).toEqual([]);
    expect(Array.from(t.rowOffsets)).toEqual([0, 0]);
  });

  it('selection ranges shrink denominators to selected tokens only', async () => {
    const w = await world({ a: 'wolf b c d wolf f' });
    const sel = await resolveSelection(w.snapshot, {
      docs: ['a'] as ProjectDocId[],
      ranges: [{ doc: 'a' as ProjectDocId, tokens: { start: 0 as never, end: 3 as never } }],
    });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, sel, wolfGroup);
    const t = trend(w.snapshot, sel, occ, { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } });
    expect(Array.from(t.binTokens)).toEqual([2, 1, 0, 0]);
    expect(t.ratePer10k[2]).toBe(0);
  });

  it('multi-doc, multi-range selections keep per-doc denominators and counts aligned', async () => {
    const w = await world({ a: 'wolf b c d wolf f', b: 'x wolf y z' });
    const sel = await resolveSelection(w.snapshot, {
      docs: ['a', 'b'] as ProjectDocId[],
      ranges: [
        { doc: 'a' as ProjectDocId, tokens: { start: 0 as never, end: 2 as never } },
        { doc: 'a' as ProjectDocId, tokens: { start: 4 as never, end: 6 as never } },
        { doc: 'b' as ProjectDocId, tokens: { start: 1 as never, end: 2 as never } },
      ],
    });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, sel, wolfGroup);
    const t = trend(w.snapshot, sel, occ, { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } });
    // a (6 tokens, width 2): selected denominators 2+0+2+0;
    // b (4 tokens, width 1): selected denominators 0+1+0+0.
    expect(t.order).toEqual(['a', 'b']);
    expect(Array.from(t.binTokens)).toEqual([2, 0, 2, 0, 0, 1, 0, 0]);
    expect(Array.from(t.count)).toEqual([1, 0, 1, 0, 0, 1, 0, 0]);
  });

  it('supports a fixed token span with variable rows and a short final bin', async () => {
    const text = Array.from({ length: 501 }, (_, index) => index === 0 ? 'wolf' : 'x').join(' ');
    const w = await world({ a: text });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const t = trend(w.snapshot, w.all, occ, {
      coordinate: 'declared-sequence',
      bins: { mode: 'fixed-tokens', count: 250 },
    });
    expect(t.bins).toEqual({ mode: 'fixed-tokens', count: 250 });
    expect(Array.from(t.rowOffsets)).toEqual([0, 3]);
    expect(Array.from(t.binStartToken)).toEqual([0, 250, 500]);
    expect(Array.from(t.binTokens)).toEqual([250, 250, 1]);
    expect(Array.from(t.count)).toEqual([1, 0, 0]);
  });

  it('refuses either bin mode when the resolved result would exceed the row cap', async () => {
    const documents = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`d${index}`, 'x']),
    );
    const w = await world(documents);
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    expect(() => trend(w.snapshot, w.all, occ, {
      coordinate: 'document-relative',
      bins: { mode: 'per-doc', count: 200 },
    })).toThrow(/produce 4200 rows; the limit is 4000/);
    const wideSnapshot = {
      ...w.snapshot,
      docs: w.snapshot.docs.map((doc) => ({ ...doc, tokenCount: 50_000 })),
    };
    expect(() => trend(wideSnapshot, w.all, occ, {
      coordinate: 'document-relative',
      bins: { mode: 'fixed-tokens', count: 250 },
    })).toThrow(/produce 4200 rows; the limit is 4000/);
  });

  it('rejects foreign selections, bad bin counts, and unknown coordinates', async () => {
    const w1 = await world({ a: 'x' });
    const w2 = await world({ a: 'x y' });
    const occ = occurrences(w1.snapshot, w1.shards, w1.resolvers, w1.all, wolfGroup);
    expect(() => trend(w1.snapshot, w2.all, occ, { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } }))
      .toThrow(/different snapshot/);
    expect(() => trend(w1.snapshot, w1.all, occ, { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 3 } }))
      .toThrow(/integer from 4 to 200/);
    expect(() =>
      trend(w1.snapshot, w1.all, occ, { coordinate: 'bogus' as never, bins: { mode: 'per-doc', count: 4 } }),
    ).toThrow(/unknown trend coordinate/);
  });
});

describe('kwic/1 planning and materialization', () => {
  it('produces exact spans, preserves member evidence and the stable node range', async () => {
    const w = await world({ a: 'the dire wolf howled' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, direWolfGroup(false));
    const page = kwic1(w.snapshot, w.bound, w.all, occ, {
      contextTokens: 1, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    expect(page.snapshot).toBe(w.snapshot.id);
    const rows = matk1(w.snapshot, page, w.texts);
    expect(rows[0]).toEqual({
      seriesId: 's',
      groupId: 'g',
      doc: 'a',
      pos: 1,
      members: [0, 1],                     // occurrence CSR evidence survives paging
      node: { start: 4, end: 13 },         // stable char range for 'dire wolf'
      left: 'the ',
      nodeText: 'dire wolf',
      right: ' howled',
    });
  });

  it('normalized vocabulary keys never replace raw node text', async () => {
    const w = await world({ a: 'he said isn’t twice' });
    const g: TermGroupSpec = {
      id: 'g', members: [{ id: 'm', kind: 'token', surface: "isn't", match: FOLD }],
      countOverlaps: false,
    };
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, g);
    const page = kwic1(w.snapshot, w.bound, w.all, occ, {
      contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    const rows = matk1(w.snapshot, page, w.texts);
    expect(rows[0]!.nodeText).toBe('isn’t'); // raw source, curly apostrophe intact
  });

  it('handles astral characters in context and node spans', async () => {
    const w = await world({ a: 'I 😀 saw the wolf 😀 again' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const page = kwic1(w.snapshot, w.bound, w.all, occ, {
      contextTokens: 2, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    const rows = matk1(w.snapshot, page, w.texts);
    expect(rows[0]!.nodeText).toBe('wolf');
    expect(rows[0]!.left).toContain('saw');
    expect(rows[0]!.right).toContain('again'); // emoji are not word-like tokens; spans stay valid
  });

  it('sorts by every L/R key with vocabulary-key comparison', async () => {
    // tokens: alpha beta wolf(2) gamma delta | zeta eta wolf(7) theta iota
    // Context keys: first wolf L1=beta L2=alpha L3=(absent) R1=gamma R2=delta R3=zeta
    //              second wolf L1=eta L2=zeta L3=delta R1=theta R2=iota R3=(absent)
    const w = await world({
      a: 'alpha beta wolf gamma delta. zeta eta wolf theta iota.',
    });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const orderFor = async (at: 'L1'|'L2'|'L3'|'R1'|'R2'|'R3', dir: 1 | -1) => {
      const page = kwic1(w.snapshot, w.bound, w.all, occ, {
        contextTokens: 3, sort: [{ at, dir }], page: { offset: 0, limit: 10 },
      });
      return page.rows.map((r) => r.pos);
    };
    expect(await orderFor('L1', 1)).toEqual([2, 7]);  // beta < eta
    expect(await orderFor('L2', 1)).toEqual([2, 7]);  // alpha < zeta
    expect(await orderFor('L3', 1)).toEqual([2, 7]);  // absent('') < delta
    expect(await orderFor('L3', -1)).toEqual([7, 2]);
    expect(await orderFor('R1', 1)).toEqual([2, 7]);  // gamma < theta
    expect(await orderFor('R1', -1)).toEqual([7, 2]);
    expect(await orderFor('R2', 1)).toEqual([2, 7]);  // delta < iota
    expect(await orderFor('R3', 1)).toEqual([7, 2]);  // absent('') < zeta
  });

  it('pages are stable and disjoint across offsets, including tied sort keys', async () => {
    // Every occurrence has identical context ('x wolf x'), so ordering falls
    // entirely to the final tie-breakers — exactly what paging stability needs.
    const text = Array.from({ length: 7 }, () => 'x wolf x').join(' ');
    const w = await world({ a: text });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const req = (offset: number) => ({
      contextTokens: 1, sort: [{ at: 'L1', dir: 1 }] as const, page: { offset, limit: 3 },
    });
    const p0 = kwic1(w.snapshot, w.bound, w.all, occ, req(0));
    const p1 = kwic1(w.snapshot, w.bound, w.all, occ, req(3));
    const p2 = kwic1(w.snapshot, w.bound, w.all, occ, req(6));
    const all = [...p0.rows, ...p1.rows, ...p2.rows].map((r) => r.pos);
    expect(all).toEqual([...all].sort((x, y) => x - y)); // ordered continuation
    expect(new Set(all).size).toBe(7);                    // disjoint and complete
    expect(p0.total).toBe(7);
  });

  it('clamps context at document edges and spans 300-char overflow tokens via tokenEndChar', async () => {
    const long = 'a'.repeat(300);
    const w = await world({ a: `wolf ${long} wolf` });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const page = kwic1(w.snapshot, w.bound, w.all, occ, {
      contextTokens: 2, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    const rows = matk1(w.snapshot, page, w.texts);
    expect(rows[0]!.left).toBe('');           // clamped at document start
    expect(rows[0]!.right).toContain(long);   // overflow token fully spanned
    expect(rows[1]!.left).toContain(long);
    expect(rows[1]!.right).toBe('');          // clamped at document end
  });

  it('tokenCharLength guards its position domain', async () => {
    const w = await world({ a: 'one two' });
    const shard = w.shards.get('a')!;
    const { tokenCharLength } = await import('../src/index/build.ts');
    expect(tokenCharLength(shard, 0)).toBe(3);
    expect(() => tokenCharLength(shard, -1)).toThrow(RangeError);
    expect(() => tokenCharLength(shard, 0.5)).toThrow(RangeError);
    expect(() => tokenCharLength(shard, 2)).toThrow(RangeError); // == tokenCount
  });

  it('breaks full (doc,pos,span) ties by first member, stable across pages', async () => {
    // Raw mode: two members matching the SAME token give identical (doc,pos,span)
    // rows distinguishable only by member ordinal.
    const w = await world({ a: 'winterfell wolf winterfell' });
    const g: TermGroupSpec = {
      id: 'g',
      members: [
        { id: 'm0', kind: 'prefix', stem: 'winterfell', match: FOLD },
        { id: 'm1', kind: 'token', surface: 'winterfell', match: FOLD },
      ],
      countOverlaps: true,
    };
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, g);
    const req = (offset: number) => ({
      contextTokens: 0, sort: [] as const, page: { offset, limit: 3 },
    });
    const p0 = kwic1(w.snapshot, w.bound, w.all, occ, req(0));
    const p1 = kwic1(w.snapshot, w.bound, w.all, occ, req(3));
    const key = (r: { pos: number; members: readonly number[] }) => `${r.pos}:${r.members[0]}`;
    const all = [...p0.rows, ...p1.rows].map(key);
    expect(all).toEqual(['0:0', '0:1', '2:0', '2:1']); // pos asc, then member asc, across the page break
  });

  it('locks the page cap boundary at 500/501', async () => {
    const w = await world({ a: 'wolf' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const mk = (limit: number) =>
      kwic1(w.snapshot, w.bound, w.all, occ, { contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit } });
    expect(() => mk(KWIC_MAX_PAGE)).not.toThrow();
    expect(() => mk(KWIC_MAX_PAGE + 1)).toThrow(/page must satisfy/);
  });

  it('rejects invalid sort entries', async () => {
    const w = await world({ a: 'wolf' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    expect(() =>
      kwic1(w.snapshot, w.bound, w.all, occ, {
        contextTokens: 0,
        sort: [{ at: 'bogus' as never, dir: 0 as never }],
        page: { offset: 0, limit: 10 },
      }),
    ).toThrow(/invalid sort entry/);
  });
});

describe('kwic/2 merged multi-track + proximity', () => {
  const foxGroup: TermGroupSpec = {
    id: 'gfox', members: [{ id: 'mf', kind: 'token', surface: 'fox', match: FOLD }], countOverlaps: false,
  };
  const TRACKS = [{ seriesId: 'wolf', groupId: wolfGroup.id }, { seriesId: 'fox', groupId: foxGroup.id }];
  const req = (extra: Partial<Parameters<typeof kwicPage>[4]> = {}) => ({
    contextTokens: 1,
    sort: [{ at: 'doc' as const, dir: 1 as const }, { at: 'pos' as const, dir: 1 as const }],
    page: { offset: 0, limit: 10 },
    ...extra,
  });
  // a: wolf@0 a b fox@3 c wolf@5 (base 0) | b: x fox@1 wolf@2 y (base 6)
  // globals: wolf 0/5/8, fox 3/7.
  const twoDoc = () => world({ a: 'wolf a b fox c wolf', b: 'x fox wolf y' });
  const tracksOf = (w: Awaited<ReturnType<typeof world>>) => [
    occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup),
    occurrences(w.snapshot, w.shards, w.resolvers, w.all, foxGroup),
  ];

  it('orders by distance from the center GLOBAL position, tagging each row and crossing docs', async () => {
    const w = await twoDoc();
    const page = kwicPage(w.snapshot, w.bound, w.all, tracksOf(w), req({ center: { doc: 'b', token: 0 } }));
    expect(page.total).toBe(5); // 3 wolf + 2 fox
    const rows = materializeKwicPage(w.snapshot, page, w.texts, TRACKS);
    // center global = base(b)+0 = 6. distances: a.wolf@5→1, b.fox@1→1 (tie: left
    // doc wins), b.wolf@2→2, a.fox@3→3, a.wolf@0→6.
    expect(rows.map((r) => [r.doc, r.pos, r.seriesId])).toEqual([
      ['a', 5, 'wolf'],
      ['b', 1, 'fox'],
      ['b', 2, 'wolf'],
      ['a', 3, 'fox'],
      ['a', 0, 'wolf'],
    ]);
  });

  it('without a center, the caller sort is primary — merged reading order, NOT proximity', async () => {
    const w = await twoDoc();
    const page = kwicPage(w.snapshot, w.bound, w.all, tracksOf(w), req()); // no center
    const rows = materializeKwicPage(w.snapshot, page, w.texts, TRACKS);
    expect(rows.map((r) => [r.doc, r.pos, r.seriesId])).toEqual([
      ['a', 0, 'wolf'],
      ['a', 3, 'fox'],
      ['a', 5, 'wolf'],
      ['b', 1, 'fox'],
      ['b', 2, 'wolf'],
    ]);
  });

  it('a token matched by two tracks yields two independently-tagged rows (no cross-track dedup)', async () => {
    const w = await world({ a: 'the wolf ran' });
    const wolfA: TermGroupSpec = { id: 'ga', members: [{ id: 'x', kind: 'token', surface: 'wolf', match: FOLD }], countOverlaps: false };
    const wolfB: TermGroupSpec = { id: 'gb', members: [{ id: 'y', kind: 'token', surface: 'wolf', match: FOLD }], countOverlaps: false };
    const occs = [
      occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfA),
      occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfB),
    ];
    const page = kwicPage(w.snapshot, w.bound, w.all, occs, req());
    expect(page.total).toBe(2); // each track contributes one row for the same span
    const rows = materializeKwicPage(w.snapshot, page, w.texts, [{ seriesId: 'A', groupId: 'ga' }, { seriesId: 'B', groupId: 'gb' }]);
    expect(rows.map((r) => [r.pos, r.seriesId])).toEqual([[1, 'A'], [1, 'B']]);
  });

  it('exact top-K paging partitions the true merged order continuously', async () => {
    const w = await twoDoc();
    const occs = tracksOf(w);
    const full = kwicPage(w.snapshot, w.bound, w.all, occs, req({ center: { doc: 'b', token: 0 }, page: { offset: 0, limit: 10 } }));
    const p0 = kwicPage(w.snapshot, w.bound, w.all, occs, req({ center: { doc: 'b', token: 0 }, page: { offset: 0, limit: 2 } }));
    const p1 = kwicPage(w.snapshot, w.bound, w.all, occs, req({ center: { doc: 'b', token: 0 }, page: { offset: 2, limit: 2 } }));
    const key = (r: { trackOrdinal: number; docOrdinal: number; pos: number }) => `${r.trackOrdinal}:${r.docOrdinal}:${r.pos}`;
    expect(full.total).toBe(5);
    expect([...p0.rows, ...p1.rows].map(key)).toEqual(full.rows.slice(0, 4).map(key)); // continuous, no gaps/dups
  });

  it('rejects a stale/invalid center rather than clamping it', async () => {
    const w = await twoDoc();
    const occs = tracksOf(w);
    expect(() => kwicPage(w.snapshot, w.bound, w.all, occs, req({ center: { doc: 'zzz', token: 0 } }))).toThrow(/not in the snapshot/);
    expect(() => kwicPage(w.snapshot, w.bound, w.all, occs, req({ center: { doc: 'b', token: 999 } }))).toThrow(/out of range/);
    expect(() => kwicPage(w.snapshot, w.bound, w.all, occs, req({ center: { doc: 'b', token: -1 } }))).toThrow(/out of range/);
  });

  it('requires 1..MAX tracks and rejects a track from a different snapshot', async () => {
    const w = await twoDoc();
    expect(() => kwicPage(w.snapshot, w.bound, w.all, [], req())).toThrow(/1\.\.5 tracks/);
    const w2 = await world({ a: 'wolf' });
    const foreign = occurrences(w2.snapshot, w2.shards, w2.resolvers, w2.all, wolfGroup);
    expect(() => kwicPage(w.snapshot, w.bound, w.all, [foreign], req())).toThrow(/different snapshot/);
  });

  it('materialize rejects a row whose track ordinal is not in the table', async () => {
    const w = await twoDoc();
    const page = kwicPage(w.snapshot, w.bound, w.all, tracksOf(w), req());
    expect(() => materializeKwicPage(w.snapshot, page, w.texts, [{ seriesId: 'only', groupId: 'gfox' }])).toThrow(/unknown track ordinal/);
  });
});

describe('kwic/2 ranked-candidate order vs reference full sort', () => {
  // A straightforward reimplementation of the pinned comparator semantics over
  // FULLY materialized rows — the oracle the optimized tuple path must match
  // row-for-row (the whole ordered page, never just the set):
  //   1. center (when present): ascending |globalStart - centerGlobal|;
  //   2. each caller sort entry in caller order (doc/pos numeric; L*/R* by JS
  //      string order of the vocabulary key, '' when out of range) x its dir;
  //   3. deterministic finals: doc ordinal, pos, span, track ordinal;
  //   4. member ordinals lexicographically, then member-count.
  type Sort = readonly { readonly at: KwicSortKey; readonly dir: 1 | -1 }[];
  interface RefRow { t: number; doc: number; pos: number; span: number; global: number; members: number[] }
  const rowKey = (t: number, doc: number, pos: number, span: number, members: readonly number[]) =>
    `${t}:${doc}:${pos}:${span}:[${members.join(',')}]`;
  const pageKeys = (page: NumericKwicPage) =>
    page.rows.map((r) => rowKey(r.trackOrdinal, r.docOrdinal, r.pos, r.spanTokens, r.members));

  const referenceOrder = (
    w: World,
    tracks: readonly NumericOccurrences[],
    sort: Sort,
    center?: { readonly doc: string; readonly token: number },
  ): string[] => {
    const rows: RefRow[] = [];
    for (let t = 0; t < tracks.length; t++) {
      const occ = tracks[t]!;
      for (let i = 0; i < occ.pos.length; i++) {
        const doc = occ.docOrdinal[i] as number;
        rows.push({
          t, doc,
          pos: occ.pos[i] as number,
          span: occ.spanTokens[i] as number,
          global: w.snapshot.docs[doc]!.sequenceTokenBase + (occ.pos[i] as number),
          members: Array.from(occ.memberOrdinals.slice(occ.memberOffsets[i] as number, occ.memberOffsets[i + 1] as number)),
        });
      }
    }
    const centerGlobal = center === undefined
      ? null
      : w.snapshot.docs.find((d) => d.doc === center.doc)!.sequenceTokenBase + center.token;
    const ctxKey = (r: RefRow, at: Exclude<KwicSortKey, 'doc' | 'pos'>): string => {
      const shard = w.shards.get(w.snapshot.docs[r.doc]!.doc)!;
      const off = Number(at.slice(1));
      const tok = at.startsWith('L') ? r.pos - off : r.pos + r.span - 1 + off;
      if (tok < 0 || tok >= shard.tokenTypeIds.length) return '';
      return shard.vocabulary[shard.tokenTypeIds[tok] as number] as string;
    };
    rows.sort((a, b) => {
      if (centerGlobal !== null) {
        const d = Math.abs(a.global - centerGlobal) - Math.abs(b.global - centerGlobal);
        if (d !== 0) return d;
      }
      for (const s of sort) {
        let c = 0;
        if (s.at === 'doc') c = a.doc - b.doc;
        else if (s.at === 'pos') c = a.pos - b.pos;
        else {
          const ka = ctxKey(a, s.at);
          const kb = ctxKey(b, s.at);
          c = ka < kb ? -1 : ka > kb ? 1 : 0;
        }
        if (c !== 0) return c * s.dir;
      }
      let c = a.doc - b.doc || a.pos - b.pos || a.span - b.span || a.t - b.t;
      if (c !== 0) return c;
      const n = Math.min(a.members.length, b.members.length);
      for (let k = 0; k < n; k++) {
        c = (a.members[k] as number) - (b.members[k] as number);
        if (c !== 0) return c;
      }
      return a.members.length - b.members.length;
    });
    return rows.map((r) => rowKey(r.t, r.doc, r.pos, r.span, r.members));
  };

  // Handcrafted CSR tracks — legal occurrence shapes made maximally tie-heavy.
  const mkOcc = (
    w: World,
    rows: readonly { d: number; p: number; s: number; m: readonly number[] }[],
  ): NumericOccurrences => {
    const memberOffsets = [0];
    const memberOrdinals: number[] = [];
    for (const r of rows) {
      for (const ord of r.m) memberOrdinals.push(ord);
      memberOffsets.push(memberOrdinals.length);
    }
    return {
      snapshot: w.snapshot.id,
      selection: w.all.hash,
      docOrdinal: Uint32Array.from(rows.map((r) => r.d)),
      pos: Uint32Array.from(rows.map((r) => r.p)),
      spanTokens: Uint32Array.from(rows.map((r) => r.s)),
      memberOffsets: Uint32Array.from(memberOffsets),
      memberOrdinals: Uint32Array.from(memberOrdinals),
    };
  };

  // Repeated tokens make every L/R context key collide on purpose.
  const tieWorld = () => world({ a: 'x wolf x wolf x wolf x', b: 'x wolf x' });
  const tieTracks = (w: World): NumericOccurrences[] => [
    mkOcc(w, [
      { d: 0, p: 1, s: 1, m: [0] },     // vs next: [0] is a strict prefix of [0,1]
      { d: 0, p: 1, s: 1, m: [0, 1] },  // vs next: first ordinal decides (0 < 1) despite shorter list losing on count
      { d: 0, p: 1, s: 1, m: [1] },
      { d: 0, p: 1, s: 2, m: [0] },     // same start, wider span
      { d: 0, p: 3, s: 1, m: [1] },
      { d: 1, p: 1, s: 1, m: [0] },
    ]),
    mkOcc(w, [
      { d: 0, p: 1, s: 1, m: [0] },     // same (doc,pos,span) as track 0 rows — track ordinal decides
      { d: 0, p: 3, s: 2, m: [0, 1] },
      { d: 1, p: 1, s: 1, m: [1] },
    ]),
    mkOcc(w, [
      { d: 0, p: 5, s: 1, m: [2] },
      { d: 1, p: 1, s: 1, m: [0, 2] },
    ]),
  ];

  const SORTS: readonly Sort[] = [
    [],                                              // finals only
    [{ at: 'L1', dir: 1 }],                          // repeated context keys ('x' everywhere)
    [{ at: 'L1', dir: -1 }],
    [{ at: 'L3', dir: 1 }],                          // out-of-range context '' sorts first
    [{ at: 'R3', dir: -1 }],
    [{ at: 'R1', dir: 1 }, { at: 'L2', dir: -1 }],   // mixed keys, mixed directions
    [{ at: 'L1', dir: 1 }, { at: 'L1', dir: -1 }],   // repeated sort key, both directions
    [{ at: 'doc', dir: -1 }, { at: 'pos', dir: 1 }],
    [{ at: 'pos', dir: -1 }, { at: 'R2', dir: 1 }],
  ];
  const CENTERS = [undefined, { doc: 'a', token: 3 }, { doc: 'b', token: 0 }] as const;

  it('matches the reference over tie-heavy handcrafted tracks for every sort x center', async () => {
    const w = await tieWorld();
    const tracks = tieTracks(w);
    for (const center of CENTERS) {
      for (const sort of SORTS) {
        const page = kwicPage(w.snapshot, w.bound, w.all, tracks, {
          contextTokens: 0, sort, page: { offset: 0, limit: 50 }, ...(center ? { center } : {}),
        });
        const label = `sort=${JSON.stringify(sort)} center=${JSON.stringify(center ?? null)}`;
        expect(pageKeys(page), label).toEqual(referenceOrder(w, tracks, sort, center));
      }
    }
  });

  it('bounded top-K pages are exact contiguous slices of the reference order', async () => {
    const w = await tieWorld();
    const tracks = tieTracks(w);
    const sort: Sort = [{ at: 'L1', dir: 1 }];
    const center = { doc: 'a', token: 3 };
    const ref = referenceOrder(w, tracks, sort, center);
    for (const offset of [0, 2, 5, 9]) {
      const page = kwicPage(w.snapshot, w.bound, w.all, tracks, {
        contextTokens: 0, sort, center, page: { offset, limit: 3 },
      });
      expect(pageKeys(page), `offset=${offset}`).toEqual(ref.slice(offset, offset + 3));
    }
  });

  it('matches the reference for organic union/raw tracks with multi-member evidence', async () => {
    const w = await world({ a: 'dire wolf x dire wolf y wolf', b: 'wolf dire wolf' });
    const tracks = [
      occurrences(w.snapshot, w.shards, w.resolvers, w.all, direWolfGroup(false)), // union: members accumulate
      occurrences(w.snapshot, w.shards, w.resolvers, w.all, direWolfGroup(true)),  // raw: one row per member match
      occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup),
    ];
    for (const center of [undefined, { doc: 'b', token: 1 }]) {
      for (const sort of SORTS) {
        const page = kwicPage(w.snapshot, w.bound, w.all, tracks, {
          contextTokens: 0, sort, page: { offset: 0, limit: 50 }, ...(center ? { center } : {}),
        });
        const label = `sort=${JSON.stringify(sort)} center=${JSON.stringify(center ?? null)}`;
        expect(pageKeys(page), label).toEqual(referenceOrder(w, tracks, sort, center));
      }
    }
  });
});

describe('kwic binding discipline', () => {
  it('bindShards rejects a shard that is not the snapshot-named artifact', async () => {
    const w = await world({ a: 'a wolf' });
    const foreign = await createDocumentIndex('longlong wolf', await segment('longlong wolf', 'en'), R);
    await expect(bindShards(w.snapshot, new Map([['a', foreign]]))).rejects.toThrow(
      /not the artifact named by the snapshot/,
    );
    await expect(bindShards(w.snapshot, new Map())).rejects.toThrow(DependencyError);
  });

  it('bindTexts rejects a text that does not match the shard identity', async () => {
    const w = await world({ a: 'a wolf' });
    await expect(bindTexts(w.snapshot, w.bound, new Map([['a', 'zzzzzz']]))).rejects.toThrow(
      /does not match the bound shard/,
    );
  });

  it('materialization rejects foreign snapshots and pages', async () => {
    const w1 = await world({ a: 'a wolf' });
    const w2 = await world({ b: 'BBBB wolf' });
    const occ = occurrences(w1.snapshot, w1.shards, w1.resolvers, w1.all, wolfGroup);
    const page = kwic1(w1.snapshot, w1.bound, w1.all, occ, {
      contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    expect(() => matk1(w2.snapshot, page, w2.texts)).toThrow(
      /planned against a different snapshot/,
    );
    expect(() => kwic1(w2.snapshot, w1.bound, w2.all, occ, {
      contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
    })).toThrow(/different snapshot/);
  });

  it('post-bind mutation of the caller maps cannot alter a bound context', async () => {
    const text = 'a wolf';
    const shard = await createDocumentIndex(text, await segment(text, 'en'), R);
    const ready = new Map([
      ['a' as ProjectDocId, await makeReadyDocument('a' as ProjectDocId, shard)],
    ]);
    const snapshot = await composeSnapshot(GEN, ['a'] as ProjectDocId[], ready);
    const shardMap = new Map([['a', shard]]);
    const textMap = new Map([['a', text]]);
    const bound = await bindShards(snapshot, shardMap);
    const boundTexts = await bindTexts(snapshot, bound, textMap);
    const resolvers = new Map([['a', new Map([[modeKey(FOLD), await buildResolver(shard, R, FOLD)]])]]);
    const sel = await resolveSelection(snapshot, { docs: ['a'] as ProjectDocId[] });
    const occ = occurrences(snapshot, shardMap, resolvers, sel, wolfGroup);

    // Mutate the ORIGINAL maps after binding — the attack from review round 2 —
    // AND the original shard's arrays + the returned context — round 3.
    const foreign = await createDocumentIndex('longlong wolf', await segment('longlong wolf', 'en'), R);
    shardMap.set('a', foreign);
    textMap.set('a', 'zzzzzz');
    shard.startsUtf16[1] = 0;      // mutate original arrays post-bind
    shard.lengths8[1] = 1;
    // No public path to residency at all (round 4): no maps, no get.
    expect((bound as unknown as { shards?: unknown }).shards).toBeUndefined();
    expect((bound as unknown as { get?: unknown }).get).toBeUndefined();
    expect((boundTexts as unknown as { texts?: unknown }).texts).toBeUndefined();
    expect((boundTexts as unknown as { get?: unknown }).get).toBeUndefined();
    expect(Object.isFrozen(bound)).toBe(true);

    const page = kwic1(snapshot, bound, sel, occ, {
      contextTokens: 1, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    const rows = matk1(snapshot, page, boundTexts);
    expect(rows[0]!.nodeText).toBe('wolf'); // still the VERIFIED text and shard
    expect(rows[0]!.left).toBe('a ');
  });

  it('rejects structurally forged capability objects (unauthenticated)', async () => {
    const w = await world({ a: 'a wolf' });
    const foreign = await createDocumentIndex('longlong wolf', await segment('longlong wolf', 'en'), R);
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const forgedShards = {
      snapshot: w.snapshot.id,
      docs: () => ['a'] as readonly string[],
      get: () => foreign,
    } as unknown as BoundShards;
    expect(() =>
      kwic1(w.snapshot, forgedShards, w.all, occ, {
        contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
      }),
    ).toThrow(/unauthenticated/);
    const realPage = kwic1(w.snapshot, w.bound, w.all, occ, {
      contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    const forgedTexts = {
      snapshot: w.snapshot.id,
      docs: () => ['a'] as readonly string[],
      get: () => 'zzzzzzzzzzzz',
    } as unknown as BoundTexts;
    expect(() => matk1(w.snapshot, realPage, forgedTexts)).toThrow(/unauthenticated/);
    await expect(bindTexts(w.snapshot, forgedShards, new Map())).rejects.toThrow(/unauthenticated/);
    // Zero-row paths authenticate EAGERLY too (round 5): an empty occurrence
    // set and an empty page must still reject forged contexts.
    const emptyOcc = occurrences(w.snapshot, w.shards, w.resolvers, w.all, {
      id: 'none', members: [{ id: 'm', kind: 'token', surface: 'zzz-absent', match: FOLD }],
      countOverlaps: false,
    });
    expect(emptyOcc.pos.length).toBe(0);
    expect(() =>
      kwic1(w.snapshot, forgedShards, w.all, emptyOcc, {
        contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
      }),
    ).toThrow(/unauthenticated/);
    const emptyPage = kwic1(w.snapshot, w.bound, w.all, emptyOcc, {
      contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    expect(() => matk1(w.snapshot, emptyPage, forgedTexts)).toThrow(/unauthenticated/);
  });

  it('rejects pre-bind array corruption via structural validation', async () => {
    const text = 'alpha wolf';
    const shard = await createDocumentIndex(text, await segment(text, 'en'), R);
    const ready = new Map([
      ['a' as ProjectDocId, await makeReadyDocument('a' as ProjectDocId, shard)],
    ]);
    const snapshot = await composeSnapshot(GEN, ['a'] as ProjectDocId[], ready);
    // Corrupt the arrays BEFORE binding: descriptor identity still matches,
    // so only structural validation can catch these (rounds 4-5).
    const segBatch = await segment(text, 'en');
    // Trusted sync builder: produces clean shards we then corrupt in place.
    const fresh = () =>
      buildDocumentIndex(text, segBatch, R, { text: shard.text, recipe: shard.recipe });

    const overlap = fresh(); // 'alpha wolf': starts [0,6]; still-increasing overlap
    overlap.startsUtf16[1] = 1; // inside 'alpha' (end 5) but > starts[0]
    await expect(bindShards(snapshot, new Map([['a', overlap]]))).rejects.toThrow(/overlaps/);

    const zeroLen = fresh();
    zeroLen.lengths8[1] = 0;
    await expect(bindShards(snapshot, new Map([['a', zeroLen]]))).rejects.toThrow(/zero-length/);

    const outOfDomain = fresh();
    outOfDomain.startsUtf16[1] = 0xfffffffe;
    await expect(bindShards(snapshot, new Map([['a', outOfDomain]]))).rejects.toThrow(
      /address domain/,
    );

    const dupVocab = fresh();
    (dupVocab.vocabulary as string[])[1] = dupVocab.vocabulary[0] as string;
    await expect(bindShards(snapshot, new Map([['a', dupVocab]]))).rejects.toThrow(/unique/);

    // An INTERNALLY VALID shard that contradicts the snapshot's coordinates
    // (round 6): reshape to a consistent one-token graph under the same
    // descriptor — cross-artifact validation must reject it.
    const clean = fresh();
    const reshaped: DocumentIndexV1 = {
      ...clean,
      tokenTypeIds: Uint32Array.from([0]),
      startsUtf16: Uint32Array.from([0]),
      lengths8: Uint8Array.from([5]),
      tokenClasses: Uint8Array.from([1]),
      longTokenPositions: new Uint32Array(0),
      longTokenLengths: new Uint32Array(0),
      vocabulary: ['alpha'],
      postings: { offsets: Uint32Array.from([0, 1]), positions: Uint32Array.from([0]) },
      sentenceBounds: Uint32Array.from([0, 1]),
      paragraphBounds: Uint32Array.from([0, 1]),
    };
    expect(() => validateShardStructure(reshaped)).not.toThrow(); // internally valid
    await expect(bindShards(snapshot, new Map([['a', reshaped]]))).rejects.toThrow(
      /disagrees with shard/,
    );

    // Geometry within the v1 domain but past THIS text's end (round 6):
    // bindShards passes (arrays valid, snapshot coordinates agree), and
    // bindTexts must reject against the verified text's actual length.
    const beyond = fresh();
    beyond.startsUtf16[1] = 100; // 'wolf' now [100,104) — text is 10 chars
    const boundBeyond = await bindShards(snapshot, new Map([['a', beyond]]));
    await expect(
      bindTexts(snapshot, boundBeyond, new Map([['a', text]])),
    ).rejects.toThrow(/exceed the verified text length/);
  });

  it('rejects occurrences computed under a foreign snapshot or selection', async () => {
    const w1 = await world({ a: 'wolf' });
    const w2 = await world({ b: 'x wolf' });
    const occ1 = occurrences(w1.snapshot, w1.shards, w1.resolvers, w1.all, wolfGroup);
    // Foreign snapshot into kwic and trend:
    expect(() =>
      kwic1(w2.snapshot, w2.bound, w2.all, occ1, {
        contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
      }),
    ).toThrow(/different snapshot/);
    expect(() =>
      trend(w2.snapshot, w2.all, occ1, { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } }),
    ).toThrow(/different snapshot/);
    // Same snapshot, different selection:
    const w3 = await world({ a: 'wolf x wolf' });
    const full = occurrences(w3.snapshot, w3.shards, w3.resolvers, w3.all, wolfGroup);
    const narrow = await resolveSelection(w3.snapshot, {
      docs: ['a'] as ProjectDocId[],
      ranges: [{ doc: 'a' as ProjectDocId, tokens: { start: 0 as never, end: 1 as never } }],
    });
    expect(() =>
      trend(w3.snapshot, narrow, full, { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } }),
    ).toThrow(/different selection/);
    expect(() =>
      kwic1(w3.snapshot, w3.bound, narrow, full, {
        contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
      }),
    ).toThrow(/different selection/);
  });

  it('a paged doc without bound text is a typed dependency failure', async () => {
    const w = await world({ a: 'the wolf' });
    const emptyTexts = await bindTexts(w.snapshot, w.bound, new Map());
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const page = kwic1(w.snapshot, w.bound, w.all, occ, {
      contextTokens: 1, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    try {
      matk1(w.snapshot, page, emptyTexts);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DependencyError);
      expect((e as DependencyError).code).toBe('DEPENDENCY_MISSING');
      expect((e as DependencyError).dependency).toBe('text');
    }
  });
});
