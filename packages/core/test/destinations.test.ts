import { describe, expect, it, vi } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex, type DocumentIndexV1 } from '../src/index/build.ts';
import { bindShards, bindTexts, type BoundShards, type BoundTexts } from '../src/ops/binding.ts';
import {
  createDestinationsScratch,
  destinationIntegerSqrt,
  destinationScratchBytes,
  materializeDestinations,
  planDestinationWindowSpikeV0,
  planDestinations,
  DESTINATION_COUNT_CAP,
  DESTINATION_MAX_MARKS,
  DESTINATION_MAX_RARITY_WEIGHT,
  DESTINATION_MAX_RESULTS,
  DESTINATION_PER_DOC_KEEP,
  DESTINATION_SCORE_SCALE,
  DESTINATION_SNIPPET_TOKENS,
  DESTINATION_SNIPPET_UTF16,
  DESTINATION_SNIPPET_UTF8,
  type DestinationFocusV1,
  type DestinationsRequestV1,
  type DestinationTrackInputV1,
  type NumericDestinationV1,
} from '../src/ops/destinations.ts';
import { collectTokenWindowMarks, collectTokenWindowMarksLimited } from '../src/ops/marks.ts';
import type { NumericOccurrences } from '../src/ops/occurrences.ts';
import { segment } from '../src/segment/intl.ts';
import { composeSnapshot, makeReadyDocument, type CorpusSnapshotV1 } from '../src/snapshot/compose.ts';
import { resolveSelection, type ResolvedSelection } from '../src/snapshot/selection.ts';

interface Row {
  readonly doc: number;
  readonly pos: number;
  readonly span?: number;
}

function coordinates(tokenCounts: readonly number[]): {
  snapshot: CorpusSnapshotV1;
  selection: ResolvedSelection;
} {
  const docs = tokenCounts.map((tokenCount, index) => ({
    doc: `d${index}`,
    index: `index-${index}`,
    localToCorpusType: new Uint32Array(),
    sequenceTokenBase: tokenCounts.slice(0, index).reduce((sum, value) => sum + value, 0),
    tokenCount,
  }));
  const snapshot = {
    schema: 'texttrends/corpus-snapshot/1',
    id: 'snapshot',
    generation: 'generation',
    expectedDocs: docs.map((doc) => doc.doc),
    docs,
    missingDocs: [],
    vocabulary: { schema: 'texttrends/snapshot-vocabulary/1', keys: [], hash: 'vocabulary' },
  } as unknown as CorpusSnapshotV1;
  const selection = {
    snapshot: snapshot.id,
    spec: { docs: docs.map((doc) => doc.doc) },
    hash: 'selection',
    docSet: new Set(docs.map((doc) => doc.doc)),
    rangesByDoc: new Map(),
  } as unknown as ResolvedSelection;
  return { snapshot, selection };
}

function occurrence(rows: readonly Row[], selection: ResolvedSelection): NumericOccurrences {
  const sorted = [...rows].sort((left, right) =>
    left.doc - right.doc || left.pos - right.pos || (right.span ?? 1) - (left.span ?? 1));
  return {
    snapshot: selection.snapshot,
    selection: selection.hash,
    docOrdinal: Uint32Array.from(sorted, (row) => row.doc),
    pos: Uint32Array.from(sorted, (row) => row.pos),
    spanTokens: Uint32Array.from(sorted, (row) => row.span ?? 1),
    memberOffsets: new Uint32Array(sorted.length + 1),
    memberOrdinals: new Uint32Array(),
  };
}

function trackInputs(
  selection: ResolvedSelection,
  rows: readonly (readonly Row[])[],
): readonly DestinationTrackInputV1[] {
  return rows.map((track, index) => ({
    seriesId: `s${index}`,
    groupId: `g${index}`,
    occurrences: occurrence(track, selection),
  }));
}

const request = (
  focus: DestinationFocusV1 | null = null,
): DestinationsRequestV1 => ({
  method: 'destinations/1',
  windowTokens: 400,
  limit: DESTINATION_MAX_RESULTS,
  focus,
});

interface OracleCandidate {
  docOrdinal: number;
  score: number;
  present: number;
  total: number;
  start: number;
  end: number;
  anchor: number;
  anchorTrack: number;
  counts: number[];
}

function oracleOrder(left: OracleCandidate, right: OracleCandidate): number {
  return right.score - left.score
    || right.present - left.present
    || right.total - left.total
    || left.docOrdinal - right.docOrdinal
    || left.start - right.start
    || left.anchor - right.anchor
    || left.anchorTrack - right.anchorTrack;
}

function oraclePlan(
  tokenCounts: readonly number[],
  rows: readonly (readonly Row[])[],
  focus: DestinationFocusV1 | null,
  windowTokens = 400,
): NumericDestinationV1[] {
  const totals = rows.map((track) => track.length);
  const maximum = Math.max(0, ...totals);
  const weights = totals.map((total) => Math.min(
    DESTINATION_MAX_RARITY_WEIGHT,
    Math.floor(DESTINATION_SCORE_SCALE * maximum / Math.max(total, 1)),
  ));
  const byDoc: OracleCandidate[][] = Array.from({ length: tokenCounts.length }, () => []);
  for (let doc = 0; doc < tokenCounts.length; doc++) {
    const positions = [...new Set(rows.flatMap((track) =>
      track.filter((row) => row.doc === doc).map((row) => row.pos)))].sort((a, b) => a - b);
    const candidates: OracleCandidate[] = [];
    for (const anchor of positions) {
      const start = Math.min(
        Math.max(0, anchor - Math.floor(windowTokens / 2)),
        Math.max(0, tokenCounts[doc]! - windowTokens),
      );
      const end = Math.min(tokenCounts[doc]!, start + windowTokens);
      const counts = rows.map((track) => track.filter((row) =>
        row.doc === doc && row.pos >= start && row.pos < end).length);
      if (focus && (counts[focus.a] === 0 || counts[focus.b] === 0)) continue;
      const present = counts.filter((count) => count > 0).length;
      const weighted = counts.reduce((sum, count, track) => sum + weights[track]!
        * Math.floor(Math.sqrt(DESTINATION_SCORE_SCALE * Math.min(count, DESTINATION_COUNT_CAP))), 0);
      const anchorTracks = rows.flatMap((track, trackOrdinal) =>
        track.some((row) => row.doc === doc && row.pos === anchor) ? [trackOrdinal] : []);
      anchorTracks.sort((left, right) => weights[right]! - weights[left]! || left - right);
      candidates.push({
        docOrdinal: doc,
        score: present * weighted,
        present,
        total: counts.reduce((sum, count) => sum + count, 0),
        start,
        end,
        anchor,
        anchorTrack: anchorTracks[0]!,
        counts,
      });
    }

    let first = -1;
    let previous = -1;
    let best: OracleCandidate | null = null;
    const collapsed: OracleCandidate[] = [];
    for (const candidate of candidates) {
      if (
        best
        && (candidate.anchor - previous >= windowTokens
          || candidate.anchor - first > 4 * windowTokens)
      ) {
        collapsed.push(best);
        best = null;
        first = -1;
      }
      if (first < 0) first = candidate.anchor;
      previous = candidate.anchor;
      if (!best || oracleOrder(candidate, best) < 0) best = candidate;
    }
    if (best) collapsed.push(best);
    byDoc[doc] = collapsed.sort(oracleOrder).slice(0, DESTINATION_PER_DOC_KEEP);
  }

  const activeDocs = byDoc.filter((candidates) => candidates.length > 0).length;
  const perDocLimit = activeDocs === 0 ? 0 : Math.min(
    DESTINATION_PER_DOC_KEEP,
    Math.ceil(DESTINATION_MAX_RESULTS / Math.min(activeDocs, 4)),
  );
  const accepted: OracleCandidate[] = [];
  const acceptedByDoc = new Uint8Array(tokenCounts.length);
  for (let depth = 0; depth < DESTINATION_PER_DOC_KEEP; depth++) {
    const round = byDoc.flatMap((candidates) => candidates[depth] ? [candidates[depth]!] : [])
      .sort(oracleOrder);
    for (const candidate of round) {
      if (acceptedByDoc[candidate.docOrdinal]! >= perDocLimit) continue;
      if (accepted.some((prior) => prior.docOrdinal === candidate.docOrdinal
        && prior.start < candidate.end && candidate.start < prior.end)) continue;
      accepted.push(candidate);
      acceptedByDoc[candidate.docOrdinal] = acceptedByDoc[candidate.docOrdinal]! + 1;
      if (accepted.length === DESTINATION_MAX_RESULTS) break;
    }
    if (accepted.length === DESTINATION_MAX_RESULTS) break;
  }
  return accepted.map((candidate) => ({
    docOrdinal: candidate.docOrdinal,
    tokens: { start: candidate.start, end: candidate.end },
    anchorToken: candidate.anchor,
    anchorTrackOrdinal: candidate.anchorTrack,
    score: candidate.score,
    presentTracks: candidate.present,
    counts: candidate.counts,
  }));
}

describe('destinations numeric planning', () => {
  it('uses the integer-exact score and preserves one-term monotonicity', async () => {
    const { snapshot, selection } = coordinates([300]);
    const input = trackInputs(selection, [[
      { doc: 0, pos: 10 },
      { doc: 0, pos: 20 },
      { doc: 0, pos: 30 },
      { doc: 0, pos: 40 },
    ]]);
    const plan = await planDestinations(
      snapshot, selection, input, request(), createDestinationsScratch(input, 1), async () => {},
    );
    const expected = DESTINATION_SCORE_SCALE
      * destinationIntegerSqrt(DESTINATION_SCORE_SCALE * 4);
    expect(plan.destinations).toHaveLength(1);
    expect(plan.destinations[0]).toMatchObject({ score: expected, counts: [4], presentTracks: 1 });
    expect(plan.tracks[0]!.weight).toBe(DESTINATION_SCORE_SCALE);
  });

  it('elevates a common-plus-rare passage and applies pair focus before retention', async () => {
    const { snapshot, selection } = coordinates([3_000]);
    const common = Array.from({ length: 30 }, (_, index) => ({ doc: 0, pos: 50 + index * 95 }));
    const rare = [{ doc: 0, pos: 2_500 }];
    const input = trackInputs(selection, [common, rare]);
    const all = await planDestinations(
      snapshot, selection, input, request(), createDestinationsScratch(input, 1), async () => {},
    );
    expect(all.destinations[0]!.counts[1]).toBe(1);
    expect(all.tracks[1]!.weight).toBe(DESTINATION_MAX_RARITY_WEIGHT);
    const focused = await planDestinations(
      snapshot,
      selection,
      input,
      request({ a: 0, b: 1 }),
      createDestinationsScratch(input, 1),
      async () => {},
    );
    expect(focused.destinations.length).toBeGreaterThan(0);
    expect(focused.destinations.every((destination) =>
      destination.counts[0]! > 0 && destination.counts[1]! > 0)).toBe(true);
    // Use separated valid occurrences whose 400-token windows cannot contain
    // both tracks; an out-of-document fixture would hide a coordinate bug.
    const separated = trackInputs(selection, [[{ doc: 0, pos: 100 }], [{ doc: 0, pos: 2_800 }]]);
    const empty = await planDestinations(
      snapshot,
      selection,
      separated,
      request({ a: 0, b: 1 }),
      createDestinationsScratch(separated, 1),
      async () => {},
    );
    expect(empty.destinations).toEqual([]);
  });

  it('ranks breadth-first across documents, suppresses overlaps, and derives quotas', async () => {
    const tokenCounts = Array.from({ length: 5 }, () => 2_000);
    const { snapshot, selection } = coordinates(tokenCounts);
    const rows = tokenCounts.flatMap((_, doc) => [
      { doc, pos: 200 },
      { doc, pos: 900 },
    ]);
    const input = trackInputs(selection, [rows]);
    const plan = await planDestinations(
      snapshot, selection, input, request(), createDestinationsScratch(input, 5), async () => {},
    );
    expect(plan.destinations.map((destination) => destination.docOrdinal))
      .toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
    for (let left = 0; left < plan.destinations.length; left++) {
      for (let right = left + 1; right < plan.destinations.length; right++) {
        const a = plan.destinations[left]!;
        const b = plan.destinations[right]!;
        expect(a.docOrdinal !== b.docOrdinal
          || a.tokens.end <= b.tokens.start
          || b.tokens.end <= a.tokens.start).toBe(true);
      }
    }

    const oneDocRows = Array.from({ length: 12 }, (_, index) => ({ doc: 0, pos: 200 + index * 500 }));
    const one = coordinates([6_000]);
    const oneInput = trackInputs(one.selection, [oneDocRows]);
    const onePlan = await planDestinations(
      one.snapshot,
      one.selection,
      oneInput,
      request(),
      createDestinationsScratch(oneInput, 1),
      async () => {},
    );
    expect(onePlan.destinations).toHaveLength(DESTINATION_PER_DOC_KEEP);
  });

  it('breaks runs at exactly one window and collapses a one-token overlap', async () => {
    const { snapshot, selection } = coordinates([2_500]);
    const adjacent = trackInputs(selection, [[
      { doc: 0, pos: 1_000 },
      { doc: 0, pos: 1_400 },
    ]]);
    const adjacentPlan = await planDestinations(
      snapshot,
      selection,
      adjacent,
      request(),
      createDestinationsScratch(adjacent, 1),
      async () => {},
    );
    expect(adjacentPlan.destinations.map((item) => item.tokens)).toEqual([
      { start: 800, end: 1_200 },
      { start: 1_200, end: 1_600 },
    ]);
    const overlapping = trackInputs(selection, [[
      { doc: 0, pos: 1_000 },
      { doc: 0, pos: 1_399 },
    ]]);
    const overlappingPlan = await planDestinations(
      snapshot,
      selection,
      overlapping,
      request(),
      createDestinationsScratch(overlapping, 1),
      async () => {},
    );
    expect(overlappingPlan.destinations).toHaveLength(1);
  });

  it('evicts the worst per-document runs when more than eight survive', async () => {
    const { snapshot, selection } = coordinates([5_200]);
    const rows = Array.from({ length: 10 }, (_, cluster) =>
      Array.from({ length: cluster + 1 }, () => ({ doc: 0, pos: 200 + cluster * 500 })))
      .flat();
    const input = trackInputs(selection, [rows]);
    const plan = await planDestinations(
      snapshot, selection, input, request(), createDestinationsScratch(input, 1), async () => {},
    );
    expect(plan.destinations.map((item) => item.counts[0]))
      .toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it('clamps the derived quota at four-way breadth for six active documents', async () => {
    const { snapshot, selection } = coordinates(Array.from({ length: 6 }, () => 2_500));
    const rows = [200, 700, 1_200, 1_700].map((pos) => ({ doc: 0, pos }));
    for (let doc = 1; doc < 6; doc++) rows.push({ doc, pos: 200 });
    const input = trackInputs(selection, [rows]);
    const plan = await planDestinations(
      snapshot, selection, input, request(), createDestinationsScratch(input, 6), async () => {},
    );
    expect(plan.destinations.filter((item) => item.docOrdinal === 0)).toHaveLength(3);
  });

  it('matches an independent brute-force planner on randomized repeated positions', async () => {
    let state = 0xd35a1;
    const random = (max: number): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % max;
    };
    for (let seed = 0; seed < 300; seed++) {
      const docCount = 1 + random(3);
      const tokenCounts = Array.from({ length: docCount }, () => 500 + random(1_500));
      const trackCount = 1 + random(5);
      const rows = Array.from({ length: trackCount }, (): Row[] =>
        Array.from({ length: random(18) }, () => {
          const doc = random(docCount);
          return { doc, pos: random(tokenCounts[doc]!), span: 1 + random(4) };
        }));
      const focus = trackCount > 1 && random(3) === 0
        ? { a: 0, b: trackCount - 1 }
        : null;
      const { snapshot, selection } = coordinates(tokenCounts);
      const input = trackInputs(selection, rows);
      const plan = await planDestinations(
        snapshot,
        selection,
        input,
        request(focus),
        createDestinationsScratch(input, docCount),
        async () => {},
      );
      expect(plan.destinations).toEqual(oraclePlan(tokenCounts, rows, focus));
    }
  });

  it('uses bounded scratch and checkpoints during dense pointer advancement', async () => {
    const count = 70_000;
    const { snapshot, selection } = coordinates([count + 1]);
    const rows = Array.from({ length: count }, (_, pos) => ({ doc: 0, pos }));
    const input = trackInputs(selection, [rows]);
    const scratch = createDestinationsScratch(input, 1);
    const checkpoint = vi.fn(async () => {});
    await planDestinations(snapshot, selection, input, request(), scratch, checkpoint);
    expect(destinationScratchBytes(scratch)).toBeLessThan(64 * 1024);
    expect(checkpoint.mock.calls.length).toBeGreaterThanOrEqual(3); // high scan + merge + doc gate

    const capped = coordinates(Array.from({ length: 64 }, () => 1));
    const cappedTracks = trackInputs(capped.selection, Array.from({ length: 5 }, () => []));
    expect(destinationScratchBytes(createDestinationsScratch(cappedTracks, 64)))
      .toBeLessThan(64 * 1024);
  });

  it('rejects policy, focus, coordinate, and scratch drift', async () => {
    const { snapshot, selection } = coordinates([500]);
    const input = trackInputs(selection, [[{ doc: 0, pos: 10 }]]);
    const scratch = createDestinationsScratch(input, 1);
    await expect(planDestinations(
      snapshot,
      selection,
      input,
      { ...request(), limit: 11 } as unknown as DestinationsRequestV1,
      scratch,
      async () => {},
    )).rejects.toThrow(/policy/);
    const width600 = { ...request(), windowTokens: 600 as const };
    await expect(planDestinations(
      snapshot,
      selection,
      input,
      width600 as unknown as DestinationsRequestV1,
      scratch,
      async () => {},
    )).rejects.toThrow(/400-token/);
    await expect(planDestinationWindowSpikeV0(
      snapshot,
      selection,
      input,
      width600,
      scratch,
      async () => {},
    )).resolves.toMatchObject({ windowTokens: 600 });
    await expect(planDestinations(
      snapshot,
      selection,
      input,
      { ...request(), focus: { a: 0, b: 0 } },
      scratch,
      async () => {},
    )).rejects.toThrow(/focus/);
    const ranged = { ...selection, spec: { ...selection.spec, ranges: [] } } as ResolvedSelection;
    await expect(planDestinations(
      snapshot, ranged, input, request(), scratch, async () => {},
    )).rejects.toThrow(/full corpus/);
    await expect(planDestinations(
      snapshot,
      selection,
      input,
      request(),
      { ...scratch, score: new Float64Array() },
      async () => {},
    )).rejects.toThrow(/scratch/);
  });
});

interface BoundWorld {
  readonly snapshot: CorpusSnapshotV1;
  readonly selection: ResolvedSelection;
  readonly shards: BoundShards;
  readonly texts: BoundTexts;
  readonly shardMap: ReadonlyMap<string, DocumentIndexV1>;
}

async function boundWorld(sourceByDoc: Record<string, string>): Promise<BoundWorld> {
  const docs = Object.keys(sourceByDoc) as ProjectDocId[];
  const shardMap = new Map<string, DocumentIndexV1>();
  const ready = new Map();
  const textMap = new Map<string, string>();
  for (const doc of docs) {
    const text = sourceByDoc[doc]!;
    const shard = await createDocumentIndex(text, await segment(text, 'en'), DEFAULT_INDEX_RECIPE);
    shardMap.set(doc, shard);
    ready.set(doc, await makeReadyDocument(doc, shard));
    textMap.set(doc, text);
  }
  const snapshot = await composeSnapshot('destinations-test' as BuildGeneration, docs, ready);
  const shards = await bindShards(snapshot, shardMap);
  const texts = await bindTexts(snapshot, shards, textMap);
  const selection = await resolveSelection(snapshot, { docs });
  return { snapshot, selection, shards, texts, shardMap };
}

describe('destination materialization', () => {
  it('materializes only bounded winning snippets and the first render-order marks', async () => {
    const source = Array.from({ length: 700 }, (_, index) =>
      index === 350 ? 'needle' : `w${index}`).join(' ');
    const world = await boundWorld({ doc: source });
    const dense = Array.from({ length: 40 }, () => ({ doc: 0, pos: 350 }));
    const input = trackInputs(world.selection, [dense, [{ doc: 0, pos: 350 }]]);
    const plan = await planDestinations(
      world.snapshot,
      world.selection,
      input,
      request(),
      createDestinationsScratch(input, 1),
      async () => {},
    );
    const result = materializeDestinations(
      world.snapshot, plan, world.shards, world.texts, input,
    );
    expect(result.destinations).toHaveLength(1);
    const item = result.destinations[0]!;
    expect(item.anchor).toEqual({ seriesId: 's1', groupId: 'g1', token: 350 });
    expect(item.snippet.tokens.end - item.snippet.tokens.start)
      .toBeLessThanOrEqual(DESTINATION_SNIPPET_TOKENS);
    expect(item.snippet.text.length).toBeLessThanOrEqual(DESTINATION_SNIPPET_UTF16);
    expect(item.snippet.marks).toHaveLength(DESTINATION_MAX_MARKS);
    expect(item.snippet.marksTruncated).toBe(true);
    expect(item.snippet.text).toContain('needle');
    expect(item.snippet.marks.every((mark) =>
      mark.charsUtf16.start >= 0 && mark.charsUtf16.end <= item.snippet.text.length)).toBe(true);

    const shard = world.shardMap.get('doc')!;
    const all = collectTokenWindowMarks(
      shard,
      0,
      input.map((track) => track.occurrences),
      item.snippet.tokens.start,
      item.snippet.tokens.end,
    );
    const limited = collectTokenWindowMarksLimited(
      shard,
      0,
      input.map((track) => track.occurrences),
      item.snippet.tokens.start,
      item.snippet.tokens.end,
      DESTINATION_MAX_MARKS,
    );
    expect(limited.marks).toEqual(all.slice(0, DESTINATION_MAX_MARKS));
    expect(limited.truncated).toBe(true);
  });

  it('clips an oversized token without splitting the text or mark bounds', async () => {
    const source = 'a'.repeat(500);
    const world = await boundWorld({ doc: source });
    const input = trackInputs(world.selection, [[{ doc: 0, pos: 0 }]]);
    const plan = await planDestinations(
      world.snapshot,
      world.selection,
      input,
      request(),
      createDestinationsScratch(input, 1),
      async () => {},
    );
    const [item] = materializeDestinations(
      world.snapshot, plan, world.shards, world.texts, input,
    ).destinations;
    expect(item!.snippet.text).toHaveLength(DESTINATION_SNIPPET_UTF16);
    expect(item!.snippet.marks[0]!.charsUtf16.end).toBe(DESTINATION_SNIPPET_UTF16);
  });

  it('caps snippets in UTF-8 while retaining the centered anchor in a three-byte script', async () => {
    const source = Array.from({ length: 700 }, () => 'कककककककककक').join(' ');
    const world = await boundWorld({ doc: source });
    const input = trackInputs(world.selection, [[
      { doc: 0, pos: 350 },
      { doc: 0, pos: 370 },
    ]]);
    const plan = await planDestinations(
      world.snapshot,
      world.selection,
      input,
      request(),
      createDestinationsScratch(input, 1),
      async () => {},
    );
    const [item] = materializeDestinations(
      world.snapshot, plan, world.shards, world.texts, input,
    ).destinations;
    expect(new TextEncoder().encode(item!.snippet.text).byteLength)
      .toBeLessThanOrEqual(DESTINATION_SNIPPET_UTF8);
    expect(item!.snippet.text.length).toBeLessThanOrEqual(DESTINATION_SNIPPET_UTF16);
    expect(item!.snippet.marks).toHaveLength(1);
    expect(item!.snippet.marks[0]!.charsUtf16.start).toBeGreaterThanOrEqual(0);
    expect(item!.snippet.marks[0]!.charsUtf16.end).toBeLessThanOrEqual(item!.snippet.text.length);
    expect(item!.snippet.text.slice(
      item!.snippet.marks[0]!.charsUtf16.start,
      item!.snippet.marks[0]!.charsUtf16.end,
    )).toBe('कककककककककक');
  });

  it('holds the 32 KiB response gate for three-byte text at every result and mark cap', async () => {
    const source = Array.from({ length: 3_000 }, () => 'कककककककककक').join(' ');
    const sourceByDoc = Object.fromEntries(
      Array.from({ length: 4 }, (_, doc) => [`d${doc}`, source]),
    );
    const world = await boundWorld(sourceByDoc);
    const rows: Row[] = [];
    for (let doc = 0; doc < 4; doc++) {
      for (const pos of [500, 1_500, 2_500]) {
        for (let repeat = 0; repeat < DESTINATION_MAX_MARKS; repeat++) rows.push({ doc, pos });
      }
    }
    const input = trackInputs(world.selection, [rows]);
    const plan = await planDestinations(
      world.snapshot,
      world.selection,
      input,
      request(),
      createDestinationsScratch(input, 4),
      async () => {},
    );
    const result = materializeDestinations(
      world.snapshot, plan, world.shards, world.texts, input,
    );
    expect(result.destinations).toHaveLength(DESTINATION_MAX_RESULTS);
    expect(result.destinations.reduce((sum, item) => sum + item.snippet.marks.length, 0))
      .toBe(DESTINATION_MAX_RESULTS * DESTINATION_MAX_MARKS);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(32 * 1024);
  });

  it('keeps the bounded mark heap equivalent to the full render order', async () => {
    const source = Array.from({ length: 250 }, (_, index) => `w${index}`).join(' ');
    const world = await boundWorld({ doc: source });
    let state = 0x5eed;
    const random = (max: number): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state % max;
    };
    const rows = Array.from({ length: 3 }, () => Array.from({ length: 100 }, () => {
      const pos = 80 + random(90);
      return { doc: 0, pos, span: 1 + random(Math.min(5, 250 - pos)) };
    }));
    const input = trackInputs(world.selection, rows);
    const shard = world.shardMap.get('doc')!;
    const occurrenceTracks = input.map((track) => track.occurrences);
    const all = collectTokenWindowMarks(shard, 0, occurrenceTracks, 100, 150);
    for (const limit of [0, 1, 2, 7, 16, 100]) {
      const limited = collectTokenWindowMarksLimited(
        shard, 0, occurrenceTracks, 100, 150, limit,
      );
      expect(limited.marks).toEqual(all.slice(0, limit));
      expect(limited.truncated).toBe(all.length > limit);
    }
  });

  it('rejects a track table that does not match the numeric plan', async () => {
    const world = await boundWorld({ doc: 'one two three' });
    const input = trackInputs(world.selection, [[{ doc: 0, pos: 1 }]]);
    const plan = await planDestinations(
      world.snapshot,
      world.selection,
      input,
      request(),
      createDestinationsScratch(input, 1),
      async () => {},
    );
    expect(() => materializeDestinations(
      world.snapshot,
      plan,
      world.shards,
      world.texts,
      [{ ...input[0]!, seriesId: 'foreign' }],
    )).toThrow(/tracks/);
    const forged = {
      ...plan,
      destinations: plan.destinations.map((item, index) => index === 0
        ? { ...item, score: item.score + 1 }
        : item),
    };
    expect(() => materializeDestinations(
      world.snapshot, forged, world.shards, world.texts, input,
    )).toThrow(/score or anchor/);
  });
});
