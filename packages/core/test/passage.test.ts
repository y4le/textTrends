import { describe, expect, it } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { CapError } from '../src/contract/brands.ts';
import { rootOnlyStructure } from '../src/contract/identity.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex, type DocumentIndexV1 } from '../src/index/build.ts';
import { bindShards, bindTexts, type BoundTexts } from '../src/ops/binding.ts';
import { checkedResolverFor, type TermGroupSpec } from '../src/ops/occurrences.ts';
import {
  materializePassage,
  PASSAGE_MAX_UTF16,
  planPassage,
  type PassageTrackSpec,
} from '../src/ops/passage.ts';
import { buildResolver, modeKey, type MatchMode, type Resolver } from '../src/resolve/fold.ts';
import { segment } from '../src/segment/intl.ts';
import { composeSnapshot, makeReadyDocument, type CorpusSnapshotV1 } from '../src/snapshot/compose.ts';

const R = DEFAULT_INDEX_RECIPE;
const GEN = 'g' as BuildGeneration;
const FOLD: MatchMode = { case: 'folded', diacritics: 'sensitive' };

interface World {
  snapshot: CorpusSnapshotV1;
  shards: Map<string, DocumentIndexV1>;
  resolvers: Map<string, Map<string, Resolver>>;
  texts: BoundTexts;
}

async function world(texts: Record<string, string>): Promise<World> {
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
  const snapshot = await composeSnapshot(GEN, ids, ready);
  const bound = await bindShards(snapshot, shards);
  const boundTexts = await bindTexts(snapshot, bound, textMap);
  return { snapshot, shards, resolvers, texts: boundTexts };
}

const token = (id: string, surface: string): TermGroupSpec => ({
  id,
  members: [{ id: `${id}:m`, kind: 'token', surface, match: FOLD }],
  countOverlaps: false,
});

function passageOf(
  w: World,
  doc: string,
  center: number,
  maxTokens: number,
  tracks: readonly PassageTrackSpec[],
) {
  const shard = w.shards.get(doc)!;
  const ref = w.snapshot.docs.find((r) => r.doc === doc)!;
  const resolverFor = checkedResolverFor(doc, ref.index, shard, w.resolvers.get(doc)!);
  const plan = planPassage(
    w.snapshot, doc, shard, resolverFor, tracks.map((t) => t.group), center, maxTokens,
  );
  return materializePassage(w.snapshot, plan, w.texts, tracks);
}

describe('passage', () => {
  it('serves a token-symmetric block, shifted at document edges', async () => {
    const w = await world({ a: 'one two three four five six seven eight' });
    const mid = passageOf(w, 'a', 4, 3, []);
    expect(mid.tokens).toEqual({ start: 3, end: 6 });
    expect(mid.text).toBe('four five six');
    const left = passageOf(w, 'a', 0, 3, []);
    expect(left.tokens).toEqual({ start: 0, end: 3 }); // shifted, size kept
    const right = passageOf(w, 'a', 7, 3, []);
    expect(right.tokens).toEqual({ start: 5, end: 8 });
  });

  it('centerCharsUtf16 and per-token extents are relative to the served text', async () => {
    const w = await world({ a: 'alpha beta gamma' });
    const p = passageOf(w, 'a', 1, 3, []);
    expect(p.text).toBe('alpha beta gamma');
    expect(p.text.slice(p.centerCharsUtf16.start, p.centerCharsUtf16.end)).toBe('beta');
    expect(p.tokenStartsUtf16.length).toBe(3);
    expect(p.text.slice(p.tokenStartsUtf16[2]!, p.tokenEndsUtf16[2]!)).toBe('gamma');
  });

  it('marks carry series identity and relative char spans that slice to the surface', async () => {
    const w = await world({ a: 'the wolf saw a wolf cub' });
    const tracks: PassageTrackSpec[] = [
      { seriesId: 's-wolf', group: token('g1', 'wolf') },
      { seriesId: 's-cub', group: token('g2', 'cub') },
    ];
    const p = passageOf(w, 'a', 3, 200, tracks);
    expect(p.marks.map((m) => m.seriesId)).toEqual(['s-wolf', 's-wolf', 's-cub']);
    for (const m of p.marks) {
      const surface = p.text.slice(m.charsUtf16.start, m.charsUtf16.end);
      expect(surface.toLowerCase()).toBe(m.seriesId === 's-cub' ? 'cub' : 'wolf');
    }
    // Sorted by relative char start.
    const starts = p.marks.map((m) => m.charsUtf16.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('a phrase occurrence is marked only when FULLY contained in the block', async () => {
    const w = await world({ a: 'x dire wolf y z' });
    const phrase: TermGroupSpec = {
      id: 'gp',
      members: [
        { id: 'p', kind: 'phrase', surfaces: ['dire', 'wolf'], match: FOLD, crossSentence: false },
      ],
      countOverlaps: false,
    };
    const track = [{ seriesId: 's', group: phrase }];
    const whole = passageOf(w, 'a', 2, 200, track);
    expect(whole.marks.length).toBe(1);
    expect(whole.text.slice(whole.marks[0]!.charsUtf16.start, whole.marks[0]!.charsUtf16.end)).toBe('dire wolf');
    // Block ['wolf','y','z'] contains only the phrase's tail — no fragment mark.
    const tail = passageOf(w, 'a', 3, 3, track);
    expect(tail.tokens).toEqual({ start: 2, end: 5 });
    expect(tail.marks.length).toBe(0);
  });

  it('surrogate pairs: char offsets are UTF-16 code units and slice cleanly', async () => {
    const w = await world({ a: 'a 𝔴𝔬𝔩𝔣 b' });
    const p = passageOf(w, 'a', 1, 200, []);
    expect(p.text.slice(p.centerCharsUtf16.start, p.centerCharsUtf16.end)).toBe('𝔴𝔬𝔩𝔣');
  });

  it('a malformed group (empty phrase) is RangeError from planning, not an internal fault', async () => {
    const w = await world({ a: 'one two three' });
    const shard = w.shards.get('a')!;
    const ref = w.snapshot.docs.find((r) => r.doc === 'a')!;
    const rf = checkedResolverFor('a', ref.index, shard, w.resolvers.get('a')!);
    const emptyPhrase: TermGroupSpec = {
      id: 'g-bad',
      members: [{ id: 'p', kind: 'phrase', surfaces: [], match: FOLD, crossSentence: false }],
      countOverlaps: false,
    };
    expect(() => planPassage(w.snapshot, 'a', shard, rf, [emptyPhrase], 1, 3)).toThrow(RangeError);
  });

  it('rejects an out-of-range center (including zero-token docs) instead of clamping', async () => {
    const w = await world({ a: 'one two', b: '' });
    const shard = w.shards.get('a')!;
    const ref = w.snapshot.docs.find((r) => r.doc === 'a')!;
    const rf = checkedResolverFor('a', ref.index, shard, w.resolvers.get('a')!);
    expect(() => planPassage(w.snapshot, 'a', shard, rf, [], 2, 10)).toThrow(RangeError);
    expect(() => planPassage(w.snapshot, 'a', shard, rf, [], -1, 10)).toThrow(RangeError);
    const shardB = w.shards.get('b')!;
    const refB = w.snapshot.docs.find((r) => r.doc === 'b')!;
    const rfB = checkedResolverFor('b', refB.index, shardB, w.resolvers.get('b')!);
    expect(() => planPassage(w.snapshot, 'b', shardB, rfB, [], 0, 10)).toThrow(RangeError);
  });

  it('shrinks around the center under the char cap and reports the shrink', async () => {
    // Words long enough that 200 of them exceed the UTF-16 cap.
    const wordLength = 120;
    const words = Array.from({ length: 200 }, (_, i) => `w${String(i).padStart(3, '0')}${'x'.repeat(wordLength)}`);
    const w = await world({ a: words.join(' ') });
    const p = passageOf(w, 'a', 100, 200, []);
    expect(p.truncatedByCharCap).toBe(true);
    expect(p.docCharsUtf16.end - p.docCharsUtf16.start).toBeLessThanOrEqual(PASSAGE_MAX_UTF16);
    // The center token is still inside the served block.
    expect(p.tokens.start).toBeLessThanOrEqual(100);
    expect(p.tokens.end).toBeGreaterThan(100);
    expect(p.text.slice(p.centerCharsUtf16.start, p.centerCharsUtf16.end)).toContain('w100');
  });

  it('a single token exceeding the char cap is CapError, never a partial token', async () => {
    const w = await world({ a: `tiny ${'y'.repeat(PASSAGE_MAX_UTF16 + 1)} tiny` });
    const shard = w.shards.get('a')!;
    const ref = w.snapshot.docs.find((r) => r.doc === 'a')!;
    const rf = checkedResolverFor('a', ref.index, shard, w.resolvers.get('a')!);
    expect(() => planPassage(w.snapshot, 'a', shard, rf, [], 1, 200)).toThrow(CapError);
  });

  it('materialization refuses a plan from a different snapshot', async () => {
    const w1 = await world({ a: 'one two three' });
    const w2 = await world({ a: 'one two three four' });
    const shard = w1.shards.get('a')!;
    const ref = w1.snapshot.docs.find((r) => r.doc === 'a')!;
    const rf = checkedResolverFor('a', ref.index, shard, w1.resolvers.get('a')!);
    const plan = planPassage(w1.snapshot, 'a', shard, rf, [], 1, 3);
    expect(() => materializePassage(w2.snapshot, plan, w2.texts, [])).toThrow(RangeError);
  });
});
