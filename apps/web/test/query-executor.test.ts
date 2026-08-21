/**
 * Query SEMANTICS — trend/Matches/passage execution, resolver reuse, and the
 * shared occurrence-cache discipline, moved from engine-v4.test.ts with the
 * QueryExecutor extraction (slice-2 ruling §B). Driven through the same
 * engine harness (the executor is generation-bound and engine-fed), so these
 * results are byte-for-byte the pre-extraction expectations. Dispatch, final
 * gates, error mapping, cancellation bookkeeping, and transfer emission stay
 * in engine-v4.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_MATCHES_AXIS_CACHE_BYTES,
  MAX_MATCHES_AXIS_CACHE_ENTRIES,
  MAX_OCCURRENCE_CACHE_ENTRIES,
  MAX_OCCURRENCE_CACHE_BYTES,
  QueryExecutor,
  type PublishedView,
} from '../src/worker/query-executor.ts';
import {
  CapError,
  COMPANY_GAP_EDGES_V1,
  DESTINATION_MAX_RESULTS,
  DESTINATION_WINDOW_TOKENS_V1,
  DISPERSION_BUCKET_BUDGET,
  DISPERSION_EXACT_MAX,
} from '@texttrends/core';
import {
  buildResolver,
  DEFAULT_INDEX_RECIPE,
  documentTermCounts,
  occurrences,
  resolveSelection,
  termGroupIdentity,
  type CorpusSnapshotV1,
} from '@texttrends/core';
import { begin, coldIngest, FOLD, harness, wolfGroup, type Harness } from './support/engine-harness.ts';
import { buildDocSpec as docSpec } from './support/spec-fixtures.ts';

// The same pass-through occurrence spy discipline as the engine suite: the
// cache tests count exactly how many times the executor pays for a full
// per-doc match. Every wrapper delegates to the real implementation.
vi.mock('@texttrends/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@texttrends/core')>();
  return {
    ...actual,
    bindShardsIncremental: vi.fn(actual.bindShardsIncremental),
    createBindingSession: vi.fn(actual.createBindingSession),
    documentTermCounts: vi.fn(actual.documentTermCounts),
    occurrences: vi.fn(actual.occurrences),
  };
});

/** A spec-LITE builder (no expected hashes) for cold-path queries — the doc
 *  is admitted by ingest, not warm claims. */
import { defaultExtractionRecipes, hashExtractionRecipe } from '@texttrends/core';
import type { GenerationDocSpecV4 } from '../src/worker/protocol-v4.ts';
const foxGroup = {
  id: 'g-fox',
  members: [{ id: 'm-fox', kind: 'token' as const, surface: 'fox', match: FOLD }],
  countOverlaps: false,
};

async function freshTxtSpec(doc: string, byteLength: number): Promise<GenerationDocSpecV4> {
  const { txt } = await defaultExtractionRecipes();
  return {
    doc, language: 'en',
    source: { byteLength, format: 'txt' },
    extraction: { recipe: txt, recipeHash: await hashExtractionRecipe(txt) },
  };
}

describe('query semantics through the generation-bound executor', () => {
  async function ready(text = 'the wolf ran far. a wolf slept.') {
    const h = harness();
    const spec = await docSpec('a', text);
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', text, 10);
    return { h, snap: h.last('snapshot-published').snapshot };
  }

  it('answers trend against the published snapshot', async () => {
    const { h, snap } = await ready();
    await h.send({ t: 'query', job: 20, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } } });
    const trend = h.last('result');
    expect(trend.data.op).toBe('trend');
    if (trend.data.op === 'trend') expect(Array.from(trend.data.trend.count)).toEqual([1, 0, 1, 0]);
  });

  it('keeps each existing occurrence operation checkpoint cadence explicit', async () => {
    const { h, snap } = await ready();
    const generation = (h.engine as unknown as {
      generation: { executor: QueryExecutor; snapshot: CorpusSnapshotV1 } | null;
    }).generation;
    if (!generation) throw new Error('expected published generation');
    const selection = await resolveSelection(generation.snapshot, { docs: ['a'] as never });
    const tracks = [{ seriesId: 's-wolf', group: wolfGroup }];
    const overviewTracks = [
      ...tracks,
      { seriesId: 's-fox', group: foxGroup },
    ];
    const expectCheckpoints = async (
      expected: number,
      run: (checkpoint: () => Promise<void>) => Promise<unknown>,
    ) => {
      const checkpoint = vi.fn(async () => {});
      await run(checkpoint);
      expect(checkpoint).toHaveBeenCalledTimes(expected);
    };

    await expectCheckpoints(3, (checkpoint) => generation.executor.trend(
      selection,
      wolfGroup,
      { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } },
      checkpoint,
    ));
    await expectCheckpoints(3, (checkpoint) => generation.executor.dispersion(
      selection,
      tracks,
      checkpoint,
    ));
    await expectCheckpoints(5, (checkpoint) => generation.executor.company(
      selection,
      overviewTracks,
      { method: 'company/1', gapEdges: COMPANY_GAP_EDGES_V1 },
      checkpoint,
    ));
    await expectCheckpoints(6, (checkpoint) => generation.executor.destinations(
      selection,
      overviewTracks,
      {
        method: 'destinations/1',
        windowTokens: DESTINATION_WINDOW_TOKENS_V1,
        limit: DESTINATION_MAX_RESULTS,
        focus: null,
      },
      checkpoint,
    ));
    await expectCheckpoints(4, (checkpoint) => generation.executor.readerPage(
      selection,
      tracks,
      { doc: 'a', cursor: { kind: 'around', token: 1 }, maxTokens: 5 },
      checkpoint,
    ));
    await expectCheckpoints(3, (checkpoint) => generation.executor.occurrenceStep(
      selection,
      tracks,
      { method: 'occurrence-step/1', doc: 'a', token: 0, direction: 1 },
      checkpoint,
    ));
    await expectCheckpoints(4, (checkpoint) => generation.executor.matchesWindow(
      selection,
      tracks,
      { anchor: { kind: 'rank', rank: 0 }, before: 0, after: 0, contextTokens: 4 },
      true,
      checkpoint,
    ));
    expect(snap).toBe(generation.snapshot.id);
  });

  it('prepares the union of distinct match modes within and across tracks', async () => {
    const { h } = await ready('Wolf wolf');
    const generation = (h.engine as unknown as {
      generation: { executor: QueryExecutor; snapshot: CorpusSnapshotV1 } | null;
    }).generation;
    if (!generation) throw new Error('expected published generation');
    const selection = await resolveSelection(generation.snapshot, { docs: ['a'] as never });
    const sensitive = { case: 'sensitive' as const, diacritics: 'sensitive' as const };
    const sensitiveGroup = {
      id: 'sensitive-wolf',
      countOverlaps: false,
      members: [{ id: 'sensitive', kind: 'token' as const, surface: 'Wolf', match: sensitive }],
    };
    const mixedGroup = {
      id: 'mixed-wolf',
      countOverlaps: true,
      members: [
        ...wolfGroup.members,
        { id: 'sensitive', kind: 'token' as const, surface: 'Wolf', match: sensitive },
      ],
    };

    const mixed = await generation.executor.trend(
      selection,
      mixedGroup,
      { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } },
      async () => {},
    );
    expect(Array.from(mixed.count).reduce((sum, count) => sum + count, 0)).toBe(3);

    const across = await generation.executor.dispersion(
      selection,
      [
        { seriesId: 'folded', group: wolfGroup },
        { seriesId: 'sensitive', group: sensitiveGroup },
      ],
      async () => {},
    );
    expect(across.tracks.map((track) => track.total)).toEqual([2, 1]);
  });

  it('maps an occurrence construction cap to recoverable CAP_EXCEEDED', async () => {
    const { h, snap } = await ready();
    vi.mocked(occurrences).mockImplementationOnce(() => {
      throw new CapError('occurrences exceed the cap of 200000 (reached 200001)');
    });
    await h.send({
      t: 'query', job: 22, snapshot: snap,
      query: {
        op: 'trend', selection: { docs: ['a'] }, group: wolfGroup,
        request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } },
      },
    });
    expect(h.last('error')).toMatchObject({ code: 'CAP_EXCEEDED', recoverable: true });
  });

  it('a capped construction neither poisons nor evicts a warm occurrence entry', async () => {
    const { h, snap } = await ready();
    const occSpy = vi.mocked(occurrences);
    occSpy.mockClear();
    const trendQuery = (group: typeof wolfGroup) => ({
      op: 'trend' as const,
      selection: { docs: ['a'] },
      group,
      request: {
        coordinate: 'document-relative' as const,
        bins: { mode: 'per-doc' as const, count: 4 },
      },
    });
    await h.send({ t: 'query', job: 23, snapshot: snap, query: trendQuery(wolfGroup) });
    const executor = (h.engine as unknown as {
      generation: {
        executor: {
          occurrenceCache: Map<string, unknown>;
          occurrenceCacheBytes: number;
        };
      } | null;
    }).generation!.executor;
    const warmKeys = [...executor.occurrenceCache.keys()];
    const warmBytes = executor.occurrenceCacheBytes;

    occSpy.mockImplementationOnce(() => {
      throw new CapError('occurrences exceed the cap of 200000 (reached 200001)');
    });
    const foxGroup = {
      ...wolfGroup,
      id: 'fox-cap-probe',
      members: wolfGroup.members.map((member) => ({ ...member, surface: 'fox' })),
    };
    await h.send({ t: 'query', job: 24, snapshot: snap, query: trendQuery(foxGroup) });
    expect(h.last('error')).toMatchObject({ code: 'CAP_EXCEEDED', recoverable: true });
    expect([...executor.occurrenceCache.keys()]).toEqual(warmKeys);
    expect(executor.occurrenceCacheBytes).toBe(warmBytes);

    await h.send({ t: 'query', job: 25, snapshot: snap, query: trendQuery(wolfGroup) });
    expect(h.all('result').some((message) => message.job === 25)).toBe(true);
    expect(occSpy).toHaveBeenCalledTimes(2);
  });

  describe('trend occurrence-cache discipline', () => {
    const trendQ = { op: 'trend' as const, selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative' as const, bins: { mode: 'per-doc' as const, count: 4 } } };
    const occSpy = () => vi.mocked(occurrences);
    const cacheOf = (h: Harness) => (h.engine as unknown as { generation: { executor: { occurrenceCache: Map<string, unknown> } } | null }).generation!.executor.occurrenceCache;

    it('a different snapshot, a different selection, and a different matching identity each MISS', async () => {
      const h = harness();
      const textA = 'the wolf ran far. a wolf slept.';
      const textB = 'the wolf slept here.';
      await begin(h, [await docSpec('a', textA), await docSpec('b', textB)]);
      await coldIngest(h, 'g', 'a', textA, 10);
      const snap1 = h.last('snapshot-published').snapshot;
      occSpy().mockClear();
      await h.send({ t: 'query', job: 70, snapshot: snap1, query: trendQ });
      expect(occSpy()).toHaveBeenCalledTimes(1);
      // A new publication in the SAME generation keeps the cache but keys a
      // new snapshot id — the identical selection/group MISSES.
      await coldIngest(h, 'g', 'b', textB, 11);
      const snap2 = h.last('snapshot-published').snapshot;
      expect(snap2).not.toBe(snap1);
      await h.send({ t: 'query', job: 71, snapshot: snap2, query: trendQ });
      expect(occSpy()).toHaveBeenCalledTimes(2);
      // Different selection (same snapshot, same group) → MISS.
      await h.send({ t: 'query', job: 72, snapshot: snap2, query: { ...trendQ, selection: { docs: ['a', 'b'] } } });
      expect(occSpy()).toHaveBeenCalledTimes(3);
      // Different matching identity (same snapshot, same selection) → MISS.
      const ranGroup = { id: 'g1', countOverlaps: false, members: [{ id: 'm1', kind: 'token' as const, surface: 'ran', match: FOLD }] };
      await h.send({ t: 'query', job: 73, snapshot: snap2, query: { ...trendQ, group: ranGroup } });
      expect(occSpy()).toHaveBeenCalledTimes(4);
      // Control: the exact tuple from job 71 is still resident → HIT.
      await h.send({ t: 'query', job: 74, snapshot: snap2, query: trendQ });
      expect(occSpy()).toHaveBeenCalledTimes(4);
      expect(h.all('error')).toEqual([]);
    });

    it('NUL-bearing group data yields distinct, collision-free cache keys (canonical JSON escapes U+0000)', async () => {
      // The joined key uses a literal NUL delimiter, which is sound ONLY
      // because no component can contain one: pin that termGroupIdentity is
      // NUL-free even for NUL-bearing surfaces (JSON.stringify escapes U+0000)
      // and that two such groups never alias one entry.
      const { h, snap } = await ready();
      const nulGroup = (surface: string) => ({ id: 'nul', countOverlaps: false, members: [{ id: 'm', kind: 'token' as const, surface, match: FOLD }] });
      const g1 = nulGroup('wolf\u0000');
      const g2 = nulGroup('\u0000wolf');
      expect(termGroupIdentity(g1)).not.toContain('\u0000');
      expect(termGroupIdentity(g2)).not.toContain('\u0000');
      expect(termGroupIdentity(g1)).not.toBe(termGroupIdentity(g2));
      occSpy().mockClear();
      await h.send({ t: 'query', job: 70, snapshot: snap, query: { ...trendQ, group: g1 } });
      await h.send({ t: 'query', job: 71, snapshot: snap, query: { ...trendQ, group: g2 } });
      expect(occSpy()).toHaveBeenCalledTimes(2); // distinct keys — no alias
      expect(cacheOf(h).size).toBe(2);
      // Re-querying the first NUL-bearing group HITS its own entry.
      await h.send({ t: 'query', job: 72, snapshot: snap, query: { ...trendQ, group: g1 } });
      expect(occSpy()).toHaveBeenCalledTimes(2);
      expect(h.all('error')).toEqual([]);
    });

    it('a replacement generation starts with an EMPTY occurrence cache and recomputes', async () => {
      const text = 'the wolf ran far. a wolf slept.';
      const h = harness();
      const spec = await docSpec('a', text);
      await begin(h, [spec], 'g1');
      await coldIngest(h, 'g1', 'a', text, 10);
      const snap1 = h.last('snapshot-published').snapshot;
      occSpy().mockClear();
      await h.send({ t: 'query', job: 70, snapshot: snap1, query: trendQ });
      await h.send({ t: 'query', job: 71, snapshot: snap1, query: trendQ });
      expect(occSpy()).toHaveBeenCalledTimes(1); // warmed and hit within g1
      await begin(h, [spec], 'g2'); // warm replacement — same content, fresh generation
      expect(cacheOf(h).size).toBe(0); // the cache died with g1
      const snap2 = h.last('snapshot-published').snapshot;
      await h.send({ t: 'query', job: 72, snapshot: snap2, query: trendQ });
      expect(occSpy()).toHaveBeenCalledTimes(2); // recomputed even for an identical tuple
      expect(h.all('error')).toEqual([]);
    });
  });

  it('re-ingesting a document replaces its resolver cache atomically', async () => {
    const h = harness();
    const spec = await docSpec('a', 'wolf');
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', 'wolf', 10);
    const snap1 = h.last('snapshot-published').snapshot;
    await h.send({ t: 'query', job: 70, snapshot: snap1, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } } });
    expect(h.last('result').data.op).toBe('trend');
    // Replace the document under the SAME generation (a fresh spec with no
    // asserted identity so different bytes are accepted).
    const fresh = await freshTxtSpec('a', 4);
    await h.send({ t: 'begin-generation', job: 71, generation: 'g2', docs: [fresh], indexRecipe: DEFAULT_INDEX_RECIPE });
    await coldIngest(h, 'g2', 'a', 'bear', 72);
    const snap2 = h.last('snapshot-published').snapshot;
    expect(snap2).not.toBe(snap1);
    const bearGroup = { id: 'g2', members: [{ id: 'm', kind: 'token' as const, surface: 'bear', match: FOLD }], countOverlaps: false };
    await h.send({ t: 'query', job: 73, snapshot: snap2, query: { op: 'trend', selection: { docs: ['a'] }, group: bearGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } } });
    const r = h.last('result');
    expect(r.data.op).toBe('trend');
    if (r.data.op === 'trend') expect(Array.from(r.data.trend.count)).toEqual([1, 0, 0, 0]);
    expect(h.all('error').some((e) => /different shard/.test(e.message))).toBe(false);
  });

  it('a late cancel for a finished job is dropped; job bookkeeping does not accrete', async () => {
    const { h, snap } = await ready('the wolf ran');
    await h.send({ t: 'query', job: 40, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } } });
    expect(h.last('result').data.op).toBe('trend');
    await h.send({ t: 'cancel', job: 40 }); // job already finished
    const internals = h.engine as unknown as { activeJobs: Set<number>; cancelledJobs: Set<number> };
    expect(internals.activeJobs.size).toBe(0);
    expect(internals.cancelledJobs.size).toBe(0);
  });
});

describe('company/1 and destinations/1 through the shared executor', () => {
  const tracks = [
    { seriesId: 's-wolf', group: wolfGroup },
    { seriesId: 's-fox', group: foxGroup },
  ];
  const companyRequest = {
    method: 'company/1' as const,
    gapEdges: COMPANY_GAP_EDGES_V1,
  };
  const destinationsRequest = {
    method: 'destinations/1' as const,
    windowTokens: DESTINATION_WINDOW_TOKENS_V1,
    limit: DESTINATION_MAX_RESULTS,
    focus: null,
  };

  async function ready() {
    const h = harness();
    const textA = 'wolf and fox waited. wolf followed fox.';
    const textB = 'fox kept company with wolf.';
    const [a, b] = await Promise.all([
      docSpec('a', textA),
      docSpec('b', textB),
    ]);
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', textA, 10);
    await coldIngest(h, 'g', 'b', textB, 11);
    return { h, snap: h.last('snapshot-published').snapshot };
  }

  it('shares canonical full-corpus occurrences across trend, dispersion, company, and destinations', async () => {
    const { h, snap } = await ready();
    const occurrenceSpy = vi.mocked(occurrences);
    occurrenceSpy.mockClear();

    await h.send({
      t: 'query', job: 20, snapshot: snap,
      query: {
        op: 'trend',
        selection: { docs: ['a', 'b'] },
        group: wolfGroup,
        request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } },
      },
    });
    await h.send({
      t: 'query', job: 21, snapshot: snap,
      query: {
        op: 'dispersion',
        selection: { docs: ['a', 'b'] },
        tracks,
        request: {
          method: 'dispersion/1',
          exactMax: DISPERSION_EXACT_MAX,
          bucketBudget: DISPERSION_BUCKET_BUDGET,
        },
      },
    });
    expect(occurrenceSpy).toHaveBeenCalledTimes(2);

    await h.send({
      t: 'query', job: 22, snapshot: snap,
      query: { op: 'company', tracks, request: companyRequest },
    });
    const companyMessage = h.last('result');
    if (companyMessage.data.op !== 'company') throw new Error('expected company');
    expect(companyMessage.data.company).toMatchObject({
      method: 'company/1',
      tracks: [
        { seriesId: 's-wolf', groupId: wolfGroup.id, total: 3, docCount: 2 },
        { seriesId: 's-fox', groupId: foxGroup.id, total: 3, docCount: 2 },
      ],
    });
    expect(companyMessage.data.company.pairs).toHaveLength(1);
    const companyIndex = h.messages.indexOf(companyMessage);
    expect(h.transferLists[companyIndex]).toEqual([]);

    await h.send({
      t: 'query', job: 23, snapshot: snap,
      query: { op: 'destinations', tracks, request: destinationsRequest },
    });
    const destinationsMessage = h.last('result');
    if (destinationsMessage.data.op !== 'destinations') throw new Error('expected destinations');
    expect(destinationsMessage.data.destinations.method).toBe('destinations/1');
    expect(destinationsMessage.data.destinations.tracks.map((track) => track.total)).toEqual([3, 3]);
    expect(destinationsMessage.data.destinations.destinations.length).toBeGreaterThan(0);
    const destinationsIndex = h.messages.indexOf(destinationsMessage);
    expect(h.transferLists[destinationsIndex]).toEqual([]);

    expect(occurrenceSpy).toHaveBeenCalledTimes(2);
    expect(h.all('error')).toEqual([]);
  });

  it('rejects legacy selections and gates cancellation after final materialization', async () => {
    const invalid = await ready();
    await invalid.h.send({
      t: 'query', job: 30, snapshot: invalid.snap,
      query: {
        op: 'company',
        selection: { docs: ['a'] },
        tracks,
        request: companyRequest,
      },
    });
    expect(invalid.h.last('error')).toMatchObject({ job: 30, code: 'PARSE_FAILED' });
    expect(invalid.h.all('result').some((message) => message.job === 30)).toBe(false);

    for (const [op, cancelAtYield, request] of [
      ['company', 6, companyRequest],
      ['destinations', 8, destinationsRequest],
    ] as const) {
      const { h, snap } = await ready();
      h.clear();
      let yields = 0;
      h.onYield(async () => {
        yields++;
        if (yields === cancelAtYield) await h.send({ t: 'cancel', job: 31 });
      });
      await h.send({
        t: 'query', job: 31, snapshot: snap,
        query: { op, tracks, request },
      });
      expect(yields, op).toBeGreaterThanOrEqual(cancelAtYield);
      expect(h.all('cancelled').some((message) => message.job === 31), op).toBe(true);
      expect(h.all('result').some((message) => message.job === 31), op).toBe(false);
      expect(h.all('error'), op).toEqual([]);
    }
  });
});

describe('matches-window/1 through the executor and engine', () => {
  const query = (
    anchor: { kind: 'position'; doc: string; token: number } | { kind: 'rank'; rank: number },
    includeAxis: boolean,
    tracks = [{ seriesId: 's-wolf', group: wolfGroup }],
  ) => ({
    op: 'matches-window' as const,
    tracks,
    request: {
      method: 'matches-window/1' as const,
      anchor,
      before: 10,
      after: 10,
      contextTokens: 1,
      includeAxis,
    },
  });

  async function ready() {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far. a wolf slept.');
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far. a wolf slept.', 10);
    return { h, snap: h.last('snapshot-published').snapshot };
  }

  it('returns exact windows, conditionally transfers a fresh axis, and reuses its cache', async () => {
    const { h, snap } = await ready();
    await h.send({
      t: 'query', job: 300, snapshot: snap,
      query: query({ kind: 'position', doc: 'a', token: 3 }, true),
    });
    const first = h.last('result');
    if (first.data.op !== 'matches-window') throw new Error('expected matches-window');
    expect(first.data.window).toMatchObject({
      method: 'matches-window/1',
      total: 2,
      trackCount: 1,
      anchorRank: 1,
      firstRank: 0,
      preceding: { rank: 0, globalToken: 1 },
    });
    expect(first.data.window.rows.map((row) => [row.doc, row.pos, row.nodeText])).toEqual([
      ['a', 1, 'wolf'],
      ['a', 5, 'wolf'],
    ]);
    expect(Array.from(first.data.window.axis!.ranks)).toEqual([0]);
    expect(Array.from(first.data.window.axis!.globalTokens)).toEqual([1]);
    const firstIndex = h.messages.indexOf(first);
    expect(new Set(h.transferLists[firstIndex] as ArrayBuffer[])).toEqual(new Set([
      first.data.window.axis!.ranks.buffer,
      first.data.window.axis!.globalTokens.buffer,
    ]));

    await h.send({
      t: 'query', job: 301, snapshot: snap,
      query: query({ kind: 'rank', rank: 0 }, false),
    });
    const second = h.last('result');
    if (second.data.op !== 'matches-window') throw new Error('expected matches-window');
    expect(second.data.window.axis).toBeUndefined();
    expect(h.transferLists[h.messages.indexOf(second)]).toBeUndefined();

    await h.send({
      t: 'query', job: 308, snapshot: snap,
      query: query({ kind: 'rank', rank: 0 }, true),
    });
    const third = h.last('result');
    if (third.data.op !== 'matches-window') throw new Error('expected matches-window');
    expect(third.data.window.axis!.ranks.buffer).not.toBe(first.data.window.axis!.ranks.buffer);
    expect(third.data.window.axis!.globalTokens.buffer).not.toBe(first.data.window.axis!.globalTokens.buffer);

    const executor = (h.engine as unknown as {
      generation: {
        executor: {
          matchesAxisCache: Map<string, unknown>;
          matchesAxisCacheBytes: number;
        };
      } | null;
    }).generation!.executor;
    expect(executor.matchesAxisCache.size).toBe(1);
    expect(executor.matchesAxisCacheBytes).toBe(8);
  });

  it('constructs canonical full-corpus selection and rejects caller-owned selection', async () => {
    const h = harness();
    const a = await docSpec('a', 'first wolf');
    const b = await docSpec('b', 'second wolf');
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', 'first wolf', 10);
    await coldIngest(h, 'g', 'b', 'second wolf', 11);
    const snap = h.last('snapshot-published').snapshot;
    await h.send({
      t: 'query', job: 306, snapshot: snap,
      query: query({ kind: 'rank', rank: 0 }, false),
    });
    const result = h.last('result');
    if (result.data.op !== 'matches-window') throw new Error('expected matches-window');
    expect(result.data.window.rows.map((row) => [row.doc, row.pos])).toEqual([
      ['a', 1],
      ['b', 1],
    ]);

    await h.send({
      t: 'query', job: 307, snapshot: snap,
      query: { ...query({ kind: 'rank', rank: 0 }, false), selection: { docs: ['a'] } } as never,
    });
    expect(h.last('error')).toMatchObject({ job: 307, code: 'PARSE_FAILED' });
  });

  it('keys axes by ordered matching identity rather than presentation ids', async () => {
    const { h, snap } = await ready();
    await h.send({
      t: 'query', job: 302, snapshot: snap,
      query: query({ kind: 'rank', rank: 0 }, false),
    });
    await h.send({
      t: 'query', job: 303, snapshot: snap,
      query: query({ kind: 'rank', rank: 0 }, false, [{
        seriesId: 'renamed',
        group: {
          ...wolfGroup,
          id: 'renamed-group',
          members: wolfGroup.members.map((member) => ({ ...member, id: 'renamed-member' })),
        },
      }]),
    });
    const executor = (h.engine as unknown as {
      generation: { executor: { matchesAxisCache: Map<string, unknown> } } | null;
    }).generation!.executor;
    expect(executor.matchesAxisCache.size).toBe(1);

    const ranGroup = {
      ...wolfGroup,
      id: 'ran',
      members: wolfGroup.members.map((member) => ({ ...member, surface: 'ran' })),
    };
    await h.send({
      t: 'query', job: 304, snapshot: snap,
      query: query({ kind: 'rank', rank: 0 }, false, [{ seriesId: 'ran', group: ranGroup }]),
    });
    expect(executor.matchesAxisCache.size).toBe(2);
  });

  it('binds multiple track ordinals to the right identities and keys their order', async () => {
    const { h, snap } = await ready();
    const ranGroup = {
      ...wolfGroup,
      id: 'g-ran',
      members: wolfGroup.members.map((member) => ({ ...member, surface: 'ran' })),
    };
    const tracks = [
      { seriesId: 's-wolf', group: wolfGroup },
      { seriesId: 's-ran', group: ranGroup },
    ];
    await h.send({
      t: 'query', job: 309, snapshot: snap,
      query: query({ kind: 'rank', rank: 0 }, false, tracks),
    });
    const result = h.last('result');
    if (result.data.op !== 'matches-window') throw new Error('expected matches-window');
    expect(result.data.window.trackCount).toBe(2);
    expect(result.data.window.rows.map((row) => [row.pos, row.seriesId, row.groupId, row.nodeText])).toEqual([
      [1, 's-wolf', 'g1', 'wolf'],
      [2, 's-ran', 'g-ran', 'ran'],
      [5, 's-wolf', 'g1', 'wolf'],
    ]);
    const [firstWolf, ran] = result.data.window.rows;
    expect(firstWolf!.rightMarks.map((mark) => ({
      text: firstWolf!.right.slice(mark.charsUtf16.start, mark.charsUtf16.end),
      tracks: mark.trackOrdinals,
    }))).toEqual([{ text: 'ran', tracks: [1] }]);
    expect(ran!.leftMarks.map((mark) => ({
      text: ran!.left.slice(mark.charsUtf16.start, mark.charsUtf16.end),
      tracks: mark.trackOrdinals,
    }))).toEqual([{ text: 'wolf', tracks: [0] }]);

    await h.send({
      t: 'query', job: 310, snapshot: snap,
      query: query({ kind: 'rank', rank: 0 }, false, [...tracks].reverse()),
    });
    const executor = (h.engine as unknown as {
      generation: { executor: { matchesAxisCache: Map<string, unknown> } } | null;
    }).generation!.executor;
    expect(executor.matchesAxisCache.size).toBe(2);
  });

  it('drops sparse axes when incremental publication supersedes the snapshot', async () => {
    const h = harness();
    const a = await docSpec('a', 'wolf first');
    const b = await docSpec('b', 'wolf second');
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', 'wolf first', 10);
    const firstSnapshot = h.last('snapshot-published').snapshot;
    await h.send({
      t: 'query', job: 311, snapshot: firstSnapshot,
      query: query({ kind: 'rank', rank: 0 }, false),
    });
    const executor = (h.engine as unknown as {
      generation: {
        executor: {
          matchesAxisCache: Map<string, unknown>;
          matchesAxisCacheBytes: number;
        };
      } | null;
    }).generation!.executor;
    expect(executor.matchesAxisCache.size).toBe(1);

    await coldIngest(h, 'g', 'b', 'wolf second', 11);
    expect(h.last('snapshot-published').snapshot).not.toBe(firstSnapshot);
    expect(executor.matchesAxisCache.size).toBe(0);
    expect(executor.matchesAxisCacheBytes).toBe(0);
  });

  it('reuses a cached axis after selection-thrashing evicts and recomputes occurrences', async () => {
    const { h, snap } = await ready();
    const occurrenceSpy = vi.mocked(occurrences);
    occurrenceSpy.mockClear();
    await h.send({
      t: 'query', job: 312, snapshot: snap,
      query: query({ kind: 'rank', rank: 0 }, false),
    });
    const first = h.last('result');
    if (first.data.op !== 'matches-window') throw new Error('expected matches-window');
    const firstRows = first.data.window.rows;
    const executor = (h.engine as unknown as {
      generation: {
        executor: {
          matchesAxisCache: Map<string, { value: unknown }>;
          occurrenceCache: Map<string, unknown>;
        };
      } | null;
    }).generation!.executor;
    const retainedAxis = [...executor.matchesAxisCache.values()][0]!.value;

    for (const [index, surface] of ['the', 'ran', 'far', 'a', 'slept'].entries()) {
      const group = {
        ...wolfGroup,
        id: `range-${surface}`,
        members: wolfGroup.members.map((member) => ({ ...member, surface })),
      };
      await h.send({
        t: 'query', job: 330 + index, snapshot: snap,
        query: {
          op: 'trend',
          selection: {
            docs: ['a'],
            ranges: [{ doc: 'a', tokens: { start: 0, end: 4 } }],
          },
          group,
          request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } },
        },
      });
    }
    expect(executor.occurrenceCache.size).toBe(MAX_OCCURRENCE_CACHE_ENTRIES);

    await h.send({
      t: 'query', job: 313, snapshot: snap,
      query: query({ kind: 'rank', rank: 0 }, false),
    });
    const second = h.last('result');
    if (second.data.op !== 'matches-window') throw new Error('expected matches-window');
    expect(second.data.window.rows).toEqual(firstRows);
    expect([...executor.matchesAxisCache.values()][0]!.value).toBe(retainedAxis);
    expect(occurrenceSpy).toHaveBeenCalledTimes(7);
  });

  it('bounds the sparse-axis LRU independently from the occurrence cache', async () => {
    const { h, snap } = await ready();
    for (const [index, surface] of ['the', 'wolf', 'ran', 'far', 'a', 'slept'].entries()) {
      const group = {
        ...wolfGroup,
        id: `group-${surface}`,
        members: wolfGroup.members.map((member) => ({ ...member, surface })),
      };
      await h.send({
        t: 'query', job: 320 + index, snapshot: snap,
        query: query({ kind: 'rank', rank: 0 }, false, [{ seriesId: surface, group }]),
      });
    }
    const executor = (h.engine as unknown as {
      generation: {
        executor: {
          matchesAxisCache: Map<string, unknown>;
          matchesAxisCacheBytes: number;
        };
      } | null;
    }).generation!.executor;
    expect(executor.matchesAxisCache.size).toBeLessThanOrEqual(MAX_MATCHES_AXIS_CACHE_ENTRIES);
    expect(executor.matchesAxisCacheBytes).toBeLessThanOrEqual(MAX_MATCHES_AXIS_CACHE_BYTES);
  });

  it('fences cancellation after one track before the next track computes', async () => {
    const { h, snap } = await ready();
    const occurrenceSpy = vi.mocked(occurrences);
    occurrenceSpy.mockClear();
    const ranGroup = {
      ...wolfGroup,
      id: 'ran',
      members: wolfGroup.members.map((member) => ({ ...member, surface: 'ran' })),
    };
    h.clear();
    let yields = 0;
    h.onYield(async () => {
      yields++;
      if (yields === 3) await h.send({ t: 'cancel', job: 305 });
    });
    await h.send({
      t: 'query', job: 305, snapshot: snap,
      query: query(
        { kind: 'position', doc: 'a', token: 3 },
        true,
        [{ seriesId: 'wolf', group: wolfGroup }, { seriesId: 'ran', group: ranGroup }],
      ),
    });
    expect(occurrenceSpy).toHaveBeenCalledTimes(1);
    expect(h.all('cancelled').some((message) => message.job === 305)).toBe(true);
    expect(h.all('result').some((message) => message.job === 305)).toBe(false);
    expect(h.all('error').some((message) => message.job === 305)).toBe(false);
    h.onYield(null);
  });

  it('fences cancellation after materialization', async () => {
    const { h, snap } = await ready();
    h.clear();
    let yields = 0;
    h.onYield(async () => {
      yields++;
      if (yields === 5) await h.send({ t: 'cancel', job: 306 });
    });
    await h.send({
      t: 'query', job: 306, snapshot: snap,
      query: query({ kind: 'position', doc: 'a', token: 3 }, true),
    });
    expect(yields).toBeGreaterThanOrEqual(5);
    expect(h.all('cancelled').some((message) => message.job === 306)).toBe(true);
    expect(h.all('result').some((message) => message.job === 306)).toBe(false);
    expect(h.all('error').some((message) => message.job === 306)).toBe(false);
    h.onYield(null);
  });
});

describe('Slice-3 document-term-count cache', () => {
  async function publishedTwoDocs(): Promise<{
    view: PublishedView;
    snapshot: CorpusSnapshotV1;
  }> {
    const h = harness();
    const a = await docSpec('a', 'alpha beta alpha');
    const b = await docSpec('b', 'beta gamma beta');
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', 'alpha beta alpha', 10);
    await coldIngest(h, 'g', 'b', 'beta gamma beta', 11);
    const generation = (h.engine as unknown as {
      generation: (PublishedView & { readonly snapshot: CorpusSnapshotV1 }) | null;
    }).generation;
    if (!generation) throw new Error('expected published generation');
    return {
      snapshot: generation.snapshot,
      view: {
        snapshot: generation.snapshot,
        ready: generation.ready,
        bound: generation.bound,
        boundTexts: generation.boundTexts,
      },
    };
  }

  const cacheOf = (executor: QueryExecutor) => (
    executor as unknown as {
      termCountCache: Map<string, unknown>;
      termCountCacheBytes: number;
      occurrenceCache: Map<string, { bytes: number }>;
      occurrenceCacheBytes: number;
    }
  );

  it('accounts occurrence-cache bytes exactly and evicts by the byte LRU', async () => {
    const { view, snapshot } = await publishedTwoDocs();
    const executor = new QueryExecutor(
      DEFAULT_INDEX_RECIPE,
      buildResolver,
      { maxEntries: 1, maxBytes: 1 },
      { maxEntries: MAX_OCCURRENCE_CACHE_ENTRIES, maxBytes: 50 },
    );
    executor.publish(view, []);
    const all = await resolveSelection(snapshot, { docs: ['a', 'b'] as never });
    const run = (surface: string) => executor.trend(
      all,
      { id: surface, countOverlaps: false, members: [{ id: 'm', kind: 'token', surface, match: FOLD }] },
      { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } },
      async () => {},
    );
    await run('alpha'); // 2 rows → 44 bytes
    expect(cacheOf(executor).occurrenceCacheBytes).toBe(44);
    await run('gamma'); // 1 row → 24 bytes; alpha is the LRU victim
    const cache = cacheOf(executor);
    expect(cache.occurrenceCache.size).toBe(1);
    expect(cache.occurrenceCacheBytes).toBe(24);
    expect(cache.occurrenceCacheBytes).toBe(
      [...cache.occurrenceCache.values()].reduce((sum, entry) => sum + entry.bytes, 0),
    );
  });

  it('drops every superseded-snapshot occurrence entry on publish', async () => {
    const { view, snapshot } = await publishedTwoDocs();
    const executor = new QueryExecutor(DEFAULT_INDEX_RECIPE);
    executor.publish(view, []);
    const all = await resolveSelection(snapshot, { docs: ['a', 'b'] as never });
    await executor.trend(
      all,
      { id: 'alpha', countOverlaps: false, members: [{ id: 'm', kind: 'token', surface: 'alpha', match: FOLD }] },
      { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } },
      async () => {},
    );
    expect(cacheOf(executor).occurrenceCache.size).toBe(1);
    const nextSnapshot = { ...view.snapshot, id: 'superseding-snapshot' as CorpusSnapshotV1['id'] };
    executor.publish({ ...view, snapshot: nextSnapshot }, []);
    expect(cacheOf(executor).occurrenceCache.size).toBe(0);
    expect(cacheOf(executor).occurrenceCacheBytes).toBe(0);
  });

  it('only permits occurrence and matches-axis policies that reduce hard bounds', () => {
    expect(() => new QueryExecutor(
      DEFAULT_INDEX_RECIPE,
      buildResolver,
      { maxEntries: 1, maxBytes: 1 },
      { maxEntries: 0, maxBytes: 1 },
    )).toThrow(RangeError);
    expect(() => new QueryExecutor(
      DEFAULT_INDEX_RECIPE,
      buildResolver,
      { maxEntries: 1, maxBytes: 1 },
      { maxEntries: 1, maxBytes: MAX_OCCURRENCE_CACHE_BYTES + 1 },
    )).toThrow(RangeError);
    expect(() => new QueryExecutor(
      DEFAULT_INDEX_RECIPE,
      buildResolver,
      { maxEntries: 1, maxBytes: 1 },
      { maxEntries: 1, maxBytes: 1 },
      { maxEntries: 0, maxBytes: 1 },
    )).toThrow(RangeError);
    expect(() => new QueryExecutor(
      DEFAULT_INDEX_RECIPE,
      buildResolver,
      { maxEntries: 1, maxBytes: 1 },
      { maxEntries: 1, maxBytes: 1 },
      { maxEntries: 1, maxBytes: MAX_MATCHES_AXIS_CACHE_BYTES + 1 },
    )).toThrow(RangeError);
  });

  it('hits by [snapshot, doc, rangeKey] and checkpoints between documents', async () => {
    const { view, snapshot } = await publishedTwoDocs();
    const executor = new QueryExecutor(
      DEFAULT_INDEX_RECIPE,
      buildResolver,
      { maxEntries: 8, maxBytes: 1024 },
    );
    executor.publish(view, []);
    const all = await resolveSelection(snapshot, { docs: ['a', 'b'] as never });
    const checkpoint = vi.fn(async () => {});
    vi.mocked(documentTermCounts).mockClear();

    const first = await executor.termCounts(all, checkpoint);
    const second = await executor.termCounts(all, checkpoint);
    expect(vi.mocked(documentTermCounts)).toHaveBeenCalledTimes(2);
    expect(checkpoint).toHaveBeenCalledTimes(4);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(cacheOf(executor).termCountCache.size).toBe(2);
  });

  it('distinguishes canonical ranges and evicts least-recently-used entries', async () => {
    const { view, snapshot } = await publishedTwoDocs();
    const executor = new QueryExecutor(
      DEFAULT_INDEX_RECIPE,
      buildResolver,
      { maxEntries: 2, maxBytes: 1024 },
    );
    executor.publish(view, []);
    const fullA = await resolveSelection(snapshot, { docs: ['a'] as never });
    const rangeA = await resolveSelection(snapshot, {
      docs: ['a'] as never,
      ranges: [{ doc: 'a' as never, tokens: { start: 0 as never, end: 1 as never } }],
    });
    const fullB = await resolveSelection(snapshot, { docs: ['b'] as never });
    const checkpoint = async () => {};
    vi.mocked(documentTermCounts).mockClear();

    await executor.termCounts(fullA, checkpoint); // A full
    await executor.termCounts(rangeA, checkpoint); // A range
    await executor.termCounts(fullA, checkpoint); // touch A full
    await executor.termCounts(fullB, checkpoint); // evict A range
    expect(vi.mocked(documentTermCounts)).toHaveBeenCalledTimes(3);
    expect(cacheOf(executor).termCountCache.size).toBe(2);
    await executor.termCounts(rangeA, checkpoint);
    expect(vi.mocked(documentTermCounts)).toHaveBeenCalledTimes(4);
  });

  it('enforces the byte budget and drops replaced-document entries on publish', async () => {
    const { view, snapshot } = await publishedTwoDocs();
    // Each fixture result carries two Uint32Array entries = 16 payload bytes.
    const executor = new QueryExecutor(
      DEFAULT_INDEX_RECIPE,
      buildResolver,
      { maxEntries: 8, maxBytes: 16 },
    );
    executor.publish(view, []);
    const fullA = await resolveSelection(snapshot, { docs: ['a'] as never });
    const fullB = await resolveSelection(snapshot, { docs: ['b'] as never });
    const checkpoint = async () => {};

    await executor.termCounts(fullA, checkpoint);
    expect(cacheOf(executor).termCountCacheBytes).toBe(16);
    await executor.termCounts(fullB, checkpoint);
    expect(cacheOf(executor).termCountCache.size).toBe(1);
    expect(cacheOf(executor).termCountCacheBytes).toBe(16);

    executor.publish(view, ['b']);
    expect(cacheOf(executor).termCountCache.size).toBe(0);
    expect(cacheOf(executor).termCountCacheBytes).toBe(0);
  });

  it('only permits fixture policies that reduce the exported hard bounds', () => {
    expect(() => new QueryExecutor(
      DEFAULT_INDEX_RECIPE,
      buildResolver,
      { maxEntries: 0, maxBytes: 1 },
    )).toThrow(RangeError);
    expect(() => new QueryExecutor(
      DEFAULT_INDEX_RECIPE,
      buildResolver,
      { maxEntries: 1, maxBytes: Number.MAX_SAFE_INTEGER },
    )).toThrow(RangeError);
  });
});


describe('inventory/1 through the executor and engine', () => {
  const request = {
    method: 'inventory/1' as const,
    rhythmBinsPerDoc: 2,
    mattrWindow: 3,
  };

  it('returns selected totals and fresh transfer buffers', async () => {
    const h = harness();
    const a = await docSpec('a', 'one two three. four five six.');
    const b = await docSpec('b', 'missing until later');
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', 'one two three. four five six.', 10);
    const snap = h.last('snapshot-published').snapshot;
    vi.mocked(documentTermCounts).mockClear();

    await h.send({
      t: 'query',
      job: 20,
      snapshot: snap,
      query: {
        op: 'inventory',
        selection: {
          docs: ['a'],
          ranges: [{ doc: 'a', tokens: { start: 1, end: 5 } }],
        },
        request,
      },
    });
    const result = h.last('result');
    if (result.data.op !== 'inventory') throw new Error('expected inventory');
    expect(result.data.inventory.selection).toMatch(/^[0-9a-f]{64}$/);
    expect(result.data.inventory.totals).toMatchObject({
      selectedDocs: 1,
      expectedDocs: 2,
      missingDocs: 1,
      tokens: 4,
      lexicalTokens: 4,
    });
    expect(result.data.inventory.documents[0]).toMatchObject({
      doc: 'a',
      selectedTokens: 4,
      fullTokens: 6,
    });
    const transferIndex = h.messages.findIndex(
      (message) => message.t === 'result' && message.job === 20,
    );
    expect(h.transferLists[transferIndex]?.length).toBeGreaterThan(0);

    // Same canonical request reuses the sparse document vector. The result
    // arrays are freshly materialized, so the first transfer cannot detach it.
    await h.send({
      t: 'query',
      job: 21,
      snapshot: snap,
      query: {
        op: 'inventory',
        selection: {
          docs: ['a'],
          ranges: [{ doc: 'a', tokens: { start: 1, end: 5 } }],
        },
        request,
      },
    });
    expect(vi.mocked(documentTermCounts)).toHaveBeenCalledTimes(1);
    const again = h.last('result');
    expect(
      again.data.op === 'inventory' && again.data.inventory.totals.tokens,
    ).toBe(4);
  });

  it('rejects malformed caps at the wire before the inventory kernel runs', async () => {
    const h = harness();
    const a = await docSpec('a', 'one two');
    await begin(h, [a]);
    await coldIngest(h, 'g', 'a', 'one two', 10);
    const snap = h.last('snapshot-published').snapshot;
    await h.send({
      t: 'query',
      job: 30,
      snapshot: snap,
      query: {
        op: 'inventory',
        selection: { docs: ['a'] },
        request: { ...request, rhythmBinsPerDoc: 257 },
      } as never,
    });
    expect(h.last('error').code).toBe('PARSE_FAILED');
    expect(h.all('result').some((message) => message.job === 30)).toBe(false);
  });
});


describe('frequency through the executor and engine', () => {
  it('freq-list/2 shares the Slice-3 document vector with inventory', async () => {
    const h = harness();
    const a = await docSpec('a', 'x x y z');
    await begin(h, [a]);
    await coldIngest(h, 'g', 'a', 'x x y z', 10);
    const snap = h.last('snapshot-published').snapshot;
    const selection = {
      docs: ['a'],
      ranges: [{ doc: 'a', tokens: { start: 0, end: 3 } }],
    };
    vi.mocked(documentTermCounts).mockClear();
    await h.send({
      t: 'query',
      job: 40,
      snapshot: snap,
      query: {
        op: 'inventory',
        selection,
        request: {
          method: 'inventory/1',
          rhythmBinsPerDoc: 0,
          mattrWindow: 3,
        },
      },
    });
    await h.send({
      t: 'query',
      job: 41,
      snapshot: snap,
      query: {
        op: 'freq-list',
        selection,
        request: {
          method: 'freq-list/2',
          filter: { minCount: 1, minDocFreq: 1, classes: ['lexical'] },
          sort: { by: 'count', dir: -1 },
          page: { offset: 0, limit: 200 },
          dispersion: true,
        },
      },
    });
    expect(vi.mocked(documentTermCounts)).toHaveBeenCalledTimes(1);
    const result = h.last('result');
    if (result.data.op !== 'freq-list') throw new Error('expected frequency');
    expect(result.data.frequency.totalTokens).toBe(3);
    expect(result.data.frequency.rows.map((row) => [row.key, row.count])).toEqual([
      ['x', 2],
      ['y', 1],
    ]);
    expect(result.data.frequency.rows.every((row) => row.dp === 0 && row.dpNorm === null)).toBe(true);
  });
});

describe('keyness/1 through the executor and engine', () => {
  const request = {
    method: 'keyness-g2-2x2/1' as const,
    effect: 'log-ratio-halves/1' as const,
    filter: {
      minCountTotal: 1,
      minDocFreqTotal: 1,
      classes: ['lexical' as const],
    },
    sort: { by: 'logRatio' as const, dir: -1 as const },
    page: { offset: 0, limit: 200 },
    side: 'both' as const,
  };

  it('resolves two sides, reuses cached document vectors, and inverts on swap', async () => {
    const h = harness();
    const a = await docSpec('a', 'apple apple apple common');
    const b = await docSpec('b', 'banana banana banana common');
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', 'apple apple apple common', 10);
    await coldIngest(h, 'g', 'b', 'banana banana banana common', 11);
    const snap = h.last('snapshot-published').snapshot;
    vi.mocked(documentTermCounts).mockClear();

    await h.send({
      t: 'query',
      job: 60,
      snapshot: snap,
      query: {
        op: 'keyness',
        request: {
          ...request,
          a: { docs: ['a'] },
          b: { docs: ['b'] },
        },
      },
    });
    const ab = h.last('result');
    if (ab.data.op !== 'keyness') throw new Error('expected keyness');
    expect(ab.data.keyness.totalsA).toEqual({ tokens: 4, documents: 1, positiveParts: 1 });
    expect(ab.data.keyness.totalsB).toEqual({ tokens: 4, documents: 1, positiveParts: 1 });
    expect(ab.data.keyness.rows.map((row) => row.key)).toEqual([
      'apple',
      'common',
      'banana',
    ]);
    expect(ab.data.keyness.rows.find((row) => row.key === 'apple')).toMatchObject({
      countA: 3,
      countB: 0,
      rangeA: 1,
      rangeB: 0,
    });
    expect(vi.mocked(documentTermCounts)).toHaveBeenCalledTimes(2);

    await h.send({
      t: 'query',
      job: 61,
      snapshot: snap,
      query: {
        op: 'keyness',
        request: {
          ...request,
          a: { docs: ['b'] },
          b: { docs: ['a'] },
        },
      },
    });
    const ba = h.last('result');
    if (ba.data.op !== 'keyness') throw new Error('expected keyness');
    expect(vi.mocked(documentTermCounts)).toHaveBeenCalledTimes(2);
    const abApple = ab.data.keyness.rows.find((row) => row.key === 'apple')!;
    const baApple = ba.data.keyness.rows.find((row) => row.key === 'apple')!;
    expect(baApple.logRatio).toBeCloseTo(-abApple.logRatio, 12);
    expect(baApple.g2).toBeCloseTo(-abApple.g2, 12);
  });

  it('maps overlap and malformed side membership to SELECTION_INVALID', async () => {
    const h = harness();
    const a = await docSpec('a', 'one two three four');
    const b = await docSpec('b', 'five six seven eight');
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', 'one two three four', 10);
    await coldIngest(h, 'g', 'b', 'five six seven eight', 11);
    const snap = h.last('snapshot-published').snapshot;
    await h.send({
      t: 'query',
      job: 62,
      snapshot: snap,
      query: {
        op: 'keyness',
        request: {
          ...request,
          a: { docs: ['a'] },
          b: {
            docs: ['a'],
            ranges: [{ doc: 'a', tokens: { start: 2, end: 4 } }],
          },
        },
      },
    });
    expect(h.last('error')).toMatchObject({
      job: 62,
      code: 'SELECTION_INVALID',
    });
    expect(h.last('error').message).toMatch(/overlap.*'a'/);

    await h.send({
      t: 'query',
      job: 63,
      snapshot: snap,
      query: {
        op: 'keyness',
        request: {
          ...request,
          a: { docs: ['missing'] },
          b: { docs: ['b'] },
        },
      },
    });
    expect(h.last('error')).toMatchObject({
      job: 63,
      code: 'SELECTION_INVALID',
    });
  });
});


describe('dispersion/1 through the executor (slice-2 commit C)', () => {
  const dispReq = { method: 'dispersion/1' as const, exactMax: DISPERSION_EXACT_MAX, bucketBudget: DISPERSION_BUCKET_BUDGET };

  it('EXACT representation: CSR starts/spans per doc, totals equal the source, buffers are fresh (cache survives transfer)', async () => {
    const h = harness();
    const a = await docSpec('a', 'the wolf ran. a dire wolf slept.');
    const b = await docSpec('b', 'no match here');
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', 'the wolf ran. a dire wolf slept.', 10);
    await coldIngest(h, 'g', 'b', 'no match here', 11);
    const snap = h.last('snapshot-published').snapshot;
    await h.send({ t: 'query', job: 20, snapshot: snap, query: { op: 'dispersion', selection: { docs: ['a', 'b'] }, tracks: [{ seriesId: 's1', group: wolfGroup }], request: dispReq } });
    const res = h.last('result');
    if (res.data.op !== 'dispersion') throw new Error('expected dispersion');
    const track = res.data.dispersion.tracks[0]!;
    expect(track.seriesId).toBe('s1');
    expect(track.groupId).toBe(wolfGroup.id);
    expect(track.total).toBe(2); // wolf@1, wolf@5 in doc a
    expect(res.data.dispersion.geometry).toBeNull(); // exact-only: no geometry
    if (track.data.kind !== 'exact') throw new Error('expected exact');
    expect([...track.data.docOffsets]).toEqual([0, 2, 2]); // both in a, none in b
    expect([...track.data.starts]).toEqual([1, 5]);
    expect([...track.data.spanTokens]).toEqual([1, 1]);
    // The result transferred its buffers; the occurrence CACHE must survive —
    // an immediate re-query (cache hit) still answers correctly.
    const transfers = h.transferLists[h.messages.findIndex((m) => m.t === 'result' && m.job === 20)];
    expect(transfers && transfers.length).toBeGreaterThan(0);
    await h.send({ t: 'query', job: 21, snapshot: snap, query: { op: 'dispersion', selection: { docs: ['a', 'b'] }, tracks: [{ seriesId: 's1', group: wolfGroup }], request: dispReq } });
    const again = h.last('result');
    if (again.data.op !== 'dispersion') throw new Error('expected dispersion');
    const t2 = again.data.dispersion.tracks[0]!;
    expect(t2.total).toBe(2);
    if (t2.data.kind === 'exact') expect([...t2.data.starts]).toEqual([1, 5]);
  });

  it('SHARES the occurrence cache with trend/Matches — a dispersion after trend recomputes nothing', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far. a wolf slept.');
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far. a wolf slept.', 10);
    const snap = h.last('snapshot-published').snapshot;
    const occSpy = () => vi.mocked(occurrences);
    occSpy().mockClear();
    await h.send({ t: 'query', job: 30, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } } });
    expect(occSpy()).toHaveBeenCalledTimes(1);
    await h.send({ t: 'query', job: 31, snapshot: snap, query: { op: 'dispersion', selection: { docs: ['a'] }, tracks: [{ seriesId: 's1', group: wolfGroup }], request: dispReq } });
    expect(occSpy()).toHaveBeenCalledTimes(1); // served from the shared cache
  });

  it('the ADAPTIVE boundary through the real dispatcher: exactly DISPERSION_EXACT_MAX stays EXACT', async () => {
    // Pins the executor's <= decision (a regression to < flips this corpus
    // to density). Same real-index path as the density test below.
    const n = DISPERSION_EXACT_MAX;
    const text = 'wolf '.repeat(n).trim();
    const h = harness();
    const spec = await docSpec('a', text);
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', text, 10);
    const snap = h.last('snapshot-published').snapshot;
    await h.send({ t: 'query', job: 45, snapshot: snap, query: { op: 'dispersion', selection: { docs: ['a'] }, tracks: [{ seriesId: 's1', group: wolfGroup }], request: dispReq } });
    const res = h.last('result');
    if (res.data.op !== 'dispersion') throw new Error('expected dispersion');
    expect(res.data.dispersion.method).toBe('dispersion/1');
    const track = res.data.dispersion.tracks[0]!;
    expect(track.total).toBe(n);
    expect(track.data.kind).toBe('exact'); // AT the boundary: exact, not density
    expect(res.data.dispersion.geometry).toBeNull();
  }, 40_000);

  it('DENSITY representation above the exact threshold: labeled, geometry present, bucket sums equal the exact total', async () => {
    // A single doc whose one term crosses DISPERSION_EXACT_MAX: 50_001
    // occurrences of 'wolf'. Real index build — the honest path, no stubs.
    const n = DISPERSION_EXACT_MAX + 1;
    const text = 'wolf '.repeat(n).trim();
    const h = harness();
    const spec = await docSpec('a', text);
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', text, 10);
    const snap = h.last('snapshot-published').snapshot;
    await h.send({ t: 'query', job: 40, snapshot: snap, query: { op: 'dispersion', selection: { docs: ['a'] }, tracks: [{ seriesId: 's1', group: wolfGroup }], request: dispReq } });
    const res = h.last('result');
    if (res.data.op !== 'dispersion') throw new Error('expected dispersion');
    expect(res.data.dispersion.method).toBe('dispersion/1'); // versioned result discriminator
    const track = res.data.dispersion.tracks[0]!;
    expect(track.total).toBe(n); // the EXACT total is echoed even in density
    if (track.data.kind !== 'density') throw new Error('expected density');
    const g = res.data.dispersion.geometry!;
    expect(g).not.toBeNull();
    expect(g.order).toEqual(['a']);
    const sum = [...track.data.counts].reduce((s, c) => s + c, 0);
    expect(sum).toBe(n); // HONEST buckets: nothing sampled, nothing dropped
    expect(track.data.counts.length).toBeLessThanOrEqual(DISPERSION_BUCKET_BUDGET);
  }, 30_000);
});

describe('occurrence-step/1 through the executor', () => {
  const query = (doc: string, token: number, direction: 1 | -1) => ({
    op: 'occurrence-step' as const,
    tracks: [{ seriesId: 's-wolf', group: wolfGroup }],
    request: { method: 'occurrence-step/1' as const, doc, token, direction },
  });

  it('steps exact occurrences across the full corpus, returns identity, and shares the cache', async () => {
    const h = harness();
    const textA = 'the wolf ran far. a wolf slept.';
    const textB = 'another wolf watched.';
    const [a, b] = await Promise.all([docSpec('a', textA), docSpec('b', textB)]);
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', textA, 10);
    await coldIngest(h, 'g', 'b', textB, 11);
    const snap = h.last('snapshot-published').snapshot;
    const occSpy = vi.mocked(occurrences);
    occSpy.mockClear();

    await h.send({
      t: 'query', job: 50, snapshot: snap,
      query: {
        op: 'trend', selection: { docs: ['a', 'b'] }, group: wolfGroup,
        request: { coordinate: 'declared-sequence', bins: { mode: 'per-doc', count: 4 } },
      },
    });
    expect(occSpy).toHaveBeenCalledTimes(1);

    await h.send({ t: 'query', job: 51, snapshot: snap, query: query('a', 1, 1) });
    const next = h.last('result');
    if (next.data.op !== 'occurrence-step') throw new Error('expected occurrence-step');
    expect(next.data).toEqual({
      op: 'occurrence-step',
      seriesId: 's-wolf',
      groupId: wolfGroup.id,
      step: {
        method: 'occurrence-step/1',
        hit: { doc: 'a', token: 5, spanTokens: 1, members: [0] }, atEdge: false,
      },
    });
    expect(occSpy).toHaveBeenCalledTimes(1);

    await h.send({ t: 'query', job: 52, snapshot: snap, query: query('a', 6, 1) });
    const crossBook = h.last('result');
    if (crossBook.data.op !== 'occurrence-step') throw new Error('expected occurrence-step');
    expect(crossBook.data.step.hit).toMatchObject({ doc: 'b', token: 1 });

    await h.send({ t: 'query', job: 53, snapshot: snap, query: query('b', 1, -1) });
    const previous = h.last('result');
    if (previous.data.op !== 'occurrence-step') throw new Error('expected occurrence-step');
    expect(previous.data.step.hit).toMatchObject({ doc: 'a', token: 5 });

    await h.send({ t: 'query', job: 54, snapshot: snap, query: query('b', 2, 1) });
    const cycled = h.last('result');
    if (cycled.data.op !== 'occurrence-step') throw new Error('expected occurrence-step');
    expect(cycled.data.step).toEqual({
      method: 'occurrence-step/1',
      hit: { doc: 'a', token: 1, spanTokens: 1, members: [0] },
      atEdge: false,
    });

    const absentGroup = {
      ...wolfGroup,
      id: 'absent-group',
      members: wolfGroup.members.map((member) => ({
        ...member,
        id: 'absent',
        surface: 'unfindabletoken',
      })),
    };
    await h.send({
      t: 'query', job: 55, snapshot: snap,
      query: {
        op: 'occurrence-step',
        tracks: [{ seriesId: 's-absent', group: absentGroup }],
        request: { method: 'occurrence-step/1', doc: 'a', token: 1, direction: 1 },
      },
    });
    const absent = h.last('result');
    if (absent.data.op !== 'occurrence-step') throw new Error('expected occurrence-step');
    expect(absent.data.step).toEqual({
      method: 'occurrence-step/1', hit: null, atEdge: true,
    });
  });

  it('chooses the nearest reference from any track and cycles at either edge', async () => {
    const h = harness();
    const text = 'wolf fox wolf';
    const spec = await docSpec('a', text);
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', text, 10);
    const snap = h.last('snapshot-published').snapshot;
    const foxGroup = {
      ...wolfGroup,
      id: 'fox-group',
      members: wolfGroup.members.map((member) => ({ ...member, id: 'fox', surface: 'fox' })),
    };
    const anyTermQuery = (token: number, direction: 1 | -1) => ({
      op: 'occurrence-step' as const,
      tracks: [
        { seriesId: 's-wolf', group: wolfGroup },
        { seriesId: 's-fox', group: foxGroup },
      ],
      request: { method: 'occurrence-step/1' as const, doc: 'a', token, direction },
    });

    await h.send({ t: 'query', job: 58, snapshot: snap, query: anyTermQuery(0, 1) });
    const fox = h.last('result');
    if (fox.data.op !== 'occurrence-step') throw new Error('expected occurrence-step');
    expect(fox.data).toMatchObject({
      seriesId: 's-fox',
      groupId: 'fox-group',
      step: { hit: { doc: 'a', token: 1 } },
    });

    await h.send({ t: 'query', job: 59, snapshot: snap, query: anyTermQuery(2, 1) });
    const first = h.last('result');
    if (first.data.op !== 'occurrence-step') throw new Error('expected occurrence-step');
    expect(first.data).toMatchObject({
      seriesId: 's-wolf',
      step: { hit: { doc: 'a', token: 0 }, atEdge: false },
    });

    await h.send({ t: 'query', job: 60, snapshot: snap, query: anyTermQuery(0, -1) });
    const last = h.last('result');
    if (last.data.op !== 'occurrence-step') throw new Error('expected occurrence-step');
    expect(last.data).toMatchObject({
      seriesId: 's-wolf',
      step: { hit: { doc: 'a', token: 2 }, atEdge: false },
    });
  });

  it('coalesces real countOverlaps duplicate starts into inverse reading stops', async () => {
    const h = harness();
    const text = 'the wolf ran far. a wolf slept.';
    const spec = await docSpec('a', text);
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', text, 10);
    const snap = h.last('snapshot-published').snapshot;
    const overlapGroup = {
      id: 'overlap',
      countOverlaps: true,
      members: [
        ...wolfGroup.members,
        {
          id: 'prefix', kind: 'prefix' as const, stem: 'wol',
          match: { case: 'folded' as const, diacritics: 'sensitive' as const },
        },
      ],
    };
    const overlapQuery = (token: number, direction: 1 | -1) => ({
      op: 'occurrence-step' as const,
      tracks: [{ seriesId: 'overlap-series', group: overlapGroup }],
      request: { method: 'occurrence-step/1' as const, doc: 'a', token, direction },
    });

    await h.send({ t: 'query', job: 55, snapshot: snap, query: overlapQuery(0, 1) });
    const first = h.last('result');
    if (first.data.op !== 'occurrence-step') throw new Error('expected occurrence-step');
    expect(first.data.step.hit).toEqual({ doc: 'a', token: 1, spanTokens: 1, members: [0, 1] });

    await h.send({ t: 'query', job: 56, snapshot: snap, query: overlapQuery(1, 1) });
    const second = h.last('result');
    if (second.data.op !== 'occurrence-step') throw new Error('expected occurrence-step');
    expect(second.data.step.hit).toEqual({ doc: 'a', token: 5, spanTokens: 1, members: [0, 1] });

    await h.send({ t: 'query', job: 57, snapshot: snap, query: overlapQuery(5, -1) });
    const back = h.last('result');
    if (back.data.op !== 'occurrence-step') throw new Error('expected occurrence-step');
    expect(back.data.step).toEqual(first.data.step);
  });

  it('rejects caller selection and observes cancellation before emission', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far. a wolf slept.');
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far. a wolf slept.', 10);
    const snap = h.last('snapshot-published').snapshot;
    await h.send({
      t: 'query', job: 60, snapshot: snap,
      query: { ...query('a', 1, 1), selection: { docs: ['a'] } } as never,
    });
    expect(h.last('error').code).toBe('PARSE_FAILED');

    h.clear();
    let yields = 0;
    h.onYield(async () => {
      yields++;
      if (yields === 4) await h.send({ t: 'cancel', job: 61 });
    });
    await h.send({ t: 'query', job: 61, snapshot: snap, query: query('a', 1, 1) });
    expect(h.all('cancelled').some((message) => message.job === 61)).toBe(true);
    expect(h.all('result').some((message) => message.job === 61)).toBe(false);
    h.onYield(null);
  });
});

describe('reader-page/1 through the executor (slice-2 commit G)', () => {
  const rp = (doc: string, cursor: Record<string, unknown>, maxTokens = 5, tracks: unknown[] = []) => ({
    op: 'reader-page', tracks,
    request: { method: 'reader-page/1', doc, cursor, maxTokens },
  });
  const pageOf = (h: Harness) => {
    const res = h.last('result');
    if (res.data.op !== 'reader-page') throw new Error('expected reader-page');
    return res.data.page;
  };

  it('ZERO-track paging tiles the document with exact cursors (no gap, no client arithmetic)', async () => {
    const h = harness();
    const text = 'one two three. four five six. seven eight nine ten eleven twelve.';
    const spec = await docSpec('a', text);
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', text, 10);
    const snap = h.last('snapshot-published').snapshot;
    await h.send({ t: 'query', job: 20, snapshot: snap, query: rp('a', { kind: 'from', token: 0 }) });
    const p1 = pageOf(h);
    expect(p1.method).toBe('reader-page/1');
    expect(p1.tokens.start).toBe(0);
    expect(p1.atStart).toBe(true);
    expect(p1.marks).toEqual([]);
    // Next page starts EXACTLY where this one ended.
    await h.send({ t: 'query', job: 21, snapshot: snap, query: rp('a', p1.next! as unknown as Record<string, unknown>) });
    const p2 = pageOf(h);
    expect(p2.tokens.start).toBe(p1.tokens.end); // tiling, no gap
    // And previous from p2 ends exactly at p2's start.
    await h.send({ t: 'query', job: 22, snapshot: snap, query: rp('a', p2.previous! as unknown as Record<string, unknown>) });
    expect(pageOf(h).tokens.end).toBe(p2.tokens.start);
  });

  it('marks are sliced from the SHARED cached occurrences, mapped to seriesIds, and reuse the cache', async () => {
    const h = harness();
    const textA = 'the wolf ran far. a wolf slept.';
    const textB = 'another wolf watched.';
    const [a, b] = await Promise.all([docSpec('a', textA), docSpec('b', textB)]);
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', textA, 10);
    await coldIngest(h, 'g', 'b', textB, 11);
    const snap = h.last('snapshot-published').snapshot;
    const occSpy = () => vi.mocked(occurrences);
    occSpy().mockClear();
    await h.send({ t: 'query', job: 30, snapshot: snap, query: { op: 'trend', selection: { docs: ['b', 'a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } } });
    expect(occSpy()).toHaveBeenCalledTimes(1);
    await h.send({ t: 'query', job: 31, snapshot: snap, query: rp('a', { kind: 'around', token: 1 }, 400, [{ seriesId: 's-wolf', group: wolfGroup }]) });
    expect(occSpy()).toHaveBeenCalledTimes(1); // engine-built base selection hashes identically
    const page = pageOf(h);
    expect(page.marks.map((m) => m.seriesId)).toEqual(['s-wolf', 's-wolf']);
    expect(page.marks.map((m) => m.groupId)).toEqual(['g1', 'g1']);
    expect(page.marks[0]!.tokens).toEqual({ start: 1, end: 2 });
    // The mark's char span slices the served text to the surface.
    const m = page.marks[0]!;
    expect(page.text.slice(m.charsUtf16.start, m.charsUtf16.end).toLowerCase()).toBe('wolf');
  });

  it('a wire-invalid cursor (before token 0) is PARSE_FAILED; an out-of-range cursor is REQUEST_INVALID from the kernel', async () => {
    const h = harness();
    const spec = await docSpec('a', 'just five tokens in here');
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', 'just five tokens in here', 10);
    const snap = h.last('snapshot-published').snapshot;
    await h.send({ t: 'query', job: 40, snapshot: snap, query: rp('a', { kind: 'before', token: 0 }) });
    expect(h.last('error').code).toBe('PARSE_FAILED'); // before(0) has no page
    await h.send({ t: 'query', job: 41, snapshot: snap, query: rp('a', { kind: 'from', token: 999 }) });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
  });
});

describe('reader-page/1 — engine-owned base selection and phase-tied cancellation (review-G)', () => {
  const rq = (tracks: unknown[] = [{ seriesId: 's-wolf', group: wolfGroup }]) => ({
    op: 'reader-page', tracks,
    request: { method: 'reader-page/1', doc: 'a', cursor: { kind: 'from', token: 0 }, maxTokens: 5 },
  });

  async function twoDocWorld() {
    const h = harness();
    const a = await docSpec('a', 'the wolf ran far ahead');
    const b = await docSpec('b', 'the wolf slept');
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far ahead', 10);
    await coldIngest(h, 'g', 'b', 'the wolf slept', 11);
    return { h, snap: h.last('snapshot-published').snapshot };
  }

  it('rejects a stray legacy selection key rather than silently ignoring narrowing intent', async () => {
    const { h, snap } = await twoDocWorld();
    await h.send({
      t: 'query',
      job: 60,
      snapshot: snap,
      query: { ...rq(), selection: { docs: [] } } as never,
    });
    expect(h.last('error').code).toBe('PARSE_FAILED');
    expect(h.all('result')).toHaveLength(0);
  });

  it('a cancel raised at the PER-TRACK checkpoint stops before planning; one at the FINAL checkpoint stops before emission', async () => {
    for (const cancelAtYield of [3, 5]) {
      const { h, snap } = await twoDocWorld();
      h.clear();
      let yields = 0;
      h.onYield(async () => {
        yields++;
        if (yields === cancelAtYield) await h.send({ t: 'cancel', job: 70 });
      });
      await h.send({ t: 'query', job: 70, snapshot: snap, query: rq() });
      expect(yields, `cancel@${cancelAtYield}`).toBeGreaterThanOrEqual(cancelAtYield);
      expect(h.all('cancelled').some((m) => m.job === 70), `cancel@${cancelAtYield}`).toBe(true);
      expect(h.all('result').some((m) => m.job === 70), `cancel@${cancelAtYield}`).toBe(false);
      expect(h.all('error').some((m) => m.job === 70), `cancel@${cancelAtYield}`).toBe(false);
      h.onYield(null);
    }
  });
});
