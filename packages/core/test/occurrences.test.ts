import { describe, expect, it } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { rootOnlyStructure } from '../src/contract/identity.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex, type DocumentIndexV1 } from '../src/index/build.ts';
import { occurrences, type ResolverTable, type TermGroupSpec } from '../src/ops/occurrences.ts';
import { buildResolver, modeKey, type MatchMode, type Resolver } from '../src/resolve/fold.ts';
import { segment } from '../src/segment/intl.ts';
import { composeSnapshot, makeReadyDocument, type CorpusSnapshotV1 } from '../src/snapshot/compose.ts';
import { resolveSelection, type ResolvedSelection } from '../src/snapshot/selection.ts';

const R = DEFAULT_INDEX_RECIPE;
const GEN = 'g' as BuildGeneration;
const FOLD: MatchMode = { case: 'folded', diacritics: 'sensitive' };
const EXACT: MatchMode = { case: 'sensitive', diacritics: 'sensitive' };
const MODES = [FOLD, EXACT];

interface World {
  snapshot: CorpusSnapshotV1;
  shards: Map<string, DocumentIndexV1>;
  resolvers: Map<string, Map<string, Resolver>>;
  all: ResolvedSelection;
}

async function world(texts: Record<string, string>): Promise<World> {
  const shards = new Map<string, DocumentIndexV1>();
  const resolvers = new Map<string, Map<string, Resolver>>();
  const ready = new Map();
  const ids = Object.keys(texts) as ProjectDocId[];
  for (const id of ids) {
    const text = texts[id] as string;
    const shard = await createDocumentIndex(text, await segment(text, 'en'), R);
    shards.set(id, shard);
    const byMode = new Map<string, Resolver>();
    for (const mode of MODES) byMode.set(modeKey(mode), await buildResolver(shard, R, mode));
    resolvers.set(id, byMode);
    ready.set(id, await makeReadyDocument(id, shard, rootOnlyStructure(shard.text, text.length)));
  }
  const snapshot = await composeSnapshot(GEN, ids, ready);
  const all = await resolveSelection(snapshot, { docs: ids });
  return { snapshot, shards, resolvers, all };
}

const token = (id: string, surface: string, match: MatchMode = FOLD) => ({
  id, kind: 'token' as const, surface, match,
});
const phrase = (id: string, surfaces: string[], crossSentence = false, match: MatchMode = FOLD) => ({
  id, kind: 'phrase' as const, surfaces, match, crossSentence,
});
const group = (members: TermGroupSpec['members'], countOverlaps = false): TermGroupSpec => ({
  id: 'g1', members, countOverlaps,
});

function rows(o: ReturnType<typeof occurrences>) {
  return Array.from(o.pos, (p, i) => ({
    doc: o.docOrdinal[i],
    pos: p,
    span: o.spanTokens[i],
    members: Array.from(
      o.memberOrdinals.slice(o.memberOffsets[i] as number, o.memberOffsets[i + 1] as number),
    ),
  }));
}

describe('token and affix occurrences', () => {
  it('emits from multiple documents in declared order', async () => {
    const w = await world({ a: 'The wolf ran. A WOLF howled.', b: 'a lone wolf again' });
    const o = occurrences(w.snapshot, w.shards, w.resolvers, w.all, group([token('m1', 'wolf')]));
    expect(rows(o)).toEqual([
      { doc: 0, pos: 1, span: 1, members: [0] },
      { doc: 0, pos: 4, span: 1, members: [0] },
      { doc: 1, pos: 2, span: 1, members: [0] },
    ]);
  });

  it('prefix matching is literal folded-prefix, not stemming', async () => {
    const w = await world({ a: 'wolf wolves wolfish sheep' });
    const o = occurrences(w.snapshot, w.shards, w.resolvers, w.all, group([
      { id: 'm1', kind: 'prefix', stem: 'wolf', match: FOLD },
    ]));
    expect(rows(o).map((r) => r.pos)).toEqual([0, 2]); // 'wolves' is 'wolv-'
  });

  it('mixed per-member match modes work in one group', async () => {
    const w = await world({ a: 'Wolf wolf' });
    const g = group(
      [token('sensitive', 'Wolf', EXACT), token('folded', 'wolf', FOLD)],
      true, // raw matches to observe both members
    );
    const o = occurrences(w.snapshot, w.shards, w.resolvers, w.all, g);
    expect(rows(o)).toEqual([
      { doc: 0, pos: 0, span: 1, members: [0] }, // exact 'Wolf'
      { doc: 0, pos: 0, span: 1, members: [1] }, // folded matches both tokens
      { doc: 0, pos: 1, span: 1, members: [1] },
    ]);
  });

  it('respects selection ranges — token and phrase matches must be fully contained', async () => {
    const w = await world({ a: 'x dire wolf y dire wolf z' });
    const sel = await resolveSelection(w.snapshot, {
      docs: ['a'] as ProjectDocId[],
      ranges: [{ doc: 'a' as ProjectDocId, tokens: { start: 0 as never, end: 3 as never } }],
    });
    const o = occurrences(w.snapshot, w.shards, w.resolvers, sel, group([
      phrase('m1', ['dire', 'wolf']),
    ]));
    expect(rows(o)).toEqual([{ doc: 0, pos: 1, span: 2, members: [0] }]);
    // A range cutting the phrase in half excludes it entirely.
    const cut = await resolveSelection(w.snapshot, {
      docs: ['a'] as ProjectDocId[],
      ranges: [{ doc: 'a' as ProjectDocId, tokens: { start: 0 as never, end: 2 as never } }],
    });
    expect(rows(occurrences(w.snapshot, w.shards, w.resolvers, cut, group([phrase('m1', ['dire', 'wolf'])]))))
      .toEqual([]);
  });
});

describe('phrases', () => {
  it('anchors on a strictly rarer second surface: nonzero offset, multi-id anchor, per-id dedup', async () => {
    // holy×4 vs folded grail-variants×3 -> the anchor is 'grail' at OFFSET 1,
    // resolving to THREE local ids; every id finds its match exactly once.
    const w = await world({ a: 'holy holy grail holy Grail holy GRAIL' });
    // Precondition assertions so later text edits cannot silently move the anchor:
    const resolver = w.resolvers.get('a')!.get(modeKey(FOLD))!;
    const shard = w.shards.get('a')!;
    const grailIds = resolver.map.get('grail') ?? [];
    expect(grailIds.length).toBe(3); // multi-id anchor
    const { postingsFor } = await import('../src/index/build.ts');
    const holyCount = (resolver.map.get('holy') ?? [])
      .reduce((s, id) => s + postingsFor(shard, id as number).length, 0);
    const grailCount = grailIds.reduce((s, id) => s + postingsFor(shard, id as number).length, 0);
    expect(holyCount).toBeGreaterThan(grailCount); // anchor must land at offset 1

    const o = occurrences(w.snapshot, w.shards, w.resolvers, w.all, group([
      phrase('m1', ['holy', 'grail']),
    ]));
    expect(rows(o).map((r) => ({ pos: r.pos, span: r.span }))).toEqual([
      { pos: 1, span: 2 },
      { pos: 3, span: 2 },
      { pos: 5, span: 2 },
    ]);
  });

  it('rejects phrases crossing a sentence bound unless allowed', async () => {
    const w = await world({ a: 'I saw the dire. Wolf howled anyway.' });
    expect(rows(occurrences(w.snapshot, w.shards, w.resolvers, w.all, group([
      phrase('m1', ['dire', 'wolf'], false),
    ])))).toEqual([]);
    expect(rows(occurrences(w.snapshot, w.shards, w.resolvers, w.all, group([
      phrase('m1', ['dire', 'wolf'], true),
    ])))).toEqual([{ doc: 0, pos: 3, span: 2, members: [0] }]);
  });

  it('a phrase with an unmatched surface finds nothing; an empty phrase is rejected', async () => {
    const w = await world({ a: 'dire wolf' });
    expect(rows(occurrences(w.snapshot, w.shards, w.resolvers, w.all, group([
      phrase('m1', ['dire', 'dragon']),
    ])))).toEqual([]);
    expect(() =>
      occurrences(w.snapshot, w.shards, w.resolvers, w.all, group([phrase('m1', [])])),
    ).toThrow(/no surfaces/);
  });
});

describe('overlap semantics', () => {
  it('countOverlaps=false merges covered-token unions and reports every member', async () => {
    const w = await world({ a: 'the dire wolf howled' });
    const o = occurrences(w.snapshot, w.shards, w.resolvers, w.all, group([
      phrase('m1', ['dire', 'wolf']),
      token('m2', 'wolf'),
    ]));
    expect(rows(o)).toEqual([{ doc: 0, pos: 1, span: 2, members: [0, 1] }]);
  });

  it('transitive unions chain across overlapping spans', async () => {
    const w = await world({ a: 'a b c d' });
    const o = occurrences(w.snapshot, w.shards, w.resolvers, w.all, group([
      phrase('m1', ['a', 'b']),
      phrase('m2', ['b', 'c']),
      phrase('m3', ['c', 'd']),
    ]));
    expect(rows(o)).toEqual([{ doc: 0, pos: 0, span: 4, members: [0, 1, 2] }]);
  });

  it('countOverlaps=true emits each match individually', async () => {
    const w = await world({ a: 'the dire wolf howled' });
    const o = occurrences(w.snapshot, w.shards, w.resolvers, w.all, group(
      [phrase('m1', ['dire', 'wolf']), token('m2', 'wolf')],
      true,
    ));
    expect(rows(o)).toEqual([
      { doc: 0, pos: 1, span: 2, members: [0] },
      { doc: 0, pos: 2, span: 1, members: [1] },
    ]);
  });
});

describe('binding checks', () => {
  it('rejects a selection bound to a different snapshot', async () => {
    const w1 = await world({ a: 'x' });
    const w2 = await world({ a: 'x y' });
    expect(() =>
      occurrences(w1.snapshot, w1.shards, w1.resolvers, w2.all, group([token('m1', 'x')])),
    ).toThrow(/different snapshot/);
  });

  it('rejects a FOREIGN shard+resolver pair substituted together', async () => {
    const w = await world({ a: 'x' });
    const foreignShard = await createDocumentIndex('y', await segment('y', 'en'), R);
    const foreignResolver = await buildResolver(foreignShard, R, FOLD);
    const shards = new Map([['a', foreignShard]]);
    const resolvers: ResolverTable = new Map([
      ['a', new Map([[modeKey(FOLD), foreignResolver]])],
    ]);
    expect(() =>
      occurrences(w.snapshot, shards, resolvers, w.all, group([token('m1', 'y')])),
    ).toThrow(/does not match the snapshot ref/);
  });

  it('rejects a genuine resolver filed under the wrong mode key', async () => {
    const w = await world({ a: 'Wolf wolf' });
    const byMode = w.resolvers.get('a')!;
    const swapped: ResolverTable = new Map([
      ['a', new Map([
        [modeKey(FOLD), byMode.get(modeKey(EXACT))!], // genuine resolvers,
        [modeKey(EXACT), byMode.get(modeKey(FOLD))!], //   swapped keys
      ])],
    ]);
    expect(() =>
      occurrences(w.snapshot, w.shards, swapped, w.all, group([token('m1', 'wolf', FOLD)])),
    ).toThrow(/was built for/);
  });

  it('rejects a resolver bound to a different shard object', async () => {
    const w = await world({ a: 'x' });
    const twin = await createDocumentIndex('x', await segment('x', 'en'), R);
    const twinResolver = await buildResolver(twin, R, FOLD);
    const resolvers: ResolverTable = new Map([
      ['a', new Map([[modeKey(FOLD), twinResolver]])],
    ]);
    expect(() =>
      occurrences(w.snapshot, w.shards, resolvers, w.all, group([token('m1', 'x')])),
    ).toThrow(/different shard/);
  });
});
