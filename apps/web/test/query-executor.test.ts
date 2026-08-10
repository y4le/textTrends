/**
 * Query SEMANTICS — trend/kwic/passage execution, resolver reuse, and the
 * shared occurrence-cache discipline, moved from engine-v4.test.ts with the
 * QueryExecutor extraction (slice-2 ruling §B). Driven through the same
 * engine harness (the executor is generation-bound and engine-fed), so these
 * results are byte-for-byte the pre-extraction expectations. Dispatch, final
 * gates, error mapping, cancellation bookkeeping, and transfer emission stay
 * in engine-v4.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_OCCURRENCE_CACHE_ENTRIES,
  MAX_OCCURRENCE_CACHE_BYTES,
  QueryExecutor,
  type PublishedView,
} from '../src/worker/query-executor.ts';
import { CapError, DISPERSION_BUCKET_BUDGET, DISPERSION_EXACT_MAX } from '@texttrends/core';
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
async function freshTxtSpec(doc: string, byteLength: number): Promise<GenerationDocSpecV4> {
  const { txt } = await defaultExtractionRecipes();
  return {
    doc, language: 'en',
    source: { byteLength, format: 'txt' },
    extraction: { recipe: txt, recipeHash: await hashExtractionRecipe(txt) },
  };
}

describe('query semantics (trend/kwic/passage via the generation-bound executor)', () => {
  async function ready(text = 'the wolf ran far. a wolf slept.') {
    const h = harness();
    const spec = await docSpec('a', text);
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', text, 10);
    return { h, snap: h.last('snapshot-published').snapshot };
  }

  it('answers trend and KWIC against the published snapshot', async () => {
    const { h, snap } = await ready();
    await h.send({ t: 'query', job: 20, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } } });
    const trend = h.last('result');
    expect(trend.data.op).toBe('trend');
    if (trend.data.op === 'trend') expect(Array.from(trend.data.trend.count)).toEqual([1, 0, 1, 0]);
    await h.send({ t: 'query', job: 21, snapshot: snap, query: { op: 'kwic', selection: { docs: ['a'] }, tracks: [{ seriesId: 's', group: wolfGroup }], request: { contextTokens: 1, sort: [{ at: 'pos', dir: 1 }], page: { offset: 0, limit: 10 } } } });
    const kwic = h.last('result');
    expect(kwic.data.op).toBe('kwic');
    if (kwic.data.op === 'kwic') {
      expect(kwic.data.total).toBe(2);
      expect(kwic.data.rows[0]!.nodeText).toBe('wolf');
      expect(kwic.data.rows[0]!.seriesId).toBe('s'); // rows are track-tagged
    }
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

  it('kwic/2 merges two tracks and orders by proximity to an axis center', async () => {
    const { h, snap } = await ready();
    // The default corpus doc 'a' is 'the wolf runs and the wolf sleeps' (wolf@1, wolf@5).
    // Two tracks over the same term produce two independently-tagged rows per hit;
    // a center near the end orders the later hit first.
    await h.send({ t: 'query', job: 22, snapshot: snap, query: { op: 'kwic', selection: { docs: ['a'] }, tracks: [{ seriesId: 'A', group: wolfGroup }, { seriesId: 'B', group: { ...wolfGroup, id: 'gB' } }], request: { contextTokens: 1, center: { doc: 'a', token: 5 }, sort: [{ at: 'pos', dir: 1 }], page: { offset: 0, limit: 10 } } } });
    const kwic = h.last('result');
    expect(kwic.data.op).toBe('kwic');
    if (kwic.data.op === 'kwic') {
      expect(kwic.data.total).toBe(4); // 2 hits × 2 tracks
      // Nearest to token 5 first (pos 5 before pos 1); both tracks tagged.
      expect(kwic.data.rows.map((r) => [r.pos, r.seriesId])).toEqual([[5, 'A'], [5, 'B'], [1, 'A'], [1, 'B']]);
    }
  });

  // The kwic/2 dispatch adds checkpoints the trend cancellation tests never
  // reach. These tests tie the cancel to the actual PHASE (not a fragile yield
  // ordinal) so deleting the per-track gate or moving the final gate before
  // materialization makes them fail.
  const twoTrackKwic = {
    op: 'kwic' as const,
    selection: { docs: ['a'] },
    tracks: [{ seriesId: 'A', group: wolfGroup }, { seriesId: 'B', group: { ...wolfGroup, id: 'gB' } }],
    request: { contextTokens: 1, sort: [{ at: 'pos' as const, dir: 1 as const }], page: { offset: 0, limit: 10 } },
  };

  it('the per-track gate stops BEFORE the next track computes (a cancel raised DURING track A)', async () => {
    const { h, snap } = await ready();
    h.clear();
    // Track A resolves a UNIQUE surface absent from the corpus; track B passes
    // the wire schema (narrowGroup does not check member-id uniqueness) but
    // THROWS inside `occurrences`. The cancel is raised from inside track A's own
    // `resolveToken` fold (String.toLocaleLowerCase on that unique surface — a
    // call the resolver-prep vocab folding never makes). So the gate that must
    // catch it is the one AFTER track A: move it before the loop (or delete it)
    // and track B computes and throws instead of cancelling cleanly.
    const MARKER = 'zzsentinelalpha';
    const trackA = { seriesId: 'A', group: { id: 'gA', countOverlaps: false, members: [{ id: 'a', kind: 'token', surface: MARKER, match: { case: 'folded', diacritics: 'sensitive' } }] } };
    const throwingB = { seriesId: 'B', group: { id: 'gThrow', countOverlaps: false, members: [
      { id: 'p', kind: 'token', surface: 'x', match: { case: 'folded', diacritics: 'sensitive' } },
      { id: 'p', kind: 'token', surface: 'y', match: { case: 'folded', diacritics: 'sensitive' } },
    ] } };
    const query = { op: 'kwic', selection: { docs: ['a'] }, tracks: [trackA, throwingB], request: { contextTokens: 1, sort: [{ at: 'pos', dir: 1 }], page: { offset: 0, limit: 10 } } };
    const origLower = String.prototype.toLocaleLowerCase;
    let firedDuringA = false;
    String.prototype.toLocaleLowerCase = function (this: string, ...args: [(string | string[])?]) {
      if (!firedDuringA && String(this) === MARKER) { firedDuringA = true; void h.send({ t: 'cancel', job: 52 }); }
      return origLower.apply(this, args) as string;
    } as typeof String.prototype.toLocaleLowerCase;
    try {
      await h.send({ t: 'query', job: 52, snapshot: snap, query });
    } finally {
      String.prototype.toLocaleLowerCase = origLower;
    }
    expect(firedDuringA).toBe(true); // track A's surface was resolved (A computed) before the cancel
    expect(h.all('cancelled').some((m) => m.job === 52)).toBe(true);
    expect(h.all('result').some((m) => m.job === 52)).toBe(false);
    expect(h.all('error').some((m) => m.job === 52)).toBe(false); // track B never computed → never threw
  });

  it('the FINAL gate catches a cancel raised DURING materialization', async () => {
    const { h, snap } = await ready(); // doc 'a' text contains 'the wolf ran far'
    h.clear();
    // Fire the cancel the first time the doc text is sliced — i.e. INSIDE
    // materializeKwicPage, after numeric planning + its checkpoint. Only a gate
    // AFTER materialization can catch it; a gate moved before it would already
    // have passed and the result would emit.
    const origSlice = String.prototype.slice;
    let sliced = false;
    String.prototype.slice = function (this: string, ...args: [number?, number?]) {
      if (!sliced && this.includes('the wolf ran far')) { sliced = true; void h.send({ t: 'cancel', job: 51 }); }
      return origSlice.apply(this, args) as string;
    } as typeof String.prototype.slice;
    try {
      await h.send({ t: 'query', job: 51, snapshot: snap, query: twoTrackKwic });
    } finally {
      String.prototype.slice = origSlice;
    }
    expect(sliced).toBe(true); // materialization was actually reached (not vacuous)
    expect(h.all('cancelled').some((m) => m.job === 51)).toBe(true);
    expect(h.all('result').some((m) => m.job === 51)).toBe(false);
  });

  it('re-querying with a REUSED group.id but different members returns FRESH rows (cache keys on matching identity)', async () => {
    // group.id is caller-owned provenance. A memo keyed on it would serve the
    // first query's occurrences for the second — the exact stale-row bug.
    const { h, snap } = await ready(); // 'the wolf ran far. a wolf slept.'
    const occSpy = vi.mocked(occurrences);
    occSpy.mockClear();
    const kwic = (surface: string, job: number) => h.send({
      t: 'query', job, snapshot: snap, query: {
        op: 'kwic', selection: { docs: ['a'] },
        // SAME group.id 'REUSED' both times; only the member surface changes.
        tracks: [{ seriesId: 's', group: { id: 'REUSED', countOverlaps: false, members: [{ id: 'm', kind: 'token', surface, match: FOLD }] } }],
        request: { contextTokens: 1, sort: [{ at: 'pos', dir: 1 }], page: { offset: 0, limit: 10 } },
      },
    });
    await kwic('wolf', 60);
    const first = h.last('result');
    expect(first.data.op === 'kwic' && first.data.rows.map((r) => r.nodeText)).toEqual(['wolf', 'wolf']);
    await kwic('ran', 61);
    const second = h.last('result');
    expect(second.data.op === 'kwic' && second.data.rows.map((r) => r.nodeText)).toEqual(['ran']);
    // Both queries were cache MISSES: the differing member surface changes the
    // matching identity, so the reused id never aliases an occurrence entry.
    expect(occSpy).toHaveBeenCalledTimes(2);
  });

  it('bounds the occurrence cache at MAX_OCCURRENCE_CACHE_ENTRIES under overlapping, interleaving trend AND kwic jobs', async () => {
    const { h, snap } = await ready('the wolf ran far. a wolf slept. i saw the fox and the owl.');
    const cache = () => (h.engine as unknown as { generation: { executor: { occurrenceCache: Map<string, unknown> } } | null }).generation!.executor.occurrenceCache;
    const group = (surface: string, i: number) => ({ id: `g${i}`, countOverlaps: false, members: [{ id: 'm', kind: 'token' as const, surface, match: FOLD }] });
    const kwicQuery = (surfaces: string[]) => ({
      op: 'kwic' as const, selection: { docs: ['a'] },
      tracks: surfaces.map((surface, i) => ({ seriesId: `s${i}`, group: group(surface, i) })),
      request: { contextTokens: 1, sort: [{ at: 'pos' as const, dir: 1 as const }], page: { offset: 0, limit: 10 } },
    });
    const trendQuery = (surface: string) => ({
      op: 'trend' as const, selection: { docs: ['a'] }, group: group(surface, 9),
      request: { coordinate: 'document-relative' as const, bins: { mode: 'per-doc', count: 4 } },
    });
    // Two DISTINCT 4-track KWIC jobs plus two distinct trend jobs (10 unique
    // identities > MAX_OCCURRENCE_CACHE_ENTRIES=5) — BOTH consumers write the
    // shared cache. In manual yield mode each checkpoint parks; releasing them
    // round-robin interleaves all four jobs so a prune outside occurrencesFor
    // would let the map grow past the cap. Drive them to completion and assert
    // the hard bound held throughout AND that every job's local results stayed
    // correct despite its own entries being evicted mid-flight.
    h.manual();
    const pA = h.send({ t: 'query', job: 80, snapshot: snap, query: kwicQuery(['the', 'wolf', 'ran', 'far']) });
    const pB = h.send({ t: 'query', job: 81, snapshot: snap, query: kwicQuery(['a', 'i', 'saw', 'fox']) });
    const pC = h.send({ t: 'query', job: 82, snapshot: snap, query: trendQuery('owl') });
    const pD = h.send({ t: 'query', job: 83, snapshot: snap, query: trendQuery('slept') });
    const jobs = [80, 81, 82, 83];
    let guard = 0;
    while (guard++ < 400) {
      expect(cache().size).toBeLessThanOrEqual(MAX_OCCURRENCE_CACHE_ENTRIES);
      h.releaseYield();
      // eslint-disable-next-line no-await-in-loop
      await h.flush();
      const done = h.all('result').filter((m) => jobs.includes(m.job)).length;
      if (done >= 4) break;
    }
    await Promise.all([pA, pB, pC, pD]);
    expect(cache().size).toBeLessThanOrEqual(MAX_OCCURRENCE_CACHE_ENTRIES);
    // In-flight local results survived eviction: each job holds its own
    // occurrence references, so evicted cache entries never corrupt output.
    const result = (job: number) => h.all('result').find((m) => m.job === job)!;
    const kwicA = result(80).data;
    expect(kwicA.op === 'kwic' && kwicA.total).toBe(7); // the×3 + wolf×2 + ran + far
    const kwicB = result(81).data;
    expect(kwicB.op === 'kwic' && kwicB.total).toBe(4); // a + i + saw + fox
    const trendC = result(82).data;
    expect(trendC.op === 'trend' && Array.from(trendC.trend.count).reduce((s, n) => s + n, 0)).toBe(1); // owl
    const trendD = result(83).data;
    expect(trendD.op === 'trend' && Array.from(trendD.trend.count).reduce((s, n) => s + n, 0)).toBe(1); // slept
  });

  // Phase E: the trend and kwic branches share ONE generation-owned occurrence
  // cache. The pass-through `occurrences` spy counts exactly how many times the
  // engine pays for a full per-doc match.
  describe('trend/kwic occurrence-cache sharing (Phase E)', () => {
    const trendQ = { op: 'trend' as const, selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative' as const, bins: { mode: 'per-doc', count: 4 } } };
    const kwicQ = {
      op: 'kwic' as const, selection: { docs: ['a'] }, tracks: [{ seriesId: 's', group: wolfGroup }],
      request: { contextTokens: 1, sort: [{ at: 'pos' as const, dir: 1 as const }], page: { offset: 0, limit: 10 } },
    };
    const occSpy = () => vi.mocked(occurrences);
    const cacheOf = (h: Harness) => (h.engine as unknown as { generation: { executor: { occurrenceCache: Map<string, unknown> } } | null }).generation!.executor.occurrenceCache;

    it('the identical (snapshot, selection, identity) tuple computes occurrences EXACTLY once — trend-then-kwic AND kwic-then-trend', async () => {
      // trend first: kwic consumes the entry trend wrote.
      const a = await ready();
      occSpy().mockClear();
      await a.h.send({ t: 'query', job: 70, snapshot: a.snap, query: trendQ });
      await a.h.send({ t: 'query', job: 71, snapshot: a.snap, query: kwicQ });
      expect(occSpy()).toHaveBeenCalledTimes(1);
      // kwic first: trend consumes the entry kwic wrote.
      const b = await ready();
      occSpy().mockClear();
      await b.h.send({ t: 'query', job: 72, snapshot: b.snap, query: kwicQ });
      await b.h.send({ t: 'query', job: 73, snapshot: b.snap, query: trendQ });
      expect(occSpy()).toHaveBeenCalledTimes(1);
      expect([...a.h.all('error'), ...b.h.all('error')]).toEqual([]);
    });

    it('cache hits are result-equivalent for BOTH consumers (trend rows and kwic pages equal a no-cache reference)', async () => {
      // Harness A computes trend fresh (its kwic is the hit); harness B
      // computes kwic fresh (its trend is the hit). Cross-comparing proves a
      // hit-served result equals a freshly computed one for each consumer.
      const a = await ready();
      await a.h.send({ t: 'query', job: 70, snapshot: a.snap, query: trendQ });
      await a.h.send({ t: 'query', job: 71, snapshot: a.snap, query: kwicQ });
      const b = await ready();
      await b.h.send({ t: 'query', job: 72, snapshot: b.snap, query: kwicQ });
      await b.h.send({ t: 'query', job: 73, snapshot: b.snap, query: trendQ });
      const dataOf = (h: Harness, job: number) => h.all('result').find((m) => m.job === job)!.data;
      const tFresh = dataOf(a.h, 70);
      const tHit = dataOf(b.h, 73);
      expect(tFresh.op).toBe('trend');
      expect(tHit.op).toBe('trend');
      if (tFresh.op === 'trend' && tHit.op === 'trend') {
        expect(Array.from(tHit.trend.docOrdinal)).toEqual(Array.from(tFresh.trend.docOrdinal));
        expect(Array.from(tHit.trend.binIndex)).toEqual(Array.from(tFresh.trend.binIndex));
        expect(Array.from(tHit.trend.binStartToken)).toEqual(Array.from(tFresh.trend.binStartToken));
        expect(Array.from(tHit.trend.binTokens)).toEqual(Array.from(tFresh.trend.binTokens));
        expect(Array.from(tHit.trend.count)).toEqual(Array.from(tFresh.trend.count));
        expect(Array.from(tHit.trend.ratePer10k)).toEqual(Array.from(tFresh.trend.ratePer10k));
      }
      const kFresh = dataOf(b.h, 72);
      const kHit = dataOf(a.h, 71);
      expect(kFresh.op).toBe('kwic');
      expect(kHit.op).toBe('kwic');
      if (kFresh.op === 'kwic' && kHit.op === 'kwic') {
        expect(kHit.total).toBe(kFresh.total);
        expect(kHit.rows).toEqual(kFresh.rows);
      }
    });

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

  it('only permits occurrence-cache policies that reduce the hard bounds', () => {
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
    growthPoints: 16,
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
  it('freq-list/1 shares the Slice-3 document vector with inventory', async () => {
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
          growthPoints: 0,
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
          method: 'freq-list/1',
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
    expect(ab.data.keyness.totalsA).toEqual({ tokens: 4, documents: 1 });
    expect(ab.data.keyness.totalsB).toEqual({ tokens: 4, documents: 1 });
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

  it('SHARES the occurrence cache with trend/kwic — a dispersion after trend recomputes nothing', async () => {
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
    track: { seriesId: 's-wolf', group: wolfGroup },
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
    const edge = h.last('result');
    if (edge.data.op !== 'occurrence-step') throw new Error('expected occurrence-step');
    expect(edge.data.step).toEqual({ method: 'occurrence-step/1', hit: null, atEdge: true });
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
      track: { seriesId: 'overlap-series', group: overlapGroup },
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
