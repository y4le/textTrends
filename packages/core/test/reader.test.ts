import { describe, expect, it } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { CapError } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex, tokenEndChar, type DocumentIndexV1 } from '../src/index/build.ts';
import { bindShards, bindTexts, type BoundTexts } from '../src/ops/binding.ts';
import { occurrences, type NumericOccurrences, type TermGroupSpec } from '../src/ops/occurrences.ts';
import {
  materializeReaderPage,
  planReaderPage,
  READER_MAX_MARKS,
  READER_MAX_TEXT_UTF16,
  READER_MAX_TOKENS,
  READER_MAX_TRACKS,
  type ReaderCursor,
  type ReaderPageResult,
} from '../src/ops/reader.ts';
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
  texts: BoundTexts;
  all: ResolvedSelection;
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
    ready.set(id, await makeReadyDocument(id, shard));
  }
  const snapshot = await composeSnapshot(GEN, ids, ready);
  const bound = await bindShards(snapshot, shards);
  const boundTexts = await bindTexts(snapshot, bound, textMap);
  const all = await resolveSelection(snapshot, { docs: ids });
  return { snapshot, shards, resolvers, texts: boundTexts, all };
}

const tokenGroup = (id: string, surface: string): TermGroupSpec => ({
  id,
  members: [{ id: `${id}:m`, kind: 'token', surface, match: FOLD }],
  countOverlaps: false,
});

function occOf(w: World, group: TermGroupSpec, selection: ResolvedSelection = w.all): NumericOccurrences {
  return occurrences(w.snapshot, w.shards, w.resolvers, selection, group);
}

function pageOf(
  w: World,
  doc: string,
  cursor: ReaderCursor,
  maxTokens: number,
  tracks: readonly NumericOccurrences[] = [],
): ReaderPageResult {
  const shard = w.shards.get(doc)!;
  const plan = planReaderPage(w.snapshot, doc, shard, cursor, maxTokens, tracks);
  return materializeReaderPage(
    w.snapshot,
    plan,
    w.texts,
    tracks.map((_, i) => ({ seriesId: `s${i}`, groupId: `g${i}` })),
  );
}

const words = (n: number, len = 0): string =>
  Array.from({ length: n }, (_, i) => `w${String(i).padStart(4, '0')}${'x'.repeat(len)}`).join(' ');

describe('reader paging (zero tracks)', () => {
  it('a from-page serves the canonical page containing its cursor and relative token extents', async () => {
    const w = await world({ a: 'one two three four five six seven eight' });
    const p = pageOf(w, 'a', { kind: 'from', token: 2 }, 3);
    expect(p.tokens).toEqual({ start: 0, end: 3 });
    expect(p.tokens.start).toBeLessThan(2); // from(t) need not start at interior t
    expect(p.text).toBe('one two three');
    expect(p.tokenStartsUtf16.length).toBe(3);
    expect(p.text.slice(p.tokenStartsUtf16[0]!, p.tokenEndsUtf16[0]!)).toBe('one');
    expect(p.text.slice(p.tokenStartsUtf16[2]!, p.tokenEndsUtf16[2]!)).toBe('three');
    expect(p.docTokenCount).toBe(8);
    expect(p.anchor).toBeNull();
    expect(p.marks).toEqual([]);
    expect(p.marksTruncated).toBe(false);
  });

  it('a before-page serves the canonical page containing token cursor - 1', async () => {
    const w = await world({ a: 'one two three four five six seven eight' });
    const p = pageOf(w, 'a', { kind: 'before', token: 6 }, 3);
    expect(p.tokens).toEqual({ start: 3, end: 6 });
    expect(p.text).toBe('four five six');
    // An interior before cursor resolves to the page containing token 1.
    const head = pageOf(w, 'a', { kind: 'before', token: 2 }, 5);
    expect(head.tokens).toEqual({ start: 0, end: 5 });
    expect(head.atStart).toBe(true);
    expect(head.previous).toBeNull();
  });

  it('around retains its anchor mid-doc and at both document edges', async () => {
    const w = await world({ a: 'one two three four five six seven eight' });
    const mid = pageOf(w, 'a', { kind: 'around', token: 4 }, 3);
    expect(mid.tokens).toEqual({ start: 3, end: 6 });
    expect(mid.anchor).toEqual({ token: 4, relToken: 1, charsUtf16: { start: 5, end: 9 } });
    expect(mid.text.slice(mid.anchor!.charsUtf16.start, mid.anchor!.charsUtf16.end)).toBe('five');
    const left = pageOf(w, 'a', { kind: 'around', token: 0 }, 3);
    expect(left.tokens).toEqual({ start: 0, end: 3 }); // shifted, size kept
    expect(left.anchor!.relToken).toBe(0);
    const right = pageOf(w, 'a', { kind: 'around', token: 7 }, 3);
    expect(right.tokens).toEqual({ start: 6, end: 8 });
    expect(right.anchor!.relToken).toBe(1);
    expect(right.text.slice(right.anchor!.charsUtf16.start, right.anchor!.charsUtf16.end)).toBe('eight');
  });

  it('adjacent token pages tile without token gaps; inter-page separators are deliberately omitted', async () => {
    const w = await world({ a: words(10) });
    const pages: ReaderPageResult[] = [];
    let cursor: ReaderCursor = { kind: 'from', token: 0 };
    for (;;) {
      const p = pageOf(w, 'a', cursor, 4);
      pages.push(p);
      if (p.next === null) break;
      cursor = p.next; // no client arithmetic — the served cursor drives
    }
    expect(pages.map((p) => [p.tokens.start, p.tokens.end])).toEqual([[0, 4], [4, 8], [8, 10]]);
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i]!.tokens.start).toBe(pages[i - 1]!.tokens.end);
      expect(pages[i]!.docCharsUtf16.start).toBeGreaterThan(pages[i - 1]!.docCharsUtf16.end);
    }
    expect(pages.reduce((sum, page) => sum + page.text.length, 0))
      .toBeLessThan(pages.at(-1)!.docCharsUtf16.end - pages[0]!.docCharsUtf16.start);
    expect(pages[0]!.atStart).toBe(true);
    expect(pages[0]!.previous).toBeNull();
    expect(pages.at(-1)!.atEnd).toBe(true);
    expect(pages.at(-1)!.next).toBeNull();
    // Backward round-trip: before(start) ends exactly where each page starts.
    for (let i = pages.length - 1; i > 0; i--) {
      const prev = pageOf(w, 'a', pages[i]!.previous!, 4);
      expect(prev.tokens.end).toBe(pages[i]!.tokens.start);
      expect(prev.tokens).toEqual(pages[i - 1]!.tokens);
    }
  });

  it('round-trips the reviewer counterexample exactly under canonical text-capped boundaries', async () => {
    const text = `${'y'.repeat(32_765)} a b ${'z'.repeat(32_768)}`;
    const w = await world({ a: text });
    const shard = w.shards.get('a')!;
    expect(shard.tokenTypeIds.length).toBe(4);
    expect(Array.from(shard.startsUtf16)).toEqual([0, 32_766, 32_768, 32_770]);
    expect(Array.from({ length: 4 }, (_, i) =>
      tokenEndChar(shard, i) - (shard.startsUtf16[i] as number))).toEqual([32_765, 1, 1, 32_768]);

    const forward: [number, number][] = [];
    let next: ReaderCursor = { kind: 'from', token: 0 };
    for (;;) {
      const page = pageOf(w, 'a', next, 400);
      forward.push([page.tokens.start, page.tokens.end]);
      if (page.next === null) break;
      next = page.next;
    }
    expect(forward).toEqual([[0, 2], [2, 3], [3, 4]]);

    const backward: [number, number][] = [];
    let previous: ReaderCursor = { kind: 'before', token: 4 };
    for (;;) {
      const page = pageOf(w, 'a', previous, 400);
      backward.push([page.tokens.start, page.tokens.end]);
      if (page.previous === null) break;
      previous = page.previous;
    }
    expect(backward).toEqual([...forward].reverse());
    for (const walk of [forward, backward]) {
      const served = walk.flatMap(([start, end]) =>
        Array.from({ length: end - start }, (_, i) => start + i));
      expect(new Set(served).size).toBe(4);
      expect([...served].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    }
  });

  it('matches a seeded brute-force partition in forward, backward, and mixed walks', async () => {
    let seed = 0x5eed1234;
    const lengths = Array.from({ length: 240 }, () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return 1 + (seed % 4000);
    });
    const w = await world({
      a: lengths.map((length, i) => `${String.fromCharCode(97 + (i % 26))}${'x'.repeat(length - 1)}`).join(' '),
    });
    const shard = w.shards.get('a')!;
    expect(shard.tokenTypeIds.length).toBe(240);

    const budget = 20;
    const oracle: [number, number][] = [];
    for (let start = 0; start < lengths.length;) {
      const maxEnd = Math.min(lengths.length, start + budget);
      let end = start;
      while (
        end < maxEnd &&
        tokenEndChar(shard, end) - (shard.startsUtf16[start] as number) <= READER_MAX_TEXT_UTF16
      ) {
        end++;
      }
      if (end === start) end++; // total partition across an oversized island
      oracle.push([start, end]);
      start = end;
    }
    const pageSizes = new Set(oracle.map(([start, end]) => end - start));
    expect(pageSizes.size).toBeGreaterThan(1); // self-guard: the text cap must bind
    expect(
      Math.max(...oracle.map(([start, end]) =>
        tokenEndChar(shard, end - 1) - (shard.startsUtf16[start] as number))),
    ).toBeGreaterThan(READER_MAX_TEXT_UTF16 * 0.9);

    const forward: [number, number][] = [];
    let next: ReaderCursor = { kind: 'from', token: 0 };
    for (;;) {
      const page = pageOf(w, 'a', next, budget);
      forward.push([page.tokens.start, page.tokens.end]);
      if (page.next === null) break;
      next = page.next;
    }
    expect(forward).toEqual(oracle);

    const backward: [number, number][] = [];
    let previous: ReaderCursor = { kind: 'before', token: lengths.length };
    for (;;) {
      const page = pageOf(w, 'a', previous, budget);
      backward.push([page.tokens.start, page.tokens.end]);
      if (page.previous === null) break;
      previous = page.previous;
    }
    expect(backward).toEqual([...oracle].reverse());

    for (let token = 0; token < lengths.length; token++) {
      const expected = oracle.find(([start, end]) => start <= token && token < end)!;
      const cappedBy = new Set<ReaderPageResult['cappedBy']>();
      for (const cursor of [
        { kind: 'from', token },
        { kind: 'around', token },
        { kind: 'before', token: token + 1 },
      ] as const) {
        const page = pageOf(w, 'a', cursor, budget);
        expect([page.tokens.start, page.tokens.end]).toEqual(expected);
        cappedBy.add(page.cappedBy);
      }
      expect(cappedBy.size).toBe(1); // direction-free for one canonical page
    }

    const p0 = pageOf(w, 'a', { kind: 'from', token: 0 }, budget);
    const p1 = pageOf(w, 'a', p0.next!, budget);
    const p2 = pageOf(w, 'a', p1.next!, budget);
    const back1 = pageOf(w, 'a', p2.previous!, budget);
    const forward2 = pageOf(w, 'a', back1.next!, budget);
    const backAgain = pageOf(w, 'a', forward2.previous!, budget);
    expect(p0.tokens.end).toBe(p1.tokens.start);
    expect(p1.tokens.end).toBe(p2.tokens.start);
    expect(back1.tokens).toEqual(p1.tokens);
    expect(forward2.tokens).toEqual(p2.tokens);
    expect(backAgain.tokens).toEqual(p1.tokens);
  });

  it('reports cappedBy: tokens when the budget stops short of the document, null at the edge', async () => {
    const w = await world({ a: words(10) });
    const capped = pageOf(w, 'a', { kind: 'from', token: 0 }, 4);
    expect(capped.cappedBy).toBe('tokens');
    const tail = pageOf(w, 'a', { kind: 'from', token: 8 }, 4);
    expect(tail.cappedBy).toBeNull(); // document edge, not a cap
    const whole = pageOf(w, 'a', { kind: 'from', token: 0 }, 10);
    expect(whole.cappedBy).toBeNull();
    expect(whole.atStart).toBe(true);
    expect(whole.atEnd).toBe(true);
  });

  it('clamps maxTokens above READER_MAX_TOKENS instead of rejecting, and reports it', async () => {
    const w = await world({ a: words(READER_MAX_TOKENS + 50) });
    const p = pageOf(w, 'a', { kind: 'from', token: 0 }, READER_MAX_TOKENS + 1000);
    expect(p.tokens).toEqual({ start: 0, end: READER_MAX_TOKENS });
    expect(p.cappedBy).toBe('tokens');
    expect(pageOf(w, 'a', { kind: 'from', token: READER_MAX_TOKENS - 1 }, READER_MAX_TOKENS).tokens)
      .toEqual(p.tokens); // raw 400 and clamped 1400 have one effective partition
  });

  it('treats the effective maxTokens budget as part of partition identity', async () => {
    const w = await world({ a: words(11) });
    expect(pageOf(w, 'a', { kind: 'from', token: 4 }, 4).tokens)
      .toEqual({ start: 4, end: 8 });
    expect(pageOf(w, 'a', { kind: 'from', token: 4 }, 5).tokens)
      .toEqual({ start: 0, end: 5 });
  });

  it('rejects invalid cursors and maxTokens (including zero-token docs) instead of clamping', async () => {
    const w = await world({ a: 'one two', b: '' });
    const shard = w.shards.get('a')!;
    const plan = (cursor: ReaderCursor, max = 10, doc = 'a', s = shard) =>
      planReaderPage(w.snapshot, doc, s, cursor, max, []);
    expect(() => plan({ kind: 'from', token: 2 })).toThrow(RangeError);
    expect(() => plan({ kind: 'around', token: -1 })).toThrow(RangeError);
    expect(() => plan({ kind: 'before', token: 0 })).toThrow(RangeError); // nothing before 0
    expect(() => plan({ kind: 'before', token: 3 })).toThrow(RangeError);
    expect(() => plan({ kind: 'from', token: 0 }, 0)).toThrow(/maxTokens/);
    expect(() => plan({ kind: 'from', token: 0.5 })).toThrow(RangeError);
    expect(() => planReaderPage(w.snapshot, 'zz', shard, { kind: 'from', token: 0 }, 10, []))
      .toThrow(/not a member/);
    const shardB = w.shards.get('b')!;
    for (const kind of ['around', 'from', 'before'] as const) {
      expect(() => plan({ kind, token: 0 }, 10, 'b', shardB)).toThrow(RangeError);
    }
  });
});

describe('reader text cap', () => {
  // Words long enough that 400 of them exceed the UTF-16 cap.
  const LONG = 120;

  it('the first canonical page reports the text cap and round-trips exactly', async () => {
    const w = await world({ a: words(400, LONG) });
    const p = pageOf(w, 'a', { kind: 'from', token: 0 }, 400);
    expect(p.cappedBy).toBe('text');
    expect(p.tokens.start).toBe(0);
    expect(p.tokens.end).toBeLessThan(400);
    expect(p.docCharsUtf16.end - p.docCharsUtf16.start).toBeLessThanOrEqual(READER_MAX_TEXT_UTF16);
    expect(p.text.length).toBe(p.docCharsUtf16.end - p.docCharsUtf16.start);
    // The shrunken page still tiles: the next page starts where this ended.
    const next = pageOf(w, 'a', p.next!, 400);
    expect(next.tokens.start).toBe(p.tokens.end);
    // ... and before(start) of the NEXT page ends exactly at the boundary.
    const back = pageOf(w, 'a', next.previous!, 400);
    expect(back.tokens.end).toBe(next.tokens.start);
  });

  it('a before cursor on the document end resolves to the final canonical page', async () => {
    const w = await world({ a: words(400, LONG) });
    const p = pageOf(w, 'a', { kind: 'before', token: 400 }, 400);
    expect(p.cappedBy).toBeNull(); // document edge, not the prior page's text cap
    expect(p.tokens.end).toBe(400);
    expect(p.tokens.start).toBeGreaterThan(0);
    expect(p.docCharsUtf16.end - p.docCharsUtf16.start).toBeLessThanOrEqual(READER_MAX_TEXT_UTF16);
  });

  it('an around-page shrinks toward its anchor and always retains it', async () => {
    const w = await world({ a: words(400, LONG) });
    const p = pageOf(w, 'a', { kind: 'around', token: 200 }, 400);
    expect(p.cappedBy).toBe('text');
    expect(p.tokens.start).toBeLessThanOrEqual(200);
    expect(p.tokens.end).toBeGreaterThan(200);
    expect(p.text.slice(p.anchor!.charsUtf16.start, p.anchor!.charsUtf16.end)).toContain('w0200');
  });

  it('a single token exceeding the text cap is CapError in every mode, never a sliced token', async () => {
    const w = await world({ a: `tiny ${'y'.repeat(READER_MAX_TEXT_UTF16 + 1)} tiny` });
    const shard = w.shards.get('a')!;
    const plan = (cursor: ReaderCursor) => planReaderPage(w.snapshot, 'a', shard, cursor, 400, []);
    expect(() => plan({ kind: 'from', token: 1 })).toThrow(CapError);
    expect(() => plan({ kind: 'around', token: 1 })).toThrow(CapError);
    expect(() => plan({ kind: 'before', token: 2 })).toThrow(CapError);
    // A page whose shrink can step OFF the oversized token serves honestly.
    const p = pageOf(w, 'a', { kind: 'from', token: 0 }, 400);
    expect(p.tokens).toEqual({ start: 0, end: 1 });
    expect(p.text).toBe('tiny');
    expect(p.cappedBy).toBe('text');
  });

  it('keeps an oversized token as an unservable island while an explicit post-island cursor can serve the tail', async () => {
    const huge = 'y'.repeat(READER_MAX_TEXT_UTF16 + 1);
    const w = await world({ a: `head ${huge} tail done` });
    const shard = w.shards.get('a')!;
    const plan = (cursor: ReaderCursor) =>
      planReaderPage(w.snapshot, 'a', shard, cursor, 400, []);
    expect(() => plan({ kind: 'from', token: 1 })).toThrow(CapError);
    expect(() => plan({ kind: 'around', token: 1 })).toThrow(CapError);
    expect(() => plan({ kind: 'before', token: 2 })).toThrow(CapError);

    const head = pageOf(w, 'a', { kind: 'before', token: 1 }, 400);
    expect(head.tokens).toEqual({ start: 0, end: 1 });
    expect(head.next).toEqual({ kind: 'from', token: 1 });
    const tail = pageOf(w, 'a', { kind: 'from', token: 2 }, 400);
    expect(tail.tokens).toEqual({ start: 2, end: 4 });
    expect(tail.text).toBe('tail done');
  });
});

describe('reader marks', () => {
  it('an occurrence straddling a page boundary appears on BOTH pages, clipped and flagged', async () => {
    const w = await world({ a: 'x dire wolf y z' });
    const phrase: TermGroupSpec = {
      id: 'gp',
      members: [
        { id: 'p', kind: 'phrase', surfaces: ['dire', 'wolf'], match: FOLD, crossSentence: false },
      ],
      countOverlaps: false,
    };
    const occ = occOf(w, phrase);
    // Boundary between 'dire' (token 1) and 'wolf' (token 2).
    const left = pageOf(w, 'a', { kind: 'from', token: 0 }, 2, [occ]);
    expect(left.tokens).toEqual({ start: 0, end: 2 });
    expect(left.marks.length).toBe(1);
    const lm = left.marks[0]!;
    expect(lm.tokens).toEqual({ start: 1, end: 3 }); // FULL occurrence identity
    expect(lm.clippedStart).toBe(false);
    expect(lm.clippedEnd).toBe(true);
    expect(left.text.slice(lm.charsUtf16.start, lm.charsUtf16.end)).toBe('dire');

    const right = pageOf(w, 'a', { kind: 'from', token: 2 }, 2, [occ]);
    expect(right.tokens).toEqual({ start: 2, end: 4 });
    expect(right.marks.length).toBe(1);
    const rm = right.marks[0]!;
    expect(rm.tokens).toEqual({ start: 1, end: 3 }); // same occurrence, same identity
    expect(rm.clippedStart).toBe(true);
    expect(rm.clippedEnd).toBe(false);
    expect(right.text.slice(rm.charsUtf16.start, rm.charsUtf16.end)).toBe('wolf');
  });

  it('fully contained occurrences are unclipped; occurrences outside the page are absent', async () => {
    const w = await world({ a: 'wolf a b wolf c d wolf' });
    const occ = occOf(w, tokenGroup('g', 'wolf'));
    const p = pageOf(w, 'a', { kind: 'from', token: 3 }, 3, [occ]); // canonical tokens [3,6)
    expect(p.marks.length).toBe(1);
    expect(p.marks[0]!.tokens).toEqual({ start: 3, end: 4 });
    expect(p.marks[0]!.clippedStart).toBe(false);
    expect(p.marks[0]!.clippedEnd).toBe(false);
    expect(p.text.slice(p.marks[0]!.charsUtf16.start, p.marks[0]!.charsUtf16.end)).toBe('wolf');
  });

  it('marks carry track ordinals and member evidence, sorted by relative char start', async () => {
    const w = await world({ a: 'the dire wolf saw a wolf cub' });
    const merged: TermGroupSpec = {
      id: 'gm',
      members: [
        { id: 'm0', kind: 'phrase', surfaces: ['dire', 'wolf'], match: FOLD, crossSentence: false },
        { id: 'm1', kind: 'token', surface: 'wolf', match: FOLD },
      ],
      countOverlaps: false,
    };
    const tracks = [occOf(w, merged), occOf(w, tokenGroup('gc', 'cub'))];
    const p = pageOf(w, 'a', { kind: 'from', token: 0 }, 7, tracks);
    expect(p.marks.map((m) => m.seriesId)).toEqual(['s0', 's0', 's1']);
    expect(p.marks.map((m) => m.groupId)).toEqual(['g0', 'g0', 'g1']);
    // The merged 'dire wolf' span reports BOTH contributing members.
    expect(p.marks[0]!.members).toEqual([0, 1]);
    expect(p.text.slice(p.marks[0]!.charsUtf16.start, p.marks[0]!.charsUtf16.end)).toBe('dire wolf');
    expect(p.marks[1]!.members).toEqual([1]);
    const starts = p.marks.map((m) => m.charsUtf16.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('marks come from the supplied occurrence slice for THIS doc only', async () => {
    const w = await world({ a: 'wolf x', b: 'x wolf wolf' });
    const occ = occOf(w, tokenGroup('g', 'wolf'));
    const p = pageOf(w, 'b', { kind: 'from', token: 0 }, 3, [occ]);
    expect(p.marks.map((m) => m.tokens.start)).toEqual([1, 2]);
    const pa = pageOf(w, 'a', { kind: 'from', token: 0 }, 2, [occ]);
    expect(pa.marks.map((m) => m.tokens.start)).toEqual([0]);
  });

  it('caps total marks at READER_MAX_MARKS with an explicit truncated flag', async () => {
    // 13 identical members with countOverlaps=true: 402 tokens × 13 = 5226
    // member matches on a 402-token page — over the 5000 cap.
    const memberCount = 13;
    const w = await world({ a: Array.from({ length: READER_MAX_TOKENS + 2 }, () => 'wolf').join(' ') });
    const dense: TermGroupSpec = {
      id: 'gd',
      members: Array.from({ length: memberCount }, (_, i) => ({
        id: `m${i}`, kind: 'token' as const, surface: 'wolf', match: FOLD,
      })),
      countOverlaps: true,
    };
    const occ = occOf(w, dense);
    const p = pageOf(w, 'a', { kind: 'from', token: 0 }, READER_MAX_TOKENS, [occ]);
    expect(p.marksTruncated).toBe(true);
    expect(p.marks.length).toBe(READER_MAX_MARKS);
    // A page under the cap is complete and unflagged.
    const small = pageOf(w, 'a', { kind: 'from', token: 0 }, 10, [occ]);
    expect(small.marksTruncated).toBe(false);
    expect(small.marks.length).toBe(10 * memberCount);
  });

  it('mark buffers are fresh — never views over the occurrence cache', async () => {
    const w = await world({ a: 'wolf a wolf' });
    const occ = occOf(w, tokenGroup('g', 'wolf'));
    const plan = planReaderPage(
      w.snapshot, 'a', w.shards.get('a')!, { kind: 'from', token: 0 }, 3, [occ],
    );
    expect(plan.markMemberOrdinals.buffer).not.toBe(occ.memberOrdinals.buffer);
    expect(plan.markTokenStart.buffer).not.toBe(occ.pos.buffer);
  });

  it('rejects too many tracks, foreign-snapshot tracks, and mixed-selection tracks', async () => {
    const w = await world({ a: 'wolf a wolf' });
    const shard = w.shards.get('a')!;
    const occ = occOf(w, tokenGroup('g', 'wolf'));
    const six = Array.from({ length: READER_MAX_TRACKS + 1 }, () => occ);
    expect(() => planReaderPage(w.snapshot, 'a', shard, { kind: 'from', token: 0 }, 3, six))
      .toThrow(/at most/);
    const other = await world({ a: 'wolf a wolf b' }); // distinct snapshot id
    const foreign = occOf(other, tokenGroup('g', 'wolf'));
    expect(() => planReaderPage(w.snapshot, 'a', shard, { kind: 'from', token: 0 }, 3, [foreign]))
      .toThrow(/different snapshot/);
    const narrower = await resolveSelection(w.snapshot, {
      docs: ['a'] as ProjectDocId[],
      ranges: [{ doc: 'a' as ProjectDocId, tokens: { start: 0 as never, end: 1 as never } }],
    });
    const mixed = occOf(w, tokenGroup('g', 'wolf'), narrower);
    expect(() => planReaderPage(w.snapshot, 'a', shard, { kind: 'from', token: 0 }, 3, [occ, mixed]))
      .toThrow(/differing selections/);
  });
});

describe('reader materialization', () => {
  it('refuses a plan or texts from a different snapshot', async () => {
    const w1 = await world({ a: 'one two three' });
    const w2 = await world({ a: 'one two three four' });
    const plan = planReaderPage(
      w1.snapshot, 'a', w1.shards.get('a')!, { kind: 'from', token: 0 }, 3, [],
    );
    expect(() => materializeReaderPage(w2.snapshot, plan, w2.texts, [])).toThrow(RangeError);
    expect(() => materializeReaderPage(w1.snapshot, plan, w2.texts, [])).toThrow(RangeError);
  });

  it('refuses a mark whose numeric track ordinal has no identity binding', async () => {
    const w = await world({ a: 'wolf waits' });
    const occ = occOf(w, tokenGroup('g', 'wolf'));
    const plan = planReaderPage(
      w.snapshot, 'a', w.shards.get('a')!, { kind: 'from', token: 0 }, 2, [occ],
    );
    expect(() => materializeReaderPage(w.snapshot, plan, w.texts, []))
      .toThrow(/unknown track ordinal/);
  });

  it('serves UTF-16 offsets that slice surrogate pairs cleanly', async () => {
    const w = await world({ a: 'a 𝔴𝔬𝔩𝔣 b' });
    const p = pageOf(w, 'a', { kind: 'around', token: 1 }, 3);
    expect(p.text.slice(p.anchor!.charsUtf16.start, p.anchor!.charsUtf16.end)).toBe('𝔴𝔬𝔩𝔣');
  });
});
