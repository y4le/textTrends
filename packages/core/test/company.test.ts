import { describe, expect, it, vi } from 'vitest';
import type { CorpusSnapshotV1 } from '../src/snapshot/compose.ts';
import type { ResolvedSelection } from '../src/snapshot/selection.ts';
import type { NumericOccurrences } from '../src/ops/occurrences.ts';
import {
  company,
  createCompanyScratch,
  COMPANY_GAP_EDGES_V1,
  type CompanyPairV1,
  type CompanyTrackInputV1,
} from '../src/ops/company.ts';
import { trackDocumentSlices } from '../src/ops/occurrences.ts';

interface Row {
  readonly doc: number;
  readonly pos: number;
  readonly span: number;
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
  const sorted = [...rows].sort((a, b) => a.doc - b.doc || a.pos - b.pos || b.span - a.span);
  return {
    snapshot: selection.snapshot,
    selection: selection.hash,
    docOrdinal: Uint32Array.from(sorted, (row) => row.doc),
    pos: Uint32Array.from(sorted, (row) => row.pos),
    spanTokens: Uint32Array.from(sorted, (row) => row.span),
    memberOffsets: new Uint32Array(sorted.length + 1),
    memberOrdinals: new Uint32Array(),
  };
}

function denseOccurrence(
  count: number,
  selection: ResolvedSelection,
  doc = 0,
): NumericOccurrences {
  const docOrdinal = new Uint32Array(count);
  docOrdinal.fill(doc);
  const pos = new Uint32Array(count);
  for (let index = 0; index < count; index++) pos[index] = index;
  const spanTokens = new Uint32Array(count);
  spanTokens.fill(1);
  return {
    snapshot: selection.snapshot,
    selection: selection.hash,
    docOrdinal,
    pos,
    spanTokens,
    memberOffsets: new Uint32Array(count + 1),
    memberOrdinals: new Uint32Array(),
  };
}

function tracks(
  selection: ResolvedSelection,
  a: readonly Row[],
  b: readonly Row[],
): readonly CompanyTrackInputV1[] {
  return [
    { seriesId: 'a', groupId: 'ga', occurrences: occurrence(a, selection) },
    { seriesId: 'b', groupId: 'gb', occurrences: occurrence(b, selection) },
  ];
}

const request = { method: 'company/1' as const, gapEdges: COMPANY_GAP_EDGES_V1 };

function gap(left: Row, right: Row): { gap: number; direction: -1 | 0 | 1 } {
  const leftEnd = left.pos + left.span;
  const rightEnd = right.pos + right.span;
  if (right.pos >= leftEnd) return { gap: right.pos - leftEnd, direction: 1 };
  if (left.pos >= rightEnd) return { gap: left.pos - rightEnd, direction: -1 };
  return { gap: 0, direction: 0 };
}

function bucket(value: number): number {
  let result = 0;
  for (let index = 1; index < COMPANY_GAP_EDGES_V1.length; index++) {
    if (COMPANY_GAP_EDGES_V1[index]! > value) break;
    result = index;
  }
  return result;
}

function bruteDirection(source: readonly Row[], peer: readonly Row[]) {
  const histogram = Array.from({ length: COMPANY_GAP_EDGES_V1.length }, () => 0);
  let none = 0;
  let forward = 0;
  let backward = 0;
  let tied = 0;
  let overlap = 0;
  for (const item of source) {
    const candidates = peer.filter((candidate) => candidate.doc === item.doc).map((candidate) => gap(item, candidate));
    if (candidates.length === 0) {
      none++;
      continue;
    }
    if (candidates.some((candidate) => candidate.direction === 0)) {
      histogram[0] = histogram[0]! + 1;
      overlap++;
      continue;
    }
    const nearest = Math.min(...candidates.map((candidate) => candidate.gap));
    const nearestBucket = bucket(nearest);
    histogram[nearestBucket] = histogram[nearestBucket]! + 1;
    const directions = new Set(candidates.filter((candidate) => candidate.gap === nearest).map((candidate) => candidate.direction));
    if (directions.size > 1) tied++;
    else if (directions.has(1)) forward++;
    else backward++;
  }
  return { histogram, none, forward, backward, tied, overlap };
}

function expectDirection(pair: CompanyPairV1, side: 'A' | 'B', expected: ReturnType<typeof bruteDirection>) {
  expect(pair[`from${side}`]).toEqual(expected.histogram);
  expect(pair[`none${side}`]).toBe(expected.none);
  expect(pair[`forward${side}`]).toBe(expected.forward);
  expect(pair[`backward${side}`]).toBe(expected.backward);
  expect(pair[`tied${side}`]).toBe(expected.tied);
  expect(pair[`overlap${side}`]).toBe(expected.overlap);
}

describe('trackDocumentSlices', () => {
  it('indexes empty and populated documents without scanning payload rows into output', () => {
    const { selection } = coordinates([10, 10, 10, 10]);
    const occurrences = occurrence([
      { doc: 0, pos: 1, span: 1 },
      { doc: 0, pos: 4, span: 1 },
      { doc: 2, pos: 3, span: 1 },
    ], selection);
    expect(Array.from(trackDocumentSlices(occurrences, 4))).toEqual([0, 2, 2, 3, 3]);
    expect(() => trackDocumentSlices(occurrences, 2)).toThrow(/outside/);
    expect(() => trackDocumentSlices(occurrences, -1)).toThrow(/document count/);
  });
});

describe('company/1', () => {
  it('reports exact directional, overlap, absent-document, and marginal evidence', async () => {
    const { snapshot, selection } = coordinates([30, 20]);
    const a = [
      { doc: 0, pos: 0, span: 2 },
      { doc: 0, pos: 10, span: 1 },
      { doc: 1, pos: 5, span: 1 },
    ];
    const b = [
      { doc: 0, pos: 2, span: 1 },
      { doc: 0, pos: 8, span: 4 },
    ];
    const input = tracks(selection, a, b);
    const result = await company(
      snapshot, selection, input, request, createCompanyScratch(input, 2), async () => {},
    );
    expect(result).toMatchObject({ method: 'company/1', corpusTokens: 50 });
    expect(result.tracks).toEqual([
      { seriesId: 'a', groupId: 'ga', total: 3, docCount: 2 },
      { seriesId: 'b', groupId: 'gb', total: 2, docCount: 1 },
    ]);
    const pair = result.pairs[0]!;
    expect(pair.docsWithBoth).toBe(1);
    expectDirection(pair, 'A', bruteDirection(a, b));
    expectDirection(pair, 'B', bruteDirection(b, a));
    expect(pair.forwardA).toBe(1); // touching [0,2) → [2,3)
    expect(pair.overlapA).toBe(1); // [10,11) lies inside [8,12)
    expect(pair.noneA).toBe(1); // peer absent from d1
  });

  it('uses the maximum predecessor end rather than the most recent predecessor start', async () => {
    const { snapshot, selection } = coordinates([40]);
    const a = [{ doc: 0, pos: 20, span: 1 }];
    const b = [
      { doc: 0, pos: 0, span: 10 },
      { doc: 0, pos: 5, span: 1 },
      { doc: 0, pos: 31, span: 1 },
    ];
    const input = tracks(selection, a, b);
    const pair = (await company(
      snapshot, selection, input, request, createCompanyScratch(input, 1), async () => {},
    )).pairs[0]!;
    expect(pair.fromA[bucket(10)]).toBe(1); // [0,10) and [30,31) tie at gap 10
    expect(pair.tiedA).toBe(1);
  });

  it('matches a quadratic oracle over randomized variable spans and repeated starts', async () => {
    let state = 0x51f15e;
    const random = (max: number) => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % max;
    };
    for (let seed = 0; seed < 500; seed++) {
      const docCount = 1 + random(4);
      const tokenCounts = Array.from({ length: docCount }, () => 20 + random(40));
      const { snapshot, selection } = coordinates(tokenCounts);
      const makeRows = (): Row[] => Array.from({ length: random(18) }, () => {
        const doc = random(docCount);
        const tokenCount = tokenCounts[doc]!;
        const pos = random(tokenCount);
        return { doc, pos, span: 1 + random(Math.min(8, tokenCount - pos)) };
      });
      const a = makeRows();
      const b = makeRows();
      const input = tracks(selection, a, b);
      const pair = (await company(
        snapshot, selection, input, request, createCompanyScratch(input, docCount), async () => {},
      )).pairs[0]!;
      expectDirection(pair, 'A', bruteDirection(a, b));
      expectDirection(pair, 'B', bruteDirection(b, a));
      const docsWithBoth = Array.from({ length: docCount }, (_, doc) =>
        a.some((row) => row.doc === doc) && b.some((row) => row.doc === doc),
      ).filter(Boolean).length;
      expect(pair.docsWithBoth).toBe(docsWithBoth);
    }
  });

  it('checkpoints by examined-occurrence chunks and after each pair', async () => {
    const count = 65_537;
    const { snapshot, selection } = coordinates([count + 2]);
    const a = Array.from({ length: count }, (_, pos) => ({ doc: 0, pos, span: 1 }));
    const b = [{ doc: 0, pos: 0, span: 1 }];
    const input = tracks(selection, a, b);
    const checkpoint = vi.fn(async () => {});
    await company(snapshot, selection, input, request, createCompanyScratch(input, 1), checkpoint);
    expect(checkpoint).toHaveBeenCalledTimes(2); // one 65,536 chunk + pair gate
  });

  it('checkpoints every chunk when an entire source document has no peers', async () => {
    const chunks = 10;
    const count = chunks * 65_536 + 17;
    const { snapshot, selection } = coordinates([count + 1]);
    const input = [
      { seriesId: 'a', groupId: 'ga', occurrences: denseOccurrence(count, selection) },
      { seriesId: 'b', groupId: 'gb', occurrences: occurrence([], selection) },
    ];
    const checkpoint = vi.fn(async () => {});
    await company(snapshot, selection, input, request, createCompanyScratch(input, 1), checkpoint);
    expect(checkpoint).toHaveBeenCalledTimes(chunks + 1); // chunks + pair gate
  });

  it('rejects policy drift and non-canonical full-corpus coordinates', async () => {
    const { snapshot, selection } = coordinates([10, 10]);
    const input = tracks(selection, [{ doc: 0, pos: 1, span: 1 }], [{ doc: 0, pos: 2, span: 1 }]);
    const scratch = createCompanyScratch(input, 2);
    await expect(company(
      snapshot,
      selection,
      input,
      { method: 'company/1', gapEdges: [...COMPANY_GAP_EDGES_V1.slice(0, -1), 201] },
      scratch,
      async () => {},
    )).rejects.toThrow(/policy/);
    await expect(company(
      snapshot,
      { ...selection, spec: { ...selection.spec, ranges: [] } } as ResolvedSelection,
      input,
      request,
      scratch,
      async () => {},
    )).rejects.toThrow(/full corpus/);
    await expect(company(
      snapshot,
      { ...selection, snapshot: 'foreign' } as ResolvedSelection,
      input,
      request,
      scratch,
      async () => {},
    )).rejects.toThrow(/different snapshot/);
    for (const docs of [['d0'], ['d1', 'd0']]) {
      await expect(company(
        snapshot,
        { ...selection, spec: { docs } } as unknown as ResolvedSelection,
        input,
        request,
        scratch,
        async () => {},
      )).rejects.toThrow(/full corpus/);
    }
  });

  it('rejects track bounds and occurrence identity drift', async () => {
    const { snapshot, selection } = coordinates([10]);
    const input = tracks(selection, [{ doc: 0, pos: 1, span: 1 }], [{ doc: 0, pos: 2, span: 1 }]);
    const one = input.slice(0, 1);
    await expect(company(
      snapshot, selection, one, request, createCompanyScratch(one, 1), async () => {},
    )).rejects.toThrow(/2–5/);
    const six = Array.from({ length: 6 }, (_, index) => ({
      ...input[index % 2]!,
      seriesId: `s${index}`,
    }));
    await expect(company(
      snapshot, selection, six, request, createCompanyScratch(six, 1), async () => {},
    )).rejects.toThrow(/2–5/);
    for (const occurrences of [
      { ...input[0]!.occurrences, snapshot: 'foreign' } as unknown as NumericOccurrences,
      { ...input[0]!.occurrences, selection: 'foreign' } as unknown as NumericOccurrences,
    ]) {
      const drifted = [{ ...input[0]!, occurrences }, input[1]!];
      await expect(company(
        snapshot, selection, drifted, request, createCompanyScratch(drifted, 1), async () => {},
      )).rejects.toThrow(/different coordinates/);
    }
  });

  it('rejects malformed caller-owned document slices', async () => {
    const { snapshot, selection } = coordinates([10, 10]);
    const input = tracks(
      selection,
      [{ doc: 0, pos: 1, span: 1 }, { doc: 1, pos: 1, span: 1 }],
      [{ doc: 0, pos: 2, span: 1 }, { doc: 1, pos: 2, span: 1 }],
    );
    const validB = Uint32Array.from([0, 1, 2]);
    const malformed = [
      [],
      [1, 1, 2],
      [0, 2, 1],
      [0, 3, 2],
      [0, 2, 2],
    ];
    for (const slices of malformed) {
      await expect(company(
      snapshot,
      selection,
      input,
      request,
        { documentSlices: [Uint32Array.from(slices), validB] },
      async () => {},
      )).rejects.toThrow(/scratch|boundaries/);
    }
  });
});
