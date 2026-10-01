/** runtime queries behavior through the live application runtime. */

import { describe, expect, it } from 'vitest';

import { emptyLibraryWorkspace, workspaceFromApp, workspaceSemanticKey } from '../src/lib/workspace-state.ts';

import type { QueryResultDataV4 } from '../src/worker/protocol-v4.ts';

import { SHERLOCK } from '../src/lib/project.ts';
import { WorkerClientError } from '../src/lib/client.ts';

import { TERM_GROUP_LIMITS_V1 } from '@texttrends/core';
import { workspaceState } from './support/workspace-fixtures.ts';

import { groupTitle } from '../src/lib/notebook.ts';

import { LIBRARY_PROJECT, snap, sessionState, fakeTrend, fakeMatches, fakeInventoryResult, harness, restoreFixture, flush } from './support/runtime-harness.ts';

describe('typed query delivery', () => {
  it('surfaces mismatches through each controller instead of leaving pending views', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 0, from: 'kwic', anchor: 'occurrence' });
    for (const op of ['trend', 'keyness', 'freq-list', 'reader-page']) {
      const request = f.issued.findLast((entry) => entry.op === op)!;
      expect(request, op).toBeDefined();
      request.resolve({ op: 'dispersion' } as QueryResultDataV4);
    }
    await flush();
    const state = f.store.getState();
    for (const view of [state.trends.get('u1'), state.keynessB?.state, state.frequency?.state, state.readerPage?.state]) {
      expect(view).toMatchObject({ status: 'error', message: expect.stringContaining('response mismatch') });
    }
    f.runtime.dispose();
  });

  it('silently drops a mismatched response after its lease is superseded', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    const old = f.trends().at(-1)!;
    f.store.getState().runQueries();
    old.resolve({ op: 'dispersion' } as QueryResultDataV4);
    await flush();
    expect(f.store.getState().trends.get('u1')).toEqual({ status: 'pending' });
    f.runtime.dispose();
  });
});

describe('Trends burst intent guards', () => {
  it('rejects baseline and selected results when their captured bin geometry is no longer current', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    const baseline = f.trends().at(-1)!;
    f.store.getState().setLinkedSelection({ snapshot: 's1', ranges: [{ doc: 'a', tokens: { start: 1, end: 8 } }] });
    const selected = f.trends().at(-1)!;
    // Exercise the captured-intent fence independently of transport cancellation.
    f.store.setState({ trendBins: { mode: 'fixed-tokens', count: 250 } });
    baseline.resolve({ op: 'trend', trend: fakeTrend(9) });
    selected.resolve({ op: 'trend', trend: fakeTrend(3) });
    await flush();
    expect(f.store.getState().trends.get('u1')).toEqual({ status: 'pending' });
    expect(f.store.getState().selectedTrends.get('u1')).toEqual({ status: 'pending' });
    expect(f.store.getState().corpusTokenCounts.size).toBe(0);
    f.runtime.dispose();
  });
});

describe('store query intent discipline', () => {
  it.each(['success', 'error', 'cancelled'] as const)(
    'releases a %s query while retaining cancellation for pending peers', async (outcome) => {
      const f = harness();
      f.port.publishSnapshot('g1', 's1');
      f.store.getState().mergeStarterTerms('holmes, moriarty');
      const [settled, pending] = f.trends();
      if (outcome === 'success') settled!.resolve({ op: 'trend', trend: fakeTrend(3) });
      else settled!.reject(outcome === 'cancelled'
        ? new WorkerClientError('CANCELLED', 'cancelled')
        : new Error('failed'));
      await flush();

      f.store.getState().runQueries();
      expect(settled!.cancelled).toBe(false);
      expect(pending!.cancelled).toBe(true);
      const fresh = f.trends().slice(2);
      f.runtime.dispose();
      expect(settled!.cancelled).toBe(false);
      expect(fresh.every((query) => query.cancelled)).toBe(true);
    },
  );

  it('releases a completed query before a subscriber refreshes the lane', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const [settled, pending] = f.trends();
    const id = f.store.getState().series[0]!.id;
    const unsubscribe = f.store.subscribe((state) => {
      if (state.trends.get(id)?.status === 'ready') {
        unsubscribe();
        state.runQueries();
      }
    });
    settled!.resolve({ op: 'trend', trend: fakeTrend(3) });
    await flush();
    expect(f.trends()).toHaveLength(4);
    expect(settled!.cancelled).toBe(false);
    expect(pending!.cancelled).toBe(true);
    unsubscribe();
    f.runtime.dispose();
  });

  it('issued group/member ids stay wire-bounded for the LONGEST legal label (ids derive from slots, not labels)', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    const longest = 'x'.repeat(TERM_GROUP_LIMITS_V1.maxSurfaceUnits);
    f.store.getState().mergeStarterTerms(longest);
    const q = f.trends().filter((t) => !t.cancelled).at(-1)!;
    expect(q.term).toBe(longest); // the label IS the surface, at full length
    expect(q.groupId.length).toBeLessThanOrEqual(TERM_GROUP_LIMITS_V1.maxIdUnits);
    expect(q.memberId.length).toBeGreaterThan(0);
    expect(q.memberId.length).toBeLessThanOrEqual(TERM_GROUP_LIMITS_V1.maxIdUnits);
  });

  it('issues one trend per series plus one MERGED KWIC over all enabled terms', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const live = f.trends().filter((q) => !q.cancelled);
    expect(live.map((q) => q.term)).toEqual(['holmes', 'moriarty']);
    expect(new Set(live.map((q) => q.groupId)).size).toBe(2);
    const liveKwic = f.kwics().filter((q) => !q.cancelled);
    expect(liveKwic.length).toBe(1); // ONE merged match set, not one per series
    expect((liveKwic[0]!.query as { tracks: { seriesId: string }[] }).tracks.map((t) => t.seriesId))
      .toEqual(f.store.getState().series.map((s) => s.id)); // all terms by default
  });

  it('cancels superseded queries and a stale term can never win', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('bear');
    // Replace the comparison: remove bear (supersedes) and add hound.
    f.store.getState().removeGroup(f.store.getState().series[0]!.id);
    f.store.getState().mergeStarterTerms('hound');
    const trendQueries = f.trends();
    for (const q of trendQueries.slice(0, -1)) expect(q.cancelled).toBe(true);
    const live = trendQueries.at(-1)!;
    expect(live.cancelled).toBe(false);
    expect(live.term).toBe('hound');

    live.resolve({ op: 'trend', trend: fakeTrend(7) });
    await flush();
    const stale = trendQueries.find((q) => q.term === 'bear')!;
    stale.resolve({ op: 'trend', trend: fakeTrend(99) }); // stale resolve after cancel
    await flush();
    const trends = f.store.getState().trends;
    expect(trends.size).toBe(1);
    const hound = trends.get(f.store.getState().series[0]!.id)!;
    expect(hound.status).toBe('ready');
    expect(hound.status === 'ready' && hound.trend.count[0]).toBe(7);
  });

  it('per-series results land independently; one failure does not erase peers', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const [q1, q2] = f.trends().filter((q) => !q.cancelled);
    q1!.resolve({ op: 'trend', trend: fakeTrend(3) });
    await flush();
    const [holmes, moriarty] = f.store.getState().series;
    expect(f.store.getState().trends.get(holmes!.id)!.status).toBe('ready');
    expect(f.store.getState().trends.get(moriarty!.id)!.status).toBe('pending');
    q2!.reject(new Error('CAP_EXCEEDED: too much'));
    await flush();
    const after = f.store.getState().trends;
    expect(after.get(holmes!.id)!.status).toBe('ready'); // peer survives
    const failed = after.get(moriarty!.id)!;
    expect(failed.status).toBe('error');
    expect(failed.status === 'error' && failed.message).toContain('CAP_EXCEEDED');

    f.store.getState().mergeStarterTerms('watson');
    const q3 = f.trends().filter((query) => !query.cancelled).find((query) => query.term === 'watson');
    q3!.reject(new WorkerClientError('WORKER_ERROR', 'CAP_EXCEEDED: too much', 'CAP_EXCEEDED'));
    await flush();
    const watson = f.store.getState().series.find((entry) => entry.label === 'watson')!;
    const friendly = f.store.getState().trends.get(watson.id);
    expect(friendly?.status === 'error' && friendly.message)
      .toBe('Too many occurrences to analyse at once — narrow the selected range or corpus.');
  });

  it('cancellation is discriminated by the TYPED code, never by message text', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const [q1, q2] = f.trends().filter((q) => !q.cancelled);
    // A typed CANCELLED rejection is deliberate noise — no error state.
    q1!.reject(new WorkerClientError('CANCELLED', 'cancelled'));
    await flush();
    const [holmes, moriarty] = f.store.getState().series;
    expect(f.store.getState().trends.get(holmes!.id)!.status).toBe('pending');
    // A plain Error whose message merely READS 'cancelled' is a real failure
    // (the accidental-collision the typed code exists to prevent).
    q2!.reject(new Error('cancelled'));
    await flush();
    const collided = f.store.getState().trends.get(moriarty!.id)!;
    expect(collided.status).toBe('error');
  });

  it('global activation reissues Matches with exactly the effective series', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const [holmes, moriarty] = f.store.getState().series;
    const tracksOf = () => (f.kwics().filter((q) => !q.cancelled).at(-1)!.query as { tracks: { seriesId: string }[] }).tracks.map((t) => t.seriesId);
    f.store.getState().setGroupActive(moriarty!.id, false);
    expect(f.store.getState().activeGroupIds.has(moriarty!.id)).toBe(false);
    expect(f.store.getState().series.map((series) => series.id)).toEqual([holmes!.id]);
    expect(tracksOf()).toEqual([holmes!.id]);
    f.store.getState().setGroupActive(moriarty!.id, true);
    expect(f.store.getState().series.map((series) => series.id)).toEqual([holmes!.id, moriarty!.id]);
    expect(tracksOf()).toEqual([holmes!.id, moriarty!.id]);
  });

  it('deactivating every term clears the effective comparison and Matches without an empty request', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const before = f.kwics().length; // the initial merged query
    for (const group of f.store.getState().notebook.groups) {
      f.store.getState().setGroupActive(group.id, false);
    }
    expect(f.store.getState().activeGroupIds.size).toBe(0);
    expect(f.store.getState().series).toEqual([]);
    expect(f.store.getState().kwic).toBeNull();
    expect(f.kwics().length).toBe(before + 1); // only the first deactivation queried; the empty comparison did not
  });

  it('global activation survives append-only additions and new groups join effective Matches', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const moriarty = f.store.getState().series[1]!;
    f.store.getState().setGroupActive(moriarty.id, false);
    f.store.getState().mergeStarterTerms('holmes, watson, moriarty'); // add watson, keep the others
    const groups = f.store.getState().notebook.groups;
    const id = (label: string) => groups.find((group) => groupTitle(group) === label)!.id;
    expect(f.store.getState().activeGroupIds.has(id('holmes'))).toBe(true);
    expect(f.store.getState().activeGroupIds.has(id('moriarty'))).toBe(false);
    expect(f.store.getState().activeGroupIds.has(id('watson'))).toBe(true);
    expect(f.store.getState().series.map((series) => series.id))
      .toEqual([id('holmes'), id('watson')]);
    const query = f.kwics().filter((q) => !q.cancelled).at(-1)!.query as { tracks: { seriesId: string }[] };
    expect(query.tracks.map((track) => track.seriesId)).toEqual([id('holmes'), id('watson')]);
  });

  it('raw scrub publishes only the cursor; the mounted surface explicitly requests its window', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const prior = f.kwics().filter((query) => !query.cancelled).at(-1)!;
    const count = f.kwics().length;
    f.store.getState().setScrub({ doc: 'a', token: 100 });
    f.store.getState().setScrub({ doc: 'a', token: 250 });
    expect(prior.cancelled).toBe(false);
    expect(f.kwics()).toHaveLength(count);

    f.store.getState().requestMatchesWindow({ kind: 'position', doc: 'a', token: 250 });
    expect(prior.cancelled).toBe(true);
    expect(f.kwics()).toHaveLength(count + 1);
    expect((f.kwics().at(-1)!.query as { request: { anchor: unknown } }).request.anchor)
      .toEqual({ kind: 'position', doc: 'a', token: 250 });

  });

  it('clearing terms retains the reading axis until a snapshot-null transition', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().setScrub({ doc: 'a', token: 100 });
    f.store.getState().removeGroup(f.store.getState().series[0]!.id);
    expect(f.store.getState().kwic).toBeNull();
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 100 });
    f.store.getState().mergeStarterTerms('holmes');
    expect((f.kwics().filter((query) => !query.cancelled).at(-1)!.query as { request: { anchor: unknown } }).request.anchor)
      .toEqual({ kind: 'position', doc: 'a', token: 100 });
    f.port.emit(sessionState(null));
    expect(f.store.getState().kwic).toBeNull();
    expect(f.store.getState().scrub).toBeNull();
  });

  it('scrubbing with no active terms leaves Matches absent and issues no window', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    for (const group of f.store.getState().notebook.groups) {
      f.store.getState().setGroupActive(group.id, false);
    }
    expect(f.store.getState().kwic).toBeNull();
    const count = f.kwics().length;
    f.store.getState().setScrub({ doc: 'a', token: 50 });
    expect(f.kwics()).toHaveLength(count);
    expect(f.store.getState().kwic).toBeNull();
  });

  it('a late KWIC result from a superseded intent cannot land', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const oldKwic = f.kwics().filter((q) => !q.cancelled).at(-1)!;
    f.store.getState().setGroupActive(f.store.getState().series[1]!.id, false); // reissues, supersedes oldKwic
    oldKwic.resolve(fakeMatches(9)); // raced past cancel
    await flush();
    expect(f.store.getState().kwic!.state.status).toBe('pending'); // the stale result did not land
  });

  it('view toggle is presentation-only: no query is issued', () => {
    const project = (order: readonly string[]) => ({
      data: { ...LIBRARY_PROJECT.data, order },
    });
    const f = harness(sessionState(snap('g1', 's1', ['a', 'b']), {
      project: project(['a', 'b']),
    }));
    const count = f.issued.length;
    expect(f.store.getState().trendView).toBe('by-book');
    f.store.getState().setTrendView('series');
    expect(f.store.getState().trendView).toBe('series');
    expect(f.issued.length).toBe(count);
    f.store.getState().setTrendView('by-book-scaled');
    expect(f.store.getState().trendView).toBe('by-book-scaled');
    expect(workspaceFromApp(f.store.getState())?.views.trend.mode).toBe('by-book-scaled');
    expect(f.issued.length).toBe(count);

    f.port.emit(sessionState(snap('g2', 's2', ['a']), {
      project: project(['a']),
    }));
    expect(f.store.getState().trendView).toBe('series');
    const afterCorpusChange = f.issued.length;
    f.store.getState().setTrendView('by-book');
    expect(f.store.getState().trendView).toBe('series');
    expect(f.issued.length).toBe(afterCorpusChange);

    f.port.emit(sessionState(snap('g3', 's3', ['a', 'b']), {
      project: project(['a', 'b']),
    }));
    expect(f.store.getState().trendView).toBe('by-book');

    f.port.emit(sessionState(snap('g4', 's4', ['a']), {
      project: project(['a']),
    }));

    const restored = workspaceState({
      corpus: {
        kind: 'library',
        order: ['a'],
        docs: [{
          doc: 'a',
          library: `txt:${'a'.repeat(64)}`,
          meta: { title: 'A', language: 'en', tags: [] },
        }],
      },
    });
    restoreFixture(f, {
      ...restored,
      views: {
        ...restored.views,
        trend: { ...restored.views.trend, mode: 'by-book' },
      },
    });
    expect(f.store.getState().trendView).toBe('series');

    f.runtime.dispose();
  });

  it('preserves a restored separate view while a multi-text import settles', () => {
    const project = (order: readonly string[]) => ({
      id: 'library',
      data: { ...LIBRARY_PROJECT.data, id: 'library', order },
    });
    const flow = harness(sessionState(null, { project: project([]) }));
    const empty = emptyLibraryWorkspace();
    restoreFixture(flow, {
      ...empty,
      views: {
        ...empty.views,
        trend: { ...empty.views.trend, mode: 'by-book' },
      },
    });
    expect(flow.store.getState().trendView).toBe('by-book');

    // Starting analysis publishes the still-empty library before the import
    // stages any source files; the restored preference must survive that gap.
    flow.port.emit(sessionState(null, { project: project([]) }));
    expect(flow.store.getState().trendView).toBe('by-book');

    flow.port.emit({
      ...sessionState(snap('g1', 's1', ['a']), { project: project(['a']) }),
      imports: [{
        doc: 'b',
        sourceName: 'b.txt',
        library: `txt:${'b'.repeat(64)}`,
        status: 'extracting',
        published: false,
      }],
    });
    expect(flow.store.getState().trendView).toBe('by-book');

    flow.port.emit(sessionState(snap('g2', 's2', ['a', 'b']), {
      project: project(['a', 'b']),
    }));
    expect(flow.store.getState().trendView).toBe('by-book');
    flow.runtime.dispose();
  });

  it('normalizes a restored separate view when an import fails with one active text', () => {
    const project = {
      id: 'library',
      data: { ...LIBRARY_PROJECT.data, id: 'library', order: ['a'] },
    };
    const flow = harness(sessionState(null, {
      project: { ...project, data: { ...project.data, order: [] } },
    }));
    const empty = emptyLibraryWorkspace();
    restoreFixture(flow, {
      ...empty,
      views: {
        ...empty.views,
        trend: { ...empty.views.trend, mode: 'by-book' },
      },
    });
    flow.port.emit({
      ...sessionState(snap('g1', 's1', ['a']), { project }),
      imports: [{
        doc: 'b',
        sourceName: 'b.txt',
        library: `txt:${'b'.repeat(64)}`,
        status: 'failed',
        published: false,
      }],
    });
    expect(flow.store.getState().trendView).toBe('series');
    flow.runtime.dispose();
  });

  it('keeps display settings resident-only and reissues only trend lanes for bin changes', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    const issued = f.issued.length;
    const trendCount = f.trends().length;
    const kwicCount = f.kwics().length;
    const dispersionCount = f.issued.filter((item) => item.op === 'dispersion').length;

    f.store.getState().applyTrendSettings({
      bins: { mode: 'per-doc', count: 40 },
      measure: {
        kind: 'rate',
        denominator: 10_000,
        smoothing: 5,
        showRaw: true,
      },
    });
    expect(f.issued).toHaveLength(issued);
    expect(f.store.getState().trendMeasure).toEqual({
      kind: 'rate',
      denominator: 10_000,
      smoothing: 5,
      showRaw: true,
    });

    f.store.getState().applyTrendSettings({
      bins: { mode: 'fixed-tokens', count: 250 },
      measure: { kind: 'count' },
    });
    expect(f.trends()).toHaveLength(trendCount + 1);
    expect(f.kwics()).toHaveLength(kwicCount);
    expect(f.issued.filter((item) => item.op === 'dispersion')).toHaveLength(dispersionCount);
    expect((f.trends().at(-1)!.query as {
      request: { bins: unknown };
    }).request.bins).toEqual({ mode: 'fixed-tokens', count: 250 });
    expect(f.store.getState().trendMeasure).toEqual({ kind: 'count' });
  });

  it('keeps an in-flight bin reissue current across a measure-only apply', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');

    expect(f.store.getState().applyTrendSettings({
      bins: { mode: 'fixed-tokens', count: 250 },
      measure: { kind: 'count' },
    })).toBe('applied');
    const inFlight = f.trends().at(-1)!;
    const issuedBins = f.store.getState().trendBins;
    expect(f.store.getState().trends.get('u1')?.status).toBe('pending');

    expect(f.store.getState().applyTrendSettings({
      bins: { mode: 'fixed-tokens', count: 250 },
      measure: {
        kind: 'rate',
        denominator: 10_000,
        smoothing: 5,
        showRaw: true,
      },
    })).toBe('applied');
    expect(f.store.getState().trendBins).toBe(issuedBins);
    f.store.setState({ trendBins: { ...issuedBins } });
    expect(f.store.getState().trendBins).not.toBe(issuedBins);

    inFlight.resolve({ op: 'trend', trend: fakeTrend(17) });
    await flush();
    expect(f.store.getState().trends.get('u1')).toMatchObject({
      status: 'ready',
      trend: { count: Uint32Array.from([17]) },
    });
  });

  it('rejects over-limit bin settings and clamps restored geometry from inventory alone', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.inventories().at(-1)!.resolve(fakeInventoryResult(2_000_000, [
      { doc: 'a', fullTokens: 1_000_000 },
      { doc: 'b', fullTokens: 1_000_000 },
    ]));
    await flush();

    const before = f.store.getState().trendBins;
    expect(f.store.getState().applyTrendSettings({
      bins: { mode: 'fixed-tokens', count: 250 },
      measure: { kind: 'count' },
    })).toBe('rejected');
    expect(f.store.getState().trendBins).toBe(before);

    const workspace = workspaceState();
    restoreFixture(f, {
      ...workspace,
      views: {
        ...workspace.views,
        trend: {
          ...workspace.views.trend,
          bins: { mode: 'fixed-tokens', count: 250 },
        },
      },
    });
    f.inventories().at(-1)!.resolve(fakeInventoryResult(2_000_000, [
      { doc: 'a', fullTokens: 1_000_000 }, { doc: 'b', fullTokens: 1_000_000 },
    ]));
    await flush();
    expect(f.store.getState().trendBins).toEqual({ mode: 'fixed-tokens', count: 500 });
  });

  it('normalizes a persisted bin preference when expanded-corpus extents arrive', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const workspace = workspaceState();
    restoreFixture(f, {
      ...workspace,
      views: {
        ...workspace.views,
        trend: {
          ...workspace.views.trend,
          bins: { mode: 'fixed-tokens', count: 250 },
        },
      },
    });
    expect(f.store.getState().trendBins).toEqual({ mode: 'fixed-tokens', count: 250 });

    f.inventories().at(-1)!.resolve(fakeInventoryResult(2_000_000, [
      { doc: 'a', fullTokens: 1_000_000 },
      { doc: 'b', fullTokens: 1_000_000 },
    ]));
    await flush();
    expect(f.store.getState().trendBins).toEqual({ mode: 'fixed-tokens', count: 500 });
    expect(f.store.getState().trendSettingsNotice).toMatch(/saved preference/);
  });

  it('retains corpus extents when a range inventory replaces the full inventory', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.inventories().at(-1)!.resolve(fakeInventoryResult(2_000_000, [
      { doc: 'a', fullTokens: 1_000_000 },
      { doc: 'b', fullTokens: 1_000_000 },
    ]));
    await flush();

    const selection = {
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 10, end: 20 } }],
    };
    f.store.getState().setLinkedSelection(selection);
    // The active range now also owns Compare. Resolve the visible inventory
    // directly instead of relying on the fixture's historical heuristic,
    // which classifies this same selection as Compare side A.
    f.issued.filter((issued) => issued.op === 'inventory'
      && JSON.stringify((issued.query as { selection?: unknown }).selection)
        === JSON.stringify({ docs: ['a'], ranges: selection.ranges }))
      .forEach((issued) => issued.resolve(fakeInventoryResult(10, [
      { doc: 'a', fullTokens: 1_000_000 },
      ])));
    await flush();
    f.store.setState({
      trends: new Map([['u1', { status: 'error', message: 'trend failed' }]]),
    });

    expect(f.store.getState().corpusTokenCounts).toEqual(new Map([
      ['a', 1_000_000],
      ['b', 1_000_000],
    ]));
    expect(f.store.getState().corpusInventory?.state).toMatchObject({
      status: 'ready',
      result: { selection: 'selection-2000000' },
    });
    expect(f.store.getState().inventory?.state).toMatchObject({
      status: 'ready',
      result: { selection: 'selection-10' },
    });
    expect(f.store.getState().applyTrendSettings({
      bins: { mode: 'fixed-tokens', count: 250 },
      measure: { kind: 'count' },
    })).toBe('rejected');
  });

  it('lets the full-text inventory land after a range supersedes the visible lane', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const baseline = f.inventories().at(-1)!;

    f.store.getState().setLinkedSelection({
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 10, end: 20 } }],
    });
    const ranged = f.inventories().at(-1)!;
    expect(baseline.cancelled).toBe(false);

    ranged.resolve(fakeInventoryResult(10, [{ doc: 'a', fullTokens: 1_000 }]));
    await flush();
    expect(f.store.getState().inventory?.state).toMatchObject({
      status: 'ready',
      result: { selection: 'selection-10' },
    });
    expect(f.store.getState().corpusInventory?.state.status).toBe('pending');

    baseline.resolve(fakeInventoryResult(2_000, [
      { doc: 'a', fullTokens: 1_000 },
      { doc: 'b', fullTokens: 1_000 },
    ]));
    await flush();
    expect(f.store.getState().corpusInventory?.state).toMatchObject({
      status: 'ready',
      result: { selection: 'selection-2000' },
    });
    expect(f.store.getState().inventory?.state).toMatchObject({
      status: 'ready',
      result: { selection: 'selection-10' },
    });

    f.store.getState().setLinkedSelection(null);
    expect(f.inventories().at(-1)).toBe(ranged);
    expect(f.store.getState().inventory).toBe(f.store.getState().corpusInventory);
  });

  it('switches to the viable bin mode when the persisted mode cannot fit', async () => {
    const f = harness();
    const docs = Array.from({ length: 1_001 }, (_, index) => `doc-${index}`);
    f.port.publishSnapshot('g1', 's1', docs);
    f.inventories().at(-1)!.resolve(fakeInventoryResult(1_001, docs.map((doc) => ({
      doc,
      fullTokens: 1,
    }))));
    await flush();

    expect(f.store.getState().trendBins).toEqual({
      mode: 'fixed-tokens',
      count: 1_000,
    });
    expect(f.store.getState().trendSettingsNotice).toMatch(
      /changed bin mode.*saved preference/,
    );
  });

  it('undoes explicit term deletion without granting the undo record style authority', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const removed = f.store.getState().notebook.groups[0]!;
    f.store.getState().setSolo(removed.id);
    const previousStyle = f.store.getState().styles.get(removed.id);
    f.store.getState().removeGroup(removed.id);
    expect(f.store.getState().removedGroups.at(-1)?.group).toBe(removed);
    expect(f.store.getState().removedGroups.at(-1)?.solo).toBe(true);
    expect(f.store.getState().styles.has(removed.id)).toBe(false);
    f.store.getState().undoRemoveGroup();
    expect(f.store.getState().notebook.groups[0]).toBe(removed);
    expect(f.store.getState().activeGroupIds.has(removed.id)).toBe(true);
    expect(f.store.getState().soloGroupId).toBe(removed.id);
    expect(f.store.getState().styles.get(removed.id)).toEqual(previousStyle);
    // Style reconciliation may naturally choose the same free pair; the undo
    // record itself carries no style authority.
    expect(f.store.getState().removedGroups).toHaveLength(0);
    expect(previousStyle).not.toBeUndefined();

    f.store.getState().removeGroup(removed.id);
    f.store.getState().dismissRemovedGroup();
    expect(f.store.getState().removedGroups).toHaveLength(0);
  });

  it('keeps Matches context local while corpus ordering stays invariant', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    const before = workspaceSemanticKey(f.store.getState());
    const issued = f.issued.length;

    f.store.getState().setMatchesColumns({ ...f.store.getState().matchesView.columns, left: 72 });
    expect(f.store.getState().matchesView).toMatchObject({
      columns: {
        left: 72,
        node: 'auto',
        right: 1,
        book: 'auto',
      },
    });
    expect(workspaceSemanticKey(f.store.getState())).toBe(before);
    expect(f.issued).toHaveLength(issued);

    f.store.getState().setMatchesColumns({ ...f.store.getState().matchesView.columns, node: -20 });
    expect(f.store.getState().matchesView.columns.node).toBe(1);
    f.store.getState().resetMatchesColumns();
    expect(f.store.getState().matchesView.columns).toEqual({
      left: 1,
      node: 'auto',
      right: 1,
      book: 'auto',
    });
    expect(workspaceSemanticKey(f.store.getState())).toBe(before);
    expect(f.issued).toHaveLength(issued);

    const request = f.kwics().at(-1)!.query as {
      request: {
        method: string;
        anchor: unknown;
        before: number;
        after: number;
        contextTokens: number;
        includeAxis: boolean;
      };
    };
    expect(request.request).toEqual({
      method: 'matches-window/1',
      anchor: { kind: 'rank', rank: 0 },
      before: 24,
      after: 24,
      contextTokens: 64,
      includeAxis: true,
    });
    expect(workspaceSemanticKey(f.store.getState())).toBe(before);
  });

  it('keeps semantic column intent stable when visible terms change', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().setMatchesColumns({ ...f.store.getState().matchesView.columns, left: 61, right: 57 });
    f.store.getState().mergeStarterTerms('ox, elephants');
    expect(f.store.getState().matchesView.columns).toEqual({
      left: 61,
      node: 'auto',
      right: 57,
      book: 'auto',
    });

    const elephants = f.store.getState().notebook.groups.find(
      (group) => group.aliases[0] === 'elephants',
    );
    expect(elephants).toBeDefined();
    f.store.getState().removeGroup(elephants!.id);
    expect(f.store.getState().matchesView.columns).toEqual({
      left: 61,
      node: 'auto',
      right: 57,
      book: 'auto',
    });
  });

  it('publishes scrub without querying until the Matches surface requests a position window', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    const issued = f.kwics().length;
    f.store.getState().setScrub({ doc: 'a', token: 20 });
    expect(f.kwics()).toHaveLength(issued);
    f.store.getState().requestMatchesWindow({ kind: 'position', doc: 'a', token: 20 });
    expect(f.kwics()).toHaveLength(issued + 1);
    expect((f.kwics().at(-1)!.query as { request: { anchor: unknown } }).request.anchor)
      .toEqual({ kind: 'position', doc: 'a', token: 20 });
  });

  it('requests a position window immediately for exact barcode evidence', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    const holmes = f.store.getState().series[0]!.id;
    const issued = f.kwics().length;

    f.store.getState().centerKwicAt(holmes, 'a', 20);
    expect(f.kwics()).toHaveLength(issued + 1);
    expect(f.store.getState().matchesReveal).toMatchObject({
      seriesId: holmes,
      doc: 'a',
      token: 20,
    });
    expect((f.kwics().at(-1)!.query as { request: { anchor: unknown } }).request.anchor)
      .toEqual({ kind: 'position', doc: 'a', token: 20 });
  });

  it('clears results to pending on reissue — old arrays are never relabeled', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    const first = f.trends().filter((q) => !q.cancelled).at(-1)!;
    first.resolve({ op: 'trend', trend: fakeTrend(1) });
    await flush();
    expect(f.store.getState().trends.get(f.store.getState().series[0]!.id)!.status).toBe('ready');
    f.store.getState().mergeStarterTerms('other');
    const pending = f.store.getState().trends.get(f.store.getState().series[0]!.id)!;
    expect(pending.status).toBe('pending'); // pending, not stale
  });

  it('a result from a superseded snapshot cannot write', async () => {
    const f = harness(undefined, { seed: true });
    f.port.publishSnapshot('g1', 's1');
    const old = f.trends().filter((q) => !q.cancelled).at(-1)!;
    f.port.publishSnapshot('g1', 's2'); // supersedes s1, reissues
    old.resolve({ op: 'trend', trend: fakeTrend(5) }); // resolve raced past cancel
    await flush();
    for (const [, state] of f.store.getState().trends) {
      expect(state.status).toBe('pending'); // s2's queries own the panels
    }
    const fresh = f.trends().at(-1)!;
    expect(fresh.snapshot).toBe('s2');
  });

  it('removing the LAST group cancels and clears — old evidence is never relabeled (blank quick-add is a no-op)', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    const q = f.trends().filter((x) => !x.cancelled).at(-1)!;
    q.resolve({ op: 'trend', trend: fakeTrend(3) });
    await flush();
    expect(f.store.getState().trends.size).toBe(1);
    const issued = f.issued.length;
    f.store.getState().mergeStarterTerms('  ,  '); // blank: nothing added, nothing touched
    expect(f.issued.length).toBe(issued);
    expect(f.store.getState().trends.size).toBe(1);
    f.store.getState().removeGroup(f.store.getState().series[0]!.id);
    expect(f.store.getState().trends.size).toBe(0);
    expect(f.store.getState().kwic).toBeNull();
    expect(q.cancelled).toBe(false); // settled before removal
    await flush();
    expect(f.store.getState().trends.size).toBe(0);
  });

  it('scrub adopts a valid reading position without issuing Matches work', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const kwicCount = f.kwics().length;

    f.store.getState().setScrub({ doc: 'a', token: 25 });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 25 });
    expect(f.kwics()).toHaveLength(kwicCount);
  });

  it('manifest byte lengths, source hashes, and text hashes match the shipped assets', async () => {
    const { readFile } = await import('node:fs/promises');
    const { hashSourceBytes } = await import('@texttrends/core');
    const { hashText } = await import('../../../packages/core/src/contract/hash.ts');
    for (const { doc, bytes, sourceHash, textHash } of SHERLOCK) {
      const data = await readFile(new URL(`../public/corpora/sherlock/${doc}.txt`, import.meta.url));
      expect(data.byteLength, doc).toBe(bytes);
      expect(await hashSourceBytes(new Uint8Array(data)), doc).toBe(sourceHash);
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(data);
      expect(await hashText(decoded), doc).toBe(textHash);
      expect(sourceHash, doc).toBe(textHash);
    }
  });
});

it('keeps Matches wire order and resident context through notebook reorder', async () => {
  const f = harness();
  f.port.publishSnapshot('g1', 's1', ['a']);
  f.store.getState().mergeStarterTerms('holmes, watson');
  const ids = f.store.getState().series.map((item) => item.id);
  f.store.getState().requestMatchesWindow({ kind: 'rank', rank: 0 }, { before: 40, after: 40, contextTokens: 80 });
  f.kwics().at(-1)!.resolve(fakeMatches(1));
  await flush();
  const resident = f.store.getState().kwic?.resident;
  const count = f.kwics().length;
  f.store.getState().reorderGroups([...ids].reverse());
  f.store.getState().requestMatchesWindow({ kind: 'rank', rank: 0 }, { before: 40, after: 40, contextTokens: 80 });
  expect(f.kwics()).toHaveLength(count);
  expect(f.store.getState().kwic?.resident).toBe(resident);
  expect(f.store.getState().kwic?.trackSeriesIds).toEqual(ids);
  f.store.getState().runQueries();
  expect((f.store.getState().kwic?.request)).toMatchObject({ before: 40, after: 40, contextTokens: 80 });
  f.runtime.dispose();
});


it('keeps an exact forced Matches reveal alive when a mounted viewport requests its resident target', async () => {
  const f = harness();
  f.port.publishSnapshot('g1', 's1', ['a']);
  f.store.getState().mergeStarterTerms('holmes');
  f.kwics().at(-1)!.resolve(fakeMatches(1));
  await flush();
  const seriesId = f.store.getState().series[0]!.id;
  f.store.getState().centerKwicAt(seriesId, 'a', 10, { kind: 'occurrence' });
  const forced = f.kwics().at(-1)!;
  const count = f.kwics().length;
  f.store.getState().requestMatchesWindow({ kind: 'position', doc: 'a', token: 10 }, { before: 40, after: 40, contextTokens: 80 });
  expect(f.kwics()).toHaveLength(count);
  expect(forced.cancelled).toBe(false);
  f.store.getState().requestMatchesWindow({ kind: 'position', doc: 'a', token: 50 }, { before: 40, after: 40, contextTokens: 80 });
  expect(f.kwics()).toHaveLength(count + 1);
  expect(forced.cancelled).toBe(true);
  f.runtime.dispose();
});
