import { describe, expect, it } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { rootOnlyV2 } from './support/root-only-structure.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex, type DocumentIndexV1 } from '../src/index/build.ts';
import { occurrences, termGroupIdentity, type ResolverTable, type TermGroupSpec } from '../src/ops/occurrences.ts';
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
    ready.set(id, await makeReadyDocument(id, shard, rootOnlyV2(text, shard.text)));
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

  it('multi-doc, multi-range selections match per range in declared order', async () => {
    const w = await world({ a: 'wolf x wolf y wolf', b: 'wolf z wolf' });
    const sel = await resolveSelection(w.snapshot, {
      docs: ['b', 'a'] as ProjectDocId[],
      ranges: [
        { doc: 'a' as ProjectDocId, tokens: { start: 0 as never, end: 1 as never } },
        { doc: 'a' as ProjectDocId, tokens: { start: 4 as never, end: 5 as never } },
        { doc: 'b' as ProjectDocId, tokens: { start: 2 as never, end: 3 as never } },
      ],
    });
    const o = occurrences(w.snapshot, w.shards, w.resolvers, sel, group([token('m1', 'wolf')]));
    expect(rows(o)).toEqual([
      { doc: 0, pos: 0, span: 1, members: [0] }, // wolf@2 excluded (unselected)
      { doc: 0, pos: 4, span: 1, members: [0] },
      { doc: 1, pos: 2, span: 1, members: [0] }, // wolf@0 excluded
    ]);
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

  it('a sentence bound exactly at phrase start or end does not cross; strictly inside does', async () => {
    const w = await world({ a: 'One two. Wolf howled. Dire wolf.' });
    // Pin the geometry: sentence bounds at tokens 0, 2 ('Wolf'), 4 ('Dire'), 6 (end).
    expect(Array.from(w.shards.get('a')!.sentenceBounds)).toEqual([0, 2, 4, 6]);
    // 'wolf howled' spans [2, 4): the bound AT its start (2) and AT its end (4)
    // both leave it inside one sentence — half-open on both edges.
    expect(rows(occurrences(w.snapshot, w.shards, w.resolvers, w.all, group([
      phrase('m1', ['wolf', 'howled'], false),
    ]))).map((r) => r.pos)).toEqual([2]);
    // 'dire wolf' spans [4, 6): the bound AT start (4) and AT start+span (6)
    // do not cross — including the final bound at the document edge.
    expect(rows(occurrences(w.snapshot, w.shards, w.resolvers, w.all, group([
      phrase('m1', ['dire', 'wolf'], false),
    ]))).map((r) => r.pos)).toEqual([4]);
    // 'howled dire' spans [3, 5): the bound at 4 lies strictly inside — crossing.
    expect(rows(occurrences(w.snapshot, w.shards, w.resolvers, w.all, group([
      phrase('m1', ['howled', 'dire'], false),
    ])))).toEqual([]);
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

describe('termGroupIdentity — the canonical matching key (not group.id)', () => {
  it('is stable across the caller-owned provenance ids (group.id and member ids)', () => {
    const a = { id: 'gA', members: [token('m1', 'wolf', FOLD)], countOverlaps: false };
    const b = { id: 'gB', members: [token('DIFFERENT', 'wolf', FOLD)], countOverlaps: false };
    expect(termGroupIdentity(a)).toBe(termGroupIdentity(b));
  });

  // Exhaustive: EVERY field that can change `NumericOccurrences` must change the
  // identity. Each row is a pair that must NOT share a key. The match modes
  // below vary case and diacritics independently (the I/İ class of bug).
  const CASE_FOLD: MatchMode = { case: 'folded', diacritics: 'sensitive' };
  const DIA_FOLD: MatchMode = { case: 'sensitive', diacritics: 'folded' };
  const prefix = (stem: string, match: MatchMode = FOLD) => ({ id: 'm', kind: 'prefix' as const, stem, match });
  const suffix = (stem: string, match: MatchMode = FOLD) => ({ id: 'm', kind: 'suffix' as const, stem, match });
  it.each<[string, TermGroupSpec, TermGroupSpec]>([
    ['token surface', group([token('m', 'wolf', FOLD)]), group([token('m', 'fox', FOLD)])],
    ['token case mode', group([token('m', 'wolf', CASE_FOLD)]), group([token('m', 'wolf', EXACT)])],
    ['token diacritic mode', group([token('m', 'wolf', DIA_FOLD)]), group([token('m', 'wolf', EXACT)])],
    ['countOverlaps', group([token('m', 'wolf', FOLD)], false), group([token('m', 'wolf', FOLD)], true)],
    ['kind (token vs phrase)', group([token('m', 'wolf', FOLD)]), group([phrase('m', ['wolf'])])],
    ['phrase surface content', group([phrase('m', ['dire', 'wolf'])]), group([phrase('m', ['dire', 'fox'])])],
    ['phrase surface ORDER', group([phrase('m', ['dire', 'wolf'])]), group([phrase('m', ['wolf', 'dire'])])],
    ['phrase crossSentence', group([phrase('m', ['dire', 'wolf'], false)]), group([phrase('m', ['dire', 'wolf'], true)])],
    ['prefix vs suffix (same stem)', group([prefix('wolf')]), group([suffix('wolf')])],
    ['affix stem', group([prefix('wolf')]), group([prefix('fox')])],
    ['affix match mode', group([prefix('wolf', CASE_FOLD)]), group([prefix('wolf', EXACT)])],
  ])('distinguishes %s', (_name, a, b) => {
    expect(termGroupIdentity(a)).not.toBe(termGroupIdentity(b));
  });

  it('depends on member ORDER — memberOrdinals index into members', () => {
    const ab = group([token('m1', 'wolf', FOLD), token('m2', 'fox', FOLD)]);
    const ba = group([token('m1', 'fox', FOLD), token('m2', 'wolf', FOLD)]);
    expect(termGroupIdentity(ab)).not.toBe(termGroupIdentity(ba));
  });

  it('keeps distinct surfaces distinct even when a guessed en fold would unify them', () => {
    // The store used a fixed `en` fold that collapsed I and İ; the matching
    // identity keys on the surface, so the two never share a cache slot.
    const upperI = group([token('m', 'I', { case: 'folded', diacritics: 'folded' })]);
    const dottedI = group([token('m', 'İ', { case: 'folded', diacritics: 'folded' })]);
    expect(termGroupIdentity(upperI)).not.toBe(termGroupIdentity(dottedI));
  });

  it('does not validate — a malformed group still yields a deterministic key (occurrences validates)', () => {
    const empty = { id: 'g', members: [phrase('p', [])], countOverlaps: false };
    expect(() => termGroupIdentity(empty)).not.toThrow();
    expect(termGroupIdentity(empty)).toBe(termGroupIdentity(empty));
  });
});
