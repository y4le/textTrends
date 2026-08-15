import { describe, expect, it } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex, tokenCharLength, type DocumentIndexV1 } from '../src/index/build.ts';
import { bindShards, bindTexts, type BoundShards, type BoundTexts } from '../src/ops/binding.ts';
import {
  buildMatchesAxis,
  matchesAxisPayloadBytes,
  copyMatchesAxis,
  materializeMatchesWindow,
  planMatchesWindow,
} from '../src/ops/matches.ts';
import { occurrences, type NumericOccurrences, type TermGroupSpec } from '../src/ops/occurrences.ts';
import {
  KWIC_CONTEXT_MAX_TOKENS,
  KWIC_CONTEXT_MAX_UTF16,
} from '../src/ops/kwic.ts';
import { buildResolver, modeKey, type MatchMode, type Resolver } from '../src/resolve/fold.ts';
import { segment } from '../src/segment/intl.ts';
import { composeSnapshot, makeReadyDocument, type CorpusSnapshotV1 } from '../src/snapshot/compose.ts';
import { resolveSelection, type ResolvedSelection } from '../src/snapshot/selection.ts';

const GEN = 'matches-test' as BuildGeneration;
const FOLD: MatchMode = { case: 'folded', diacritics: 'sensitive' };
const WOLF_GROUP: TermGroupSpec = {
  id: 'wolf',
  members: [{ id: 'wolf', kind: 'token', surface: 'wolf', match: FOLD }],
  countOverlaps: false,
};

interface World {
  readonly snapshot: CorpusSnapshotV1;
  readonly selection: ResolvedSelection;
  readonly shards: ReadonlyMap<string, DocumentIndexV1>;
  readonly resolvers: ReadonlyMap<string, ReadonlyMap<string, Resolver>>;
  readonly bound: BoundShards;
  readonly texts: BoundTexts;
}

async function world(source: Record<string, string>): Promise<World> {
  const shards = new Map<string, DocumentIndexV1>();
  const resolvers = new Map<string, Map<string, Resolver>>();
  const texts = new Map<string, string>();
  const ready = new Map();
  const docs = Object.keys(source) as ProjectDocId[];
  for (const doc of docs) {
    const text = source[doc] as string;
    const shard = await createDocumentIndex(text, await segment(text, 'en'), DEFAULT_INDEX_RECIPE);
    shards.set(doc, shard);
    resolvers.set(doc, new Map([
      [modeKey(FOLD), await buildResolver(shard, DEFAULT_INDEX_RECIPE, FOLD)],
    ]));
    texts.set(doc, text);
    ready.set(doc, await makeReadyDocument(doc, shard));
  }
  const snapshot = await composeSnapshot(GEN, docs, ready);
  const bound = await bindShards(snapshot, shards);
  const verifiedTexts = await bindTexts(snapshot, bound, texts);
  const selection = await resolveSelection(snapshot, { docs });
  return { snapshot, selection, shards, resolvers, bound, texts: verifiedTexts };
}

interface Entry {
  readonly doc: number;
  readonly pos: number;
  readonly span?: number;
  readonly members?: readonly number[];
}

function occurrence(selection: ResolvedSelection, entries: readonly Entry[]): NumericOccurrences {
  const memberOffsets = [0];
  const memberOrdinals: number[] = [];
  for (const entry of entries) {
    memberOrdinals.push(...(entry.members ?? [0]));
    memberOffsets.push(memberOrdinals.length);
  }
  return {
    snapshot: selection.snapshot,
    selection: selection.hash,
    docOrdinal: Uint32Array.from(entries.map((entry) => entry.doc)),
    pos: Uint32Array.from(entries.map((entry) => entry.pos)),
    spanTokens: Uint32Array.from(entries.map((entry) => entry.span ?? 1)),
    memberOffsets: Uint32Array.from(memberOffsets),
    memberOrdinals: Uint32Array.from(memberOrdinals),
  };
}

function referenceRows(tracks: readonly NumericOccurrences[]) {
  const rows = tracks.flatMap((track, trackOrdinal) => Array.from(
    { length: track.pos.length },
    (_, index) => {
      const memberStart = track.memberOffsets[index] as number;
      const memberEnd = track.memberOffsets[index + 1] as number;
      return {
        trackOrdinal,
        docOrdinal: track.docOrdinal[index] as number,
        pos: track.pos[index] as number,
        spanTokens: track.spanTokens[index] as number,
        members: Array.from(track.memberOrdinals.subarray(memberStart, memberEnd)),
      };
    },
  ));
  return rows.sort((left, right) => {
    const scalar = left.docOrdinal - right.docOrdinal
      || left.pos - right.pos
      || left.spanTokens - right.spanTokens
      || left.trackOrdinal - right.trackOrdinal;
    if (scalar !== 0) return scalar;
    const length = Math.min(left.members.length, right.members.length);
    for (let index = 0; index < length; index++) {
      const member = (left.members[index] as number) - (right.members[index] as number);
      if (member !== 0) return member;
    }
    return left.members.length - right.members.length;
  });
}

const rankRequest = (rank: number, before: number, after: number) => ({
  anchor: { kind: 'rank', rank } as const,
  before,
  after,
  contextTokens: 1,
});

function materializedRows(
  w: World,
  track: NumericOccurrences,
  contextTokens: number,
) {
  const axis = buildMatchesAxis(w.snapshot, w.selection, [track]);
  const numeric = planMatchesWindow(
    w.snapshot,
    w.bound,
    w.selection,
    axis,
    [track],
    {
      anchor: { kind: 'rank', rank: 0 },
      before: 0,
      after: Math.max(0, axis.total - 1),
      contextTokens,
    },
  );
  return materializeMatchesWindow(
    w.snapshot,
    numeric,
    w.texts,
    [{ seriesId: 'series', groupId: 'group' }],
  ).rows;
}

describe('continuous matches axis', () => {
  it('samples rank zero and only duplicate-run boundaries after the stride', async () => {
    const w = await world({ a: Array.from({ length: 300 }, (_, index) => `w${index}`).join(' ') });
    const entries: Entry[] = Array.from({ length: 127 }, (_, pos) => ({ doc: 0, pos }));
    entries.push(
      { doc: 0, pos: 127, span: 5, members: [4] },
      { doc: 0, pos: 127, span: 4, members: [3] },
      { doc: 0, pos: 127, span: 3, members: [2] },
      { doc: 0, pos: 127, span: 2, members: [1] },
      { doc: 0, pos: 127, span: 1, members: [0] },
      { doc: 0, pos: 128 },
      { doc: 0, pos: 129 },
    );
    const axis = buildMatchesAxis(w.snapshot, w.selection, [occurrence(w.selection, entries)]);
    const samples = copyMatchesAxis(axis);

    expect(axis.total).toBe(134);
    expect(Array.from(samples.ranks)).toEqual([0, 132]);
    expect(Array.from(samples.globalTokens)).toEqual([0, 128]);

    for (const rank of [126, 127, 128, 129, 131, 132, 133]) {
      const window = planMatchesWindow(
        w.snapshot,
        w.bound,
        w.selection,
        axis,
        [occurrence(w.selection, entries)],
        rankRequest(rank, 1, 1),
      );
      const oracle = referenceRows([occurrence(w.selection, entries)])
        .slice(window.firstRank, window.firstRank + window.rows.length);
      expect(window.rows.map((row) => [row.pos, row.spanTokens, row.members])).toEqual(
        oracle.map((row) => [row.pos, row.spanTokens, row.members]),
      );
    }
  });

  it('admits the maximum 160-row run and preserves the exact stride-plus-159 bound', async () => {
    const w = await world({ a: Array.from({ length: 300 }, (_, index) => `w${index}`).join(' ') });
    const tracks = Array.from({ length: 5 }, (_, trackOrdinal) => occurrence(w.selection, [
      ...(trackOrdinal === 0
        ? Array.from({ length: 127 }, (_, pos) => ({ doc: 0, pos }))
        : []),
      ...Array.from({ length: 32 }, (_, member) => ({
        doc: 0,
        pos: 127,
        members: [31 - member],
      })),
      ...(trackOrdinal === 0 ? [{ doc: 0, pos: 128 }] : []),
    ]));
    const axis = buildMatchesAxis(w.snapshot, w.selection, tracks);
    const samples = copyMatchesAxis(axis);
    expect(axis.total).toBe(288);
    expect(Array.from(samples.ranks)).toEqual([0, 287]);
    expect(Array.from(samples.globalTokens)).toEqual([0, 128]);
    expect(matchesAxisPayloadBytes(axis)).toBe(16);

    const window = planMatchesWindow(
      w.snapshot,
      w.bound,
      w.selection,
      axis,
      tracks,
      rankRequest(200, 2, 2),
    );
    const oracle = referenceRows(tracks).slice(198, 203);
    expect(window.rows.map((row) => [row.trackOrdinal, row.pos, row.members])).toEqual(
      oracle.map((row) => [row.trackOrdinal, row.pos, row.members]),
    );
  });

  it('returns independent transfer-safe axis copies', async () => {
    const w = await world({ a: 'a b c' });
    const axis = buildMatchesAxis(w.snapshot, w.selection, [
      occurrence(w.selection, [{ doc: 0, pos: 1 }]),
    ]);
    const copy = copyMatchesAxis(axis);
    copy.ranks[0] = 99;
    copy.globalTokens[0] = 99;
    const secondCopy = copyMatchesAxis(axis);
    expect(Array.from(secondCopy.ranks)).toEqual([0]);
    expect(Array.from(secondCopy.globalTokens)).toEqual([1]);
    expect(matchesAxisPayloadBytes(axis)).toBe(8);
    expect(() => copyMatchesAxis({ ...axis })).toThrow(/unrecognized matches axis/);
  });
});

describe('continuous matches windows', () => {
  it('is byte-for-byte ordered like current reading-order KWIC, including duplicate ties', async () => {
    const w = await world({ a: 'zero one two three four five six seven' });
    const tracks = [
      occurrence(w.selection, [
        { doc: 0, pos: 2, span: 3, members: [1] },
        { doc: 0, pos: 2, span: 1, members: [2] },
        { doc: 0, pos: 5, members: [0] },
      ]),
      occurrence(w.selection, [
        { doc: 0, pos: 2, span: 2, members: [0] },
        { doc: 0, pos: 2, span: 1, members: [1, 3] },
        { doc: 0, pos: 6, members: [0] },
      ]),
    ];
    const axis = buildMatchesAxis(w.snapshot, w.selection, tracks);
    const actual = planMatchesWindow(
      w.snapshot,
      w.bound,
      w.selection,
      axis,
      tracks,
      rankRequest(0, 0, axis.total - 1),
    );
    const oracle = referenceRows(tracks);

    const identity = (row: typeof actual.rows[number]) => ({
      track: row.trackOrdinal,
      doc: row.docOrdinal,
      pos: row.pos,
      span: row.spanTokens,
      members: row.members,
    });
    expect(actual.rows.map(identity)).toEqual(oracle.map((row) => ({
      track: row.trackOrdinal,
      doc: row.docOrdinal,
      pos: row.pos,
      span: row.spanTokens,
      members: row.members,
    })));
    expect(actual.rows.map((row) => [row.pos, row.spanTokens, row.trackOrdinal])).toEqual([
      [2, 1, 0],
      [2, 1, 1],
      [2, 2, 1],
      [2, 3, 0],
      [5, 1, 0],
      [6, 1, 1],
    ]);
  });

  it('restores a deep rank window from the preceding sparse sample', async () => {
    const w = await world({ a: Array.from({ length: 300 }, (_, index) => `w${index}`).join(' ') });
    const track = occurrence(w.selection, Array.from({ length: 300 }, (_, pos) => ({ doc: 0, pos })));
    const axis = buildMatchesAxis(w.snapshot, w.selection, [track]);
    const window = planMatchesWindow(
      w.snapshot,
      w.bound,
      w.selection,
      axis,
      [track],
      rankRequest(257, 2, 2),
    );

    expect(window.firstRank).toBe(255);
    expect(window.anchorRank).toBe(257);
    expect(window.rows.map((row) => row.pos)).toEqual([255, 256, 257, 258, 259]);
  });

  it('brackets gaps, exact duplicate starts, and the corpus tail without snapping', async () => {
    const w = await world({ a: 'a b c d e f g h i j', b: 'k l m n o p q r' });
    const tracks = [
      occurrence(w.selection, [
        { doc: 0, pos: 2 },
        { doc: 0, pos: 7, span: 2 },
        { doc: 1, pos: 1 },
      ]),
      occurrence(w.selection, [{ doc: 0, pos: 7 }]),
    ];
    const axis = buildMatchesAxis(w.snapshot, w.selection, tracks);
    const gap = planMatchesWindow(w.snapshot, w.bound, w.selection, axis, tracks, {
      anchor: { kind: 'position', doc: 'a', token: 5 },
      before: 1,
      after: 2,
      contextTokens: 0,
    });
    expect(gap.anchorRank).toBe(1);
    expect(gap.preceding).toEqual({ rank: 0, globalToken: 2 });
    expect(gap.rows.map((row) => [row.docOrdinal, row.pos])).toEqual([[0, 2], [0, 7], [0, 7], [1, 1]]);

    const exact = planMatchesWindow(w.snapshot, w.bound, w.selection, axis, tracks, {
      anchor: { kind: 'position', doc: 'a', token: 7 },
      before: 0,
      after: 1,
      contextTokens: 0,
    });
    expect(exact.anchorRank).toBe(1);
    expect(exact.preceding).toEqual({ rank: 0, globalToken: 2 });

    const tail = planMatchesWindow(w.snapshot, w.bound, w.selection, axis, tracks, {
      anchor: { kind: 'position', doc: 'b', token: 7 },
      before: 1,
      after: 1,
      contextTokens: 0,
    });
    expect(tail.anchorRank).toBe(3);
    expect(tail.preceding).toEqual({ rank: 3, globalToken: 11 });
  });

  it('handles an empty result and materializes only bounded verified text rows', async () => {
    const w = await world({ a: 'zero one two three' });
    const emptyTrack = occurrence(w.selection, []);
    const emptyAxis = buildMatchesAxis(w.snapshot, w.selection, [emptyTrack]);
    expect(planMatchesWindow(
      w.snapshot,
      w.bound,
      w.selection,
      emptyAxis,
      [emptyTrack],
      rankRequest(0, 2, 2),
    )).toEqual({
      snapshot: w.snapshot.id,
      total: 0,
      trackCount: 1,
      anchorRank: null,
      firstRank: 0,
      preceding: null,
      rows: [],
    });

    const materializedTrack = occurrence(w.selection, [{ doc: 0, pos: 2, members: [4] }]);
    const axis = buildMatchesAxis(w.snapshot, w.selection, [materializedTrack]);
    const numeric = planMatchesWindow(
      w.snapshot,
      w.bound,
      w.selection,
      axis,
      [materializedTrack],
      rankRequest(0, 0, 0),
    );
    const materialized = materializeMatchesWindow(
      w.snapshot,
      numeric,
      w.texts,
      [{ seriesId: 'series', groupId: 'group' }],
    );
    expect(materialized.rows).toEqual([{
      seriesId: 'series',
      groupId: 'group',
      doc: 'a',
      pos: 2,
      members: [4],
      node: { start: 9, end: 12 },
      left: 'one ',
      nodeText: 'two',
      right: ' three',
    }]);
    expect(() => materializeMatchesWindow(w.snapshot, numeric, w.texts, []))
      .toThrow(/requires 1 track identities/);
  });

  it('materializes raw source text rather than normalized vocabulary keys', async () => {
    const w = await world({ a: 'he said isn’t twice' });
    const group: TermGroupSpec = {
      id: 'apostrophe',
      members: [{ id: 'apostrophe', kind: 'token', surface: "isn't", match: FOLD }],
      countOverlaps: false,
    };
    const track = occurrences(w.snapshot, w.shards, w.resolvers, w.selection, group);
    expect(materializedRows(w, track, 0)[0]!.nodeText).toBe('isn’t');
  });

  it('keeps UTF-16 spans valid through astral context characters', async () => {
    const w = await world({ a: 'I 😀 saw the wolf 😀 again' });
    const track = occurrences(w.snapshot, w.shards, w.resolvers, w.selection, WOLF_GROUP);
    const row = materializedRows(w, track, 2)[0]!;
    expect(row.nodeText).toBe('wolf');
    expect(row.left).toContain('saw');
    expect(row.right).toContain('again');
  });

  it('clamps context at document edges and spans overflow tokens completely', async () => {
    const long = 'a'.repeat(300);
    const w = await world({ a: `wolf ${long} wolf` });
    const track = occurrences(w.snapshot, w.shards, w.resolvers, w.selection, WOLF_GROUP);
    const rows = materializedRows(w, track, 2);
    expect(rows[0]!.left).toBe('');
    expect(rows[0]!.right).toContain(long);
    expect(rows[1]!.left).toContain(long);
    expect(rows[1]!.right).toBe('');
  });

  it('caps materialized context without splitting UTF-16 surrogate pairs', async () => {
    const long = `${'a'.repeat(KWIC_CONTEXT_MAX_UTF16 - 2)}😀${'b'.repeat(100)}`;
    const w = await world({ a: `wolf ${long} wolf` });
    const track = occurrences(w.snapshot, w.shards, w.resolvers, w.selection, WOLF_GROUP);
    const rows = materializedRows(w, track, 2);
    expect(rows[0]!.right.length).toBeLessThanOrEqual(KWIC_CONTEXT_MAX_UTF16);
    expect(rows[1]!.left.length).toBeLessThanOrEqual(KWIC_CONTEXT_MAX_UTF16);
    for (const context of [rows[0]!.right, rows[1]!.left]) {
      const first = context.charCodeAt(0);
      const last = context.charCodeAt(context.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it('guards token character-length positions before span materialization', async () => {
    const w = await world({ a: 'one two' });
    const shard = w.shards.get('a')!;
    expect(tokenCharLength(shard, 0)).toBe(3);
    expect(() => tokenCharLength(shard, -1)).toThrow(RangeError);
    expect(() => tokenCharLength(shard, 0.5)).toThrow(RangeError);
    expect(() => tokenCharLength(shard, 2)).toThrow(RangeError);
  });

  it('enforces admitted occurrence shapes, track counts, and duplicate-run bounds', async () => {
    const w = await world({ a: 'a b c d' });
    const base = occurrence(w.selection, [{ doc: 0, pos: 1 }]);
    expect(() => buildMatchesAxis(w.snapshot, w.selection, [])).toThrow(/requires 1\.\.5 tracks/);
    expect(() => buildMatchesAxis(w.snapshot, w.selection, Array.from({ length: 6 }, () => base)))
      .toThrow(/requires 1\.\.5 tracks/);

    const oversizedCount = 200_001;
    expect(() => buildMatchesAxis(w.snapshot, w.selection, [{
      ...base,
      docOrdinal: new Uint32Array(oversizedCount),
      pos: new Uint32Array(oversizedCount),
      spanTokens: new Uint32Array(oversizedCount),
      memberOffsets: new Uint32Array(oversizedCount + 1),
      memberOrdinals: new Uint32Array(),
    }])).toThrow(/malformed occurrence arrays/);

    const oversizedMembers = 1_600_001;
    expect(() => buildMatchesAxis(w.snapshot, w.selection, [{
      ...base,
      memberOffsets: Uint32Array.of(0, oversizedMembers),
      memberOrdinals: new Uint32Array(oversizedMembers),
    }])).toThrow(/malformed occurrence arrays/);

    expect(() => buildMatchesAxis(w.snapshot, w.selection, [{
      ...base,
      docOrdinal: Uint32Array.of(0, 0),
      pos: Uint32Array.of(1, 2),
      spanTokens: Uint32Array.of(1, 1),
      memberOffsets: Uint32Array.of(0, 2, 1),
      memberOrdinals: Uint32Array.of(0),
    }])).toThrow(/outside declared corpus order/);

    const tooManyAtOneToken = occurrence(
      w.selection,
      Array.from({ length: 33 }, (_, member) => ({ doc: 0, pos: 1, members: [member] })),
    );
    expect(() => buildMatchesAxis(w.snapshot, w.selection, [tooManyAtOneToken]))
      .toThrow(/duplicate run exceeds/);
  });

  it('rejects range-scoped selections, forged axes, stale tracks, and oversized windows', async () => {
    const w = await world({ a: 'a b c d' });
    const track = occurrence(w.selection, [{ doc: 0, pos: 1 }]);
    const ranged = await resolveSelection(w.snapshot, {
      docs: ['a' as ProjectDocId],
      ranges: [{ doc: 'a' as ProjectDocId, tokens: { start: 0 as never, end: 2 as never } }],
    });
    expect(() => buildMatchesAxis(w.snapshot, ranged, [track])).toThrow(/full corpus/);

    const axis = buildMatchesAxis(w.snapshot, w.selection, [track]);
    expect(() => planMatchesWindow(w.snapshot, w.bound, w.selection, {
      ...axis,
    }, [track], rankRequest(0, 0, 0))).toThrow(/unrecognized matches axis/);
    expect(() => buildMatchesAxis(w.snapshot, w.selection, [{
      ...track,
      snapshot: 'stale',
    } as unknown as NumericOccurrences])).toThrow(/different snapshot/);
    expect(() => planMatchesWindow(
      w.snapshot,
      w.bound,
      w.selection,
      axis,
      [track],
      rankRequest(0, 250, 250),
    )).toThrow(/1\.\.500 rows/);
    expect(() => planMatchesWindow(
      w.snapshot,
      w.bound,
      w.selection,
      axis,
      [track],
      {
        ...rankRequest(0, 0, 0),
        contextTokens: KWIC_CONTEXT_MAX_TOKENS + 1,
      },
    )).toThrow(/contextTokens must be/);

    for (const rank of [-1, 0.5, 1]) {
      expect(() => planMatchesWindow(
        w.snapshot,
        w.bound,
        w.selection,
        axis,
        [track],
        rankRequest(rank, 0, 0),
      )).toThrow(/rank must be in/);
    }
    expect(() => planMatchesWindow(w.snapshot, w.bound, w.selection, axis, [], rankRequest(0, 0, 0)))
      .toThrow(/requires 1 tracks/);
    expect(() => planMatchesWindow(
      w.snapshot,
      w.bound,
      w.selection,
      axis,
      [occurrence(w.selection, [{ doc: 0, pos: 0 }])],
      rankRequest(0, 0, 0),
    )).toThrow(/sampled frontier/);
    expect(() => planMatchesWindow(w.snapshot, w.bound, w.selection, axis, [
      occurrence(w.selection, [{ doc: 0, pos: 0 }, { doc: 0, pos: 1 }]),
    ], rankRequest(0, 0, 0))).toThrow(/axis total/);

    const emptyTrack = occurrence(w.selection, []);
    const emptyAxis = buildMatchesAxis(w.snapshot, w.selection, [emptyTrack]);
    expect(() => planMatchesWindow(
      w.snapshot,
      w.bound,
      w.selection,
      emptyAxis,
      [emptyTrack],
      rankRequest(1, 0, 0),
    )).toThrow(/only rank zero/);
    expect(planMatchesWindow(w.snapshot, w.bound, w.selection, emptyAxis, [emptyTrack], {
      anchor: { kind: 'position', doc: 'a', token: 2 },
      before: 0,
      after: 0,
      contextTokens: 0,
    }).rows).toEqual([]);
    expect(() => planMatchesWindow(w.snapshot, w.bound, w.selection, axis, [track], {
      anchor: { kind: 'position', doc: 'a', token: 4 },
      before: 0,
      after: 0,
      contextTokens: 0,
    })).toThrow(/outside 'a'/);
  });
});
