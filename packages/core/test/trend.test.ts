import { describe, expect, it } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex, type DocumentIndexV1 } from '../src/index/build.ts';
import { bindShards, bindTexts, type BoundShards, type BoundTexts } from '../src/ops/binding.ts';
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
