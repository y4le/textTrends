import { describe, expect, it } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { rootOnlyStructure } from '../src/contract/identity.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { buildDocumentIndex, createDocumentIndex, type DocumentIndexV1 } from '../src/index/build.ts';
import { bindShards, bindTexts, DependencyError, type BoundShards, type BoundTexts } from '../src/ops/binding.ts';
import { validateShardStructure } from '../src/index/build.ts';
import { kwicPage, KWIC_MAX_PAGE, materializeKwicPage } from '../src/ops/kwic.ts';
import { occurrences, type TermGroupSpec } from '../src/ops/occurrences.ts';
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
    ready.set(id, await makeReadyDocument(id, shard, rootOnlyStructure(shard.text, text.length)));
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
    { id: 'p', kind: 'phrase', surfaces: ['dire', 'wolf'], match: FOLD, crossSentence: false },
    { id: 't', kind: 'token', surface: 'wolf', match: FOLD },
  ],
  countOverlaps,
});
const SORT_POS = [{ at: 'pos', dir: 1 }] as const;

describe('trend/1', () => {
  it('bins restart per document; counts land by start token; final bin may be short', async () => {
    const w = await world({ a: 'wolf b c d wolf', b: 'x wolf y' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const t = trend(w.snapshot, w.all, occ, { coordinate: 'document-relative', binsPerDoc: 2 });
    expect(Array.from(t.binTokens)).toEqual([3, 2, 2, 1]);
    expect(Array.from(t.count)).toEqual([1, 1, 1, 0]);
    expect(t.ratePer10k[0]).toBeCloseTo((1 / 3) * 10_000, 6);
    expect(t.order).toEqual(['a', 'b']);
    expect(t.sequenceBases).toBeNull(); // document-relative carries no bases
  });

  it('declared-sequence differs exactly by carrying bases', async () => {
    const w = await world({ a: 'wolf b c', b: 'x wolf y' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const rel = trend(w.snapshot, w.all, occ, { coordinate: 'document-relative', binsPerDoc: 3 });
    const seq = trend(w.snapshot, w.all, occ, { coordinate: 'declared-sequence', binsPerDoc: 3 });
    expect(Array.from(seq.count)).toEqual(Array.from(rel.count));
    expect(seq.sequenceBases).toEqual([0, 3]);
    expect(rel.sequenceBases).toBeNull();
  });

  it('a phrase occurrence counts once, in its start-token bin', async () => {
    // 'dire' ends bin 0, 'wolf' starts bin 1 — the span counts in bin 0 (start rule).
    const w = await world({ a: 'x dire wolf y' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, direWolfGroup(false));
    const t = trend(w.snapshot, w.all, occ, { coordinate: 'document-relative', binsPerDoc: 2 });
    expect(Array.from(t.count)).toEqual([1, 0]);
  });

  it('overlap mode changes trend counts (union vs raw)', async () => {
    const w = await world({ a: 'the dire wolf howled' });
    const union = occurrences(w.snapshot, w.shards, w.resolvers, w.all, direWolfGroup(false));
    const raw = occurrences(w.snapshot, w.shards, w.resolvers, w.all, direWolfGroup(true));
    const req = { coordinate: 'document-relative', binsPerDoc: 1 } as const;
    expect(Array.from(trend(w.snapshot, w.all, union, req).count)).toEqual([1]);
    expect(Array.from(trend(w.snapshot, w.all, raw, req).count)).toEqual([2]);
  });

  it('missing (uncomposed) documents simply have no rows; bases skip them', async () => {
    const w = await world({ a: 'wolf here', c: 'wolf there' }, ['a', 'b', 'c']);
    expect(w.snapshot.missingDocs).toEqual(['b']);
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const t = trend(w.snapshot, w.all, occ, { coordinate: 'declared-sequence', binsPerDoc: 1 });
    expect(t.order).toEqual(['a', 'c']);
    expect(t.sequenceBases).toEqual([0, 2]); // c's base counts only composed a
    expect(Array.from(t.count)).toEqual([1, 1]);
  });

  it('empty documents produce zero-token bins without dividing by zero', async () => {
    const w = await world({ a: '' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const t = trend(w.snapshot, w.all, occ, { coordinate: 'document-relative', binsPerDoc: 3 });
    expect(Array.from(t.binTokens)).toEqual([0, 0, 0]);
    expect(Array.from(t.ratePer10k)).toEqual([0, 0, 0]);
  });

  it('selection ranges shrink denominators to selected tokens only', async () => {
    const w = await world({ a: 'wolf b c d wolf f' });
    const sel = await resolveSelection(w.snapshot, {
      docs: ['a'] as ProjectDocId[],
      ranges: [{ doc: 'a' as ProjectDocId, tokens: { start: 0 as never, end: 3 as never } }],
    });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, sel, wolfGroup);
    const t = trend(w.snapshot, sel, occ, { coordinate: 'document-relative', binsPerDoc: 2 });
    expect(Array.from(t.binTokens)).toEqual([3, 0]);
    expect(t.ratePer10k[1]).toBe(0);
  });

  it('rejects foreign selections, bad bin counts, and unknown coordinates', async () => {
    const w1 = await world({ a: 'x' });
    const w2 = await world({ a: 'x y' });
    const occ = occurrences(w1.snapshot, w1.shards, w1.resolvers, w1.all, wolfGroup);
    expect(() => trend(w1.snapshot, w2.all, occ, { coordinate: 'document-relative', binsPerDoc: 2 }))
      .toThrow(/different snapshot/);
    expect(() => trend(w1.snapshot, w1.all, occ, { coordinate: 'document-relative', binsPerDoc: 0 }))
      .toThrow(/positive integer/);
    expect(() =>
      trend(w1.snapshot, w1.all, occ, { coordinate: 'bogus' as never, binsPerDoc: 1 }),
    ).toThrow(/unknown trend coordinate/);
  });
});

describe('kwic/1 planning and materialization', () => {
  it('produces exact spans, preserves member evidence and the stable node range', async () => {
    const w = await world({ a: 'the dire wolf howled' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, direWolfGroup(false));
    const page = kwicPage(w.snapshot, w.bound, w.all, occ, {
      contextTokens: 1, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    expect(page.snapshot).toBe(w.snapshot.id);
    const rows = materializeKwicPage(w.snapshot, page, w.texts);
    expect(rows[0]).toEqual({
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
    const page = kwicPage(w.snapshot, w.bound, w.all, occ, {
      contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    const rows = materializeKwicPage(w.snapshot, page, w.texts);
    expect(rows[0]!.nodeText).toBe('isn’t'); // raw source, curly apostrophe intact
  });

  it('handles astral characters in context and node spans', async () => {
    const w = await world({ a: 'I 😀 saw the wolf 😀 again' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const page = kwicPage(w.snapshot, w.bound, w.all, occ, {
      contextTokens: 2, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    const rows = materializeKwicPage(w.snapshot, page, w.texts);
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
      const page = kwicPage(w.snapshot, w.bound, w.all, occ, {
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
    const p0 = kwicPage(w.snapshot, w.bound, w.all, occ, req(0));
    const p1 = kwicPage(w.snapshot, w.bound, w.all, occ, req(3));
    const p2 = kwicPage(w.snapshot, w.bound, w.all, occ, req(6));
    const all = [...p0.rows, ...p1.rows, ...p2.rows].map((r) => r.pos);
    expect(all).toEqual([...all].sort((x, y) => x - y)); // ordered continuation
    expect(new Set(all).size).toBe(7);                    // disjoint and complete
    expect(p0.total).toBe(7);
  });

  it('clamps context at document edges and spans 300-char overflow tokens via tokenEndChar', async () => {
    const long = 'a'.repeat(300);
    const w = await world({ a: `wolf ${long} wolf` });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const page = kwicPage(w.snapshot, w.bound, w.all, occ, {
      contextTokens: 2, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    const rows = materializeKwicPage(w.snapshot, page, w.texts);
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
    const p0 = kwicPage(w.snapshot, w.bound, w.all, occ, req(0));
    const p1 = kwicPage(w.snapshot, w.bound, w.all, occ, req(3));
    const key = (r: { pos: number; members: readonly number[] }) => `${r.pos}:${r.members[0]}`;
    const all = [...p0.rows, ...p1.rows].map(key);
    expect(all).toEqual(['0:0', '0:1', '2:0', '2:1']); // pos asc, then member asc, across the page break
  });

  it('locks the page cap boundary at 500/501', async () => {
    const w = await world({ a: 'wolf' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const mk = (limit: number) =>
      kwicPage(w.snapshot, w.bound, w.all, occ, { contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit } });
    expect(() => mk(KWIC_MAX_PAGE)).not.toThrow();
    expect(() => mk(KWIC_MAX_PAGE + 1)).toThrow(/page must satisfy/);
  });

  it('rejects invalid sort entries', async () => {
    const w = await world({ a: 'wolf' });
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    expect(() =>
      kwicPage(w.snapshot, w.bound, w.all, occ, {
        contextTokens: 0,
        sort: [{ at: 'bogus' as never, dir: 0 as never }],
        page: { offset: 0, limit: 10 },
      }),
    ).toThrow(/invalid sort entry/);
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
    const page = kwicPage(w1.snapshot, w1.bound, w1.all, occ, {
      contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    expect(() => materializeKwicPage(w2.snapshot, page, w2.texts)).toThrow(
      /planned against a different snapshot/,
    );
    expect(() => kwicPage(w2.snapshot, w1.bound, w2.all, occ, {
      contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
    })).toThrow(/different snapshot/);
  });

  it('post-bind mutation of the caller maps cannot alter a bound context', async () => {
    const text = 'a wolf';
    const shard = await createDocumentIndex(text, await segment(text, 'en'), R);
    const ready = new Map([
      ['a' as ProjectDocId, await makeReadyDocument('a' as ProjectDocId, shard, rootOnlyStructure(shard.text, text.length))],
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

    const page = kwicPage(snapshot, bound, sel, occ, {
      contextTokens: 1, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    const rows = materializeKwicPage(snapshot, page, boundTexts);
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
      kwicPage(w.snapshot, forgedShards, w.all, occ, {
        contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
      }),
    ).toThrow(/unauthenticated/);
    const realPage = kwicPage(w.snapshot, w.bound, w.all, occ, {
      contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    const forgedTexts = {
      snapshot: w.snapshot.id,
      docs: () => ['a'] as readonly string[],
      get: () => 'zzzzzzzzzzzz',
    } as unknown as BoundTexts;
    expect(() => materializeKwicPage(w.snapshot, realPage, forgedTexts)).toThrow(/unauthenticated/);
    await expect(bindTexts(w.snapshot, forgedShards, new Map())).rejects.toThrow(/unauthenticated/);
    // Zero-row paths authenticate EAGERLY too (round 5): an empty occurrence
    // set and an empty page must still reject forged contexts.
    const emptyOcc = occurrences(w.snapshot, w.shards, w.resolvers, w.all, {
      id: 'none', members: [{ id: 'm', kind: 'token', surface: 'zzz-absent', match: FOLD }],
      countOverlaps: false,
    });
    expect(emptyOcc.pos.length).toBe(0);
    expect(() =>
      kwicPage(w.snapshot, forgedShards, w.all, emptyOcc, {
        contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
      }),
    ).toThrow(/unauthenticated/);
    const emptyPage = kwicPage(w.snapshot, w.bound, w.all, emptyOcc, {
      contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    expect(() => materializeKwicPage(w.snapshot, emptyPage, forgedTexts)).toThrow(/unauthenticated/);
  });

  it('rejects pre-bind array corruption via structural validation', async () => {
    const text = 'alpha wolf';
    const shard = await createDocumentIndex(text, await segment(text, 'en'), R);
    const ready = new Map([
      ['a' as ProjectDocId, await makeReadyDocument('a' as ProjectDocId, shard, rootOnlyStructure(shard.text, text.length))],
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
      kwicPage(w2.snapshot, w2.bound, w2.all, occ1, {
        contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
      }),
    ).toThrow(/different snapshot/);
    expect(() =>
      trend(w2.snapshot, w2.all, occ1, { coordinate: 'document-relative', binsPerDoc: 1 }),
    ).toThrow(/different snapshot/);
    // Same snapshot, different selection:
    const w3 = await world({ a: 'wolf x wolf' });
    const full = occurrences(w3.snapshot, w3.shards, w3.resolvers, w3.all, wolfGroup);
    const narrow = await resolveSelection(w3.snapshot, {
      docs: ['a'] as ProjectDocId[],
      ranges: [{ doc: 'a' as ProjectDocId, tokens: { start: 0 as never, end: 1 as never } }],
    });
    expect(() =>
      trend(w3.snapshot, narrow, full, { coordinate: 'document-relative', binsPerDoc: 1 }),
    ).toThrow(/different selection/);
    expect(() =>
      kwicPage(w3.snapshot, w3.bound, narrow, full, {
        contextTokens: 0, sort: SORT_POS, page: { offset: 0, limit: 10 },
      }),
    ).toThrow(/different selection/);
  });

  it('a paged doc without bound text is a typed dependency failure', async () => {
    const w = await world({ a: 'the wolf' });
    const emptyTexts = await bindTexts(w.snapshot, w.bound, new Map());
    const occ = occurrences(w.snapshot, w.shards, w.resolvers, w.all, wolfGroup);
    const page = kwicPage(w.snapshot, w.bound, w.all, occ, {
      contextTokens: 1, sort: SORT_POS, page: { offset: 0, limit: 10 },
    });
    try {
      materializeKwicPage(w.snapshot, page, emptyTexts);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DependencyError);
      expect((e as DependencyError).code).toBe('DEPENDENCY_MISSING');
      expect((e as DependencyError).dependency).toBe('text');
    }
  });
});
