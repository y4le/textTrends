import { describe, expect, it } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex, type DocumentIndexV1 } from '../src/index/build.ts';
import { bindShards, bindTexts, type BoundShards, type BoundTexts } from '../src/ops/binding.ts';
import {
  buildConcordanceAxis,
  concordanceAxisPayloadBytes,
  copyConcordanceAxis,
  materializeConcordanceWindow,
  planConcordanceWindow,
} from '../src/ops/concordance.ts';
import { kwicPage } from '../src/ops/kwic.ts';
import type { NumericOccurrences } from '../src/ops/occurrences.ts';
import { segment } from '../src/segment/intl.ts';
import { composeSnapshot, makeReadyDocument, type CorpusSnapshotV1 } from '../src/snapshot/compose.ts';
import { resolveSelection, type ResolvedSelection } from '../src/snapshot/selection.ts';

const GEN = 'concordance-test' as BuildGeneration;

interface World {
  readonly snapshot: CorpusSnapshotV1;
  readonly selection: ResolvedSelection;
  readonly bound: BoundShards;
  readonly texts: BoundTexts;
}

async function world(source: Record<string, string>): Promise<World> {
  const shards = new Map<string, DocumentIndexV1>();
  const texts = new Map<string, string>();
  const ready = new Map();
  const docs = Object.keys(source) as ProjectDocId[];
  for (const doc of docs) {
    const text = source[doc] as string;
    const shard = await createDocumentIndex(text, await segment(text, 'en'), DEFAULT_INDEX_RECIPE);
    shards.set(doc, shard);
    texts.set(doc, text);
    ready.set(doc, await makeReadyDocument(doc, shard));
  }
  const snapshot = await composeSnapshot(GEN, docs, ready);
  const bound = await bindShards(snapshot, shards);
  const verifiedTexts = await bindTexts(snapshot, bound, texts);
  const selection = await resolveSelection(snapshot, { docs });
  return { snapshot, selection, bound, texts: verifiedTexts };
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

const rankRequest = (rank: number, before: number, after: number) => ({
  anchor: { kind: 'rank', rank } as const,
  before,
  after,
  contextTokens: 1,
});

describe('continuous concordance axis', () => {
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
    const axis = buildConcordanceAxis(w.snapshot, w.selection, [occurrence(w.selection, entries)]);
    const samples = copyConcordanceAxis(axis);

    expect(axis.total).toBe(134);
    expect(Array.from(samples.ranks)).toEqual([0, 132]);
    expect(Array.from(samples.globalTokens)).toEqual([0, 128]);

    for (const rank of [126, 127, 128, 129, 131, 132, 133]) {
      const window = planConcordanceWindow(
        w.snapshot,
        w.bound,
        w.selection,
        axis,
        [occurrence(w.selection, entries)],
        rankRequest(rank, 1, 1),
      );
      const oracle = kwicPage(w.snapshot, w.bound, w.selection, [occurrence(w.selection, entries)], {
        contextTokens: 1,
        sort: [{ at: 'doc', dir: 1 }, { at: 'pos', dir: 1 }],
        page: { offset: window.firstRank, limit: window.rows.length },
      });
      expect(window.rows.map((row) => [row.pos, row.spanTokens, row.members])).toEqual(
        oracle.rows.map((row) => [row.pos, row.spanTokens, row.members]),
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
    const axis = buildConcordanceAxis(w.snapshot, w.selection, tracks);
    const samples = copyConcordanceAxis(axis);
    expect(axis.total).toBe(288);
    expect(Array.from(samples.ranks)).toEqual([0, 287]);
    expect(Array.from(samples.globalTokens)).toEqual([0, 128]);
    expect(concordanceAxisPayloadBytes(axis)).toBe(16);

    const window = planConcordanceWindow(
      w.snapshot,
      w.bound,
      w.selection,
      axis,
      tracks,
      rankRequest(200, 2, 2),
    );
    const oracle = kwicPage(w.snapshot, w.bound, w.selection, tracks, {
      contextTokens: 1,
      sort: [{ at: 'doc', dir: 1 }, { at: 'pos', dir: 1 }],
      page: { offset: 198, limit: 5 },
    });
    expect(window.rows.map((row) => [row.trackOrdinal, row.pos, row.members])).toEqual(
      oracle.rows.map((row) => [row.trackOrdinal, row.pos, row.members]),
    );
  });

  it('returns independent transfer-safe axis copies', async () => {
    const w = await world({ a: 'a b c' });
    const axis = buildConcordanceAxis(w.snapshot, w.selection, [
      occurrence(w.selection, [{ doc: 0, pos: 1 }]),
    ]);
    const copy = copyConcordanceAxis(axis);
    copy.ranks[0] = 99;
    copy.globalTokens[0] = 99;
    const secondCopy = copyConcordanceAxis(axis);
    expect(Array.from(secondCopy.ranks)).toEqual([0]);
    expect(Array.from(secondCopy.globalTokens)).toEqual([1]);
    expect(concordanceAxisPayloadBytes(axis)).toBe(8);
    expect(() => copyConcordanceAxis({ ...axis })).toThrow(/unrecognized concordance axis/);
  });
});

describe('continuous concordance windows', () => {
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
    const axis = buildConcordanceAxis(w.snapshot, w.selection, tracks);
    const actual = planConcordanceWindow(
      w.snapshot,
      w.bound,
      w.selection,
      axis,
      tracks,
      rankRequest(0, 0, axis.total - 1),
    );
    const oracle = kwicPage(w.snapshot, w.bound, w.selection, tracks, {
      contextTokens: 1,
      sort: [{ at: 'doc', dir: 1 }, { at: 'pos', dir: 1 }],
      page: { offset: 0, limit: axis.total },
    });

    const identity = (row: typeof actual.rows[number]) => ({
      track: row.trackOrdinal,
      doc: row.docOrdinal,
      pos: row.pos,
      span: row.spanTokens,
      members: row.members,
      left: row.leftCharStart,
      nodeStart: row.nodeCharStart,
      nodeEnd: row.nodeCharEnd,
      right: row.rightCharEnd,
    });
    expect(actual.rows.map(identity)).toEqual(oracle.rows.map(identity));
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
    const axis = buildConcordanceAxis(w.snapshot, w.selection, [track]);
    const window = planConcordanceWindow(
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
    const axis = buildConcordanceAxis(w.snapshot, w.selection, tracks);
    const gap = planConcordanceWindow(w.snapshot, w.bound, w.selection, axis, tracks, {
      anchor: { kind: 'position', doc: 'a', token: 5 },
      before: 1,
      after: 2,
      contextTokens: 0,
    });
    expect(gap.anchorRank).toBe(1);
    expect(gap.preceding).toEqual({ rank: 0, globalToken: 2 });
    expect(gap.rows.map((row) => [row.docOrdinal, row.pos])).toEqual([[0, 2], [0, 7], [0, 7], [1, 1]]);

    const exact = planConcordanceWindow(w.snapshot, w.bound, w.selection, axis, tracks, {
      anchor: { kind: 'position', doc: 'a', token: 7 },
      before: 0,
      after: 1,
      contextTokens: 0,
    });
    expect(exact.anchorRank).toBe(1);
    expect(exact.preceding).toEqual({ rank: 0, globalToken: 2 });

    const tail = planConcordanceWindow(w.snapshot, w.bound, w.selection, axis, tracks, {
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
    const emptyAxis = buildConcordanceAxis(w.snapshot, w.selection, [emptyTrack]);
    expect(planConcordanceWindow(
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
    const axis = buildConcordanceAxis(w.snapshot, w.selection, [materializedTrack]);
    const numeric = planConcordanceWindow(
      w.snapshot,
      w.bound,
      w.selection,
      axis,
      [materializedTrack],
      rankRequest(0, 0, 0),
    );
    const materialized = materializeConcordanceWindow(
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
    expect(() => materializeConcordanceWindow(w.snapshot, numeric, w.texts, []))
      .toThrow(/requires 1 track identities/);
  });

  it('enforces admitted occurrence shapes, track counts, and duplicate-run bounds', async () => {
    const w = await world({ a: 'a b c d' });
    const base = occurrence(w.selection, [{ doc: 0, pos: 1 }]);
    expect(() => buildConcordanceAxis(w.snapshot, w.selection, [])).toThrow(/requires 1\.\.5 tracks/);
    expect(() => buildConcordanceAxis(w.snapshot, w.selection, Array.from({ length: 6 }, () => base)))
      .toThrow(/requires 1\.\.5 tracks/);

    const oversizedCount = 200_001;
    expect(() => buildConcordanceAxis(w.snapshot, w.selection, [{
      ...base,
      docOrdinal: new Uint32Array(oversizedCount),
      pos: new Uint32Array(oversizedCount),
      spanTokens: new Uint32Array(oversizedCount),
      memberOffsets: new Uint32Array(oversizedCount + 1),
      memberOrdinals: new Uint32Array(),
    }])).toThrow(/malformed occurrence arrays/);

    const oversizedMembers = 1_600_001;
    expect(() => buildConcordanceAxis(w.snapshot, w.selection, [{
      ...base,
      memberOffsets: Uint32Array.of(0, oversizedMembers),
      memberOrdinals: new Uint32Array(oversizedMembers),
    }])).toThrow(/malformed occurrence arrays/);

    expect(() => buildConcordanceAxis(w.snapshot, w.selection, [{
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
    expect(() => buildConcordanceAxis(w.snapshot, w.selection, [tooManyAtOneToken]))
      .toThrow(/duplicate run exceeds/);
  });

  it('rejects range-scoped selections, forged axes, stale tracks, and oversized windows', async () => {
    const w = await world({ a: 'a b c d' });
    const track = occurrence(w.selection, [{ doc: 0, pos: 1 }]);
    const ranged = await resolveSelection(w.snapshot, {
      docs: ['a' as ProjectDocId],
      ranges: [{ doc: 'a' as ProjectDocId, tokens: { start: 0 as never, end: 2 as never } }],
    });
    expect(() => buildConcordanceAxis(w.snapshot, ranged, [track])).toThrow(/full corpus/);

    const axis = buildConcordanceAxis(w.snapshot, w.selection, [track]);
    expect(() => planConcordanceWindow(w.snapshot, w.bound, w.selection, {
      ...axis,
    }, [track], rankRequest(0, 0, 0))).toThrow(/unrecognized concordance axis/);
    expect(() => buildConcordanceAxis(w.snapshot, w.selection, [{
      ...track,
      snapshot: 'stale',
    } as unknown as NumericOccurrences])).toThrow(/different snapshot/);
    expect(() => planConcordanceWindow(
      w.snapshot,
      w.bound,
      w.selection,
      axis,
      [track],
      rankRequest(0, 250, 250),
    )).toThrow(/1\.\.500 rows/);

    for (const rank of [-1, 0.5, 1]) {
      expect(() => planConcordanceWindow(
        w.snapshot,
        w.bound,
        w.selection,
        axis,
        [track],
        rankRequest(rank, 0, 0),
      )).toThrow(/rank must be in/);
    }
    expect(() => planConcordanceWindow(w.snapshot, w.bound, w.selection, axis, [], rankRequest(0, 0, 0)))
      .toThrow(/requires 1 tracks/);
    expect(() => planConcordanceWindow(
      w.snapshot,
      w.bound,
      w.selection,
      axis,
      [occurrence(w.selection, [{ doc: 0, pos: 0 }])],
      rankRequest(0, 0, 0),
    )).toThrow(/sampled frontier/);
    expect(() => planConcordanceWindow(w.snapshot, w.bound, w.selection, axis, [
      occurrence(w.selection, [{ doc: 0, pos: 0 }, { doc: 0, pos: 1 }]),
    ], rankRequest(0, 0, 0))).toThrow(/axis total/);

    const emptyTrack = occurrence(w.selection, []);
    const emptyAxis = buildConcordanceAxis(w.snapshot, w.selection, [emptyTrack]);
    expect(() => planConcordanceWindow(
      w.snapshot,
      w.bound,
      w.selection,
      emptyAxis,
      [emptyTrack],
      rankRequest(1, 0, 0),
    )).toThrow(/only rank zero/);
    expect(planConcordanceWindow(w.snapshot, w.bound, w.selection, emptyAxis, [emptyTrack], {
      anchor: { kind: 'position', doc: 'a', token: 2 },
      before: 0,
      after: 0,
      contextTokens: 0,
    }).rows).toEqual([]);
    expect(() => planConcordanceWindow(w.snapshot, w.bound, w.selection, axis, [track], {
      anchor: { kind: 'position', doc: 'a', token: 4 },
      before: 0,
      after: 0,
      contextTokens: 0,
    })).toThrow(/outside 'a'/);
  });
});
