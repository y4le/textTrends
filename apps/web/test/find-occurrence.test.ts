/** find occurrence behavior through the live application runtime. */

import { describe, expect, it, vi } from 'vitest';

import { occurrenceNavigationText } from '../src/lib/occurrence-view.ts';

import { WORKSPACE_SEMANTIC_SOURCE_KEYS, workspaceFromApp } from '../src/lib/workspace-state.ts';

import type { QueryResultDataV4 } from '../src/worker/protocol-v4.ts';

import { WorkerClientError } from '../src/lib/client.ts';

import { canonicalJson } from '@texttrends/core';

import { coreGroupOf } from '../src/lib/notebook.ts';

import { type Issued, FakeWorkspaceStore, fakeTrend, fakeReaderPage, harness, editTerm, flush } from './support/runtime-harness.ts';

vi.mock('@texttrends/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@texttrends/core')>();
  return {
    ...actual,
    canonicalJson: vi.fn(actual.canonicalJson),
  };
});

describe('temporary corpus Find', () => {
  const resultFor = (
    entry: Issued,
    hit: { readonly doc: string; readonly token: number; readonly spanTokens: number; readonly members: readonly number[] } | null,
    overrides: Partial<Extract<QueryResultDataV4, { op: 'occurrence-step' }>> = {},
  ): QueryResultDataV4 => {
    const query = entry.query as {
      tracks: readonly { seriesId: string; group: { id: string } }[];
    };
    const track = query.tracks[0]!;
    return {
      op: 'occurrence-step',
      seriesId: track.seriesId,
      groupId: track.group.id,
      step: { method: 'occurrence-step/1', hit, atEdge: hit === null },
      ...overrides,
    };
  };

  const dispersionResultFor = (
    entry: Issued,
    docs: readonly string[] = ['a'],
  ): QueryResultDataV4 => {
    const query = entry.query as {
      tracks: readonly { seriesId: string; group: { id: string } }[];
    };
    const track = query.tracks[0]!;
    return {
      op: 'dispersion',
      dispersion: {
        method: 'dispersion/1',
        geometry: null,
        tracks: [{
          seriesId: track.seriesId,
          groupId: track.group.id,
          total: 1,
          data: {
            kind: 'exact',
            docOffsets: Uint32Array.from([0, 1, ...docs.slice(1).map(() => 1)]),
            starts: Uint32Array.of(4),
            spanTokens: Uint32Array.of(1),
          },
        }],
      },
    };
  };

  const setup = (docs: readonly string[] = ['a']) => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', docs);
    f.store.setState({
      corpusTokenCounts: new Map(docs.map((doc) => [doc, 100])),
    });
    f.store.getState().enterFind();
    return f;
  };

  it('retries the Find analysis displayed by Atlas even with no authored terms', async () => {
    const f = setup();
    f.store.getState().submitFind('wolf');
    const failed = f.issued.filter((entry) => entry.op === 'dispersion').at(-1)!;
    failed.reject(new Error('failed Find distribution'));
    await flush();
    const before = f.issued.length;
    f.store.getState().retryDisplayedAnalysis();
    const retry = f.issued.slice(before);
    expect(retry.map((entry) => entry.op).sort()).toEqual(['dispersion', 'trend']);
    const dispersion = retry.find((entry) => entry.op === 'dispersion')!;
    dispersion.resolve(dispersionResultFor(dispersion));
    await flush();
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find', find: { dispersion: { status: 'ready' } },
    });
    f.runtime.dispose();
  });

  it('keeps the persistence source list exhaustive as the workspace projection evolves', () => {
    const f = harness(undefined, { workspace: new FakeWorkspaceStore() });
    f.port.publishSnapshot('g1', 's1', ['a']);
    // activeGroupIds is read inside a group filter, so the probe must contain
    // a group or an incomplete source list could pass accidentally.
    f.store.getState().mergeStarterTerms('wolf');
    const read = new Set<string>();
    const probe = new Proxy(
      f.store.getState() as unknown as Record<string, unknown>,
      {
        get(target, key) {
          if (typeof key === 'string') read.add(key);
          return Reflect.get(target, key);
        },
      },
    );

    expect(workspaceFromApp(probe as never)).not.toBeNull();
    expect([...read].sort()).toEqual([...WORKSPACE_SEMANTIC_SOURCE_KEYS].sort());
    f.runtime.dispose();
  });

  it('does not serialize the durable workspace while Find advances transient surfaces', async () => {
    const workspace = new FakeWorkspaceStore();
    const f = harness(undefined, { workspace });
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.setState({ corpusTokenCounts: new Map([['a', 100]]) });
    f.store.getState().enterFind();
    const serialize = vi.mocked(canonicalJson);
    serialize.mockClear();
    const workspaceSerializations = () => serialize.mock.calls.filter(
      ([value]) => (value as { schema?: string } | null)?.schema === 'texttrends/workspace/1',
    );
    const persistenceBefore = f.store.getState().workspacePersistence;

    expect(f.store.getState().submitFind('holmes')).toBe(true);
    const step = f.occurrenceSteps().at(-1)!;
    step.resolve(resultFor(step, {
      doc: 'a', token: 4, spanTokens: 1, members: [0],
    }));
    await flush();

    expect(workspaceSerializations()).toHaveLength(0);
    expect(f.store.getState().workspacePersistence).toEqual(persistenceBefore);

    f.store.getState().setTrendView('series');
    expect(workspaceSerializations().length).toBeGreaterThan(0);
    f.runtime.dispose();
    serialize.mockClear();
  });

  it('issues one multi-alias Terms track with an empty notebook without calling the first hit a wrap', async () => {
    const f = setup();
    expect(f.store.getState().series).toHaveLength(0);
    expect(f.store.getState().submitFind('New Yo*, NYC')).toBe(true);

    const entry = f.occurrenceSteps().at(-1)!;
    const query = entry.query as {
      selection?: unknown;
      tracks: readonly {
        seriesId: string;
        group: { id: string; members: readonly { kind: string }[] };
      }[];
      request: unknown;
    };
    expect(query.selection).toBeUndefined();
    expect(query.tracks).toHaveLength(1);
    expect(query.tracks[0]!.seriesId).toMatch(/^find-series:/);
    expect(query.tracks[0]!.group).toMatchObject({
      id: expect.stringMatching(/^find-group:/),
      members: [{ kind: 'phrase' }, { kind: 'token' }],
    });
    expect(query.request).toEqual({
      method: 'occurrence-step/1', doc: 'a', token: 99, direction: 1,
    });
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find',
      find: {
        query: { raw: 'New Yo*, NYC', label: 'New Yo*' },
        state: { status: 'pending', direction: 1 },
      },
    });

    entry.resolve(resultFor(entry, {
      doc: 'a', token: 4, spanTokens: 1, members: [1],
    }));
    await flush();
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find', find: { state: { status: 'ready', wrapped: false } },
    });
  });

  it('projects one temporary analysis track everywhere and restores the resident comparison on exit', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.setState({ corpusTokenCounts: new Map([['a', 100], ['b', 100]]) });
    f.store.getState().mergeStarterTerms('holmes, watson');
    f.store.getState().setScrub({ doc: 'a', token: 10 });
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 10, from: 'footer', anchor: 'position',
    });
    const durableSeries = f.store.getState().series;
    const durableIds = durableSeries.map((series) => series.id);
    const durableTrends = f.store.getState().trends;
    const durableDispersion = f.store.getState().dispersion;

    f.store.getState().enterFind();
    expect(f.store.getState().series).toBe(durableSeries);
    expect(f.store.getState().kwic).toBeNull();
    expect(f.store.getState().submitFind('moriarty')).toBe(true);

    const interaction = f.store.getState().interaction;
    expect(interaction.kind).toBe('find');
    const find = interaction.kind === 'find' ? interaction.find : null;
    expect(find).not.toBeNull();
    const findId = find!.query.seriesId;
    const findTrend = f.trends().filter((entry) => entry.term === 'moriarty').at(-1)!;
    const findDispersion = f.issued.filter(
      (entry) => entry.op === 'dispersion' && entry.term === 'moriarty',
    ).at(-1)!;
    const findMatches = f.kwics().at(-1)!;
    expect((findTrend.query as { selection: { docs: string[] } }).selection.docs)
      .toEqual(['a', 'b']);
    expect((findDispersion.query as { tracks: { seriesId: string }[] }).tracks)
      .toEqual([{ seriesId: findId, group: find!.query.group }]);
    expect((findMatches.query as { tracks: { seriesId: string }[] }).tracks.map((track) => track.seriesId))
      .toEqual([findId]);
    const findSourceQueries = f.readers().filter((entry) => entry.term === 'moriarty');
    expect(findSourceQueries.map((entry) => (
      entry.query as { request: { maxTokens: number } }
    ).request.maxTokens).sort((left, right) => left - right)).toEqual([400, 4_096]);
    for (const entry of findSourceQueries) {
      expect((entry.query as { tracks: { seriesId: string }[] }).tracks.map((track) => track.seriesId))
        .toEqual([findId]);
    }
    expect(f.store.getState().readerPage?.tracks).toMatchObject([{ seriesId: findId }]);
    expect(f.store.getState().footerPassage?.tracks).toMatchObject([{ seriesId: findId }]);
    expect(f.store.getState().series).toBe(durableSeries);
    expect(f.store.getState().trends).toBe(durableTrends);
    expect(f.store.getState().dispersion).toBe(durableDispersion);

    findTrend.resolve({ op: 'trend', trend: fakeTrend(7) });
    findDispersion.resolve(dispersionResultFor(findDispersion, ['a', 'b']));
    await flush();
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find',
      find: {
        trend: { status: 'ready', trend: { count: Uint32Array.of(7) } },
        dispersion: {
          status: 'ready',
          result: { tracks: [{ seriesId: findId, total: 1 }] },
        },
      },
    });

    f.store.getState().exitInteraction();
    expect(f.store.getState().interaction).toEqual({ kind: 'none' });
    expect(f.store.getState().series).toBe(durableSeries);
    expect(f.store.getState().trends).toBe(durableTrends);
    expect(f.store.getState().dispersion).toBe(durableDispersion);
    const restored = f.kwics().at(-1)!.query as { tracks: { seriesId: string }[] };
    expect(restored.tracks.map((track) => track.seriesId)).toEqual(durableIds);
    expect(f.store.getState().readerPage?.tracks.map((track) => track.seriesId)).toEqual(durableIds);
    expect(f.store.getState().footerPassage?.tracks.map((track) => track.seriesId)).toEqual(durableIds);
    f.runtime.dispose();
  });

  it('makes temporary graph and barcode analysis latest-wins across Find query changes', async () => {
    const f = setup();
    f.store.getState().submitFind('holmes');
    const staleTrend = f.trends().filter((entry) => entry.term === 'holmes').at(-1)!;
    const staleDispersion = f.issued.filter(
      (entry) => entry.op === 'dispersion' && entry.term === 'holmes',
    ).at(-1)!;

    f.store.getState().submitFind('moriarty');
    const liveTrend = f.trends().filter((entry) => entry.term === 'moriarty').at(-1)!;
    const liveDispersion = f.issued.filter(
      (entry) => entry.op === 'dispersion' && entry.term === 'moriarty',
    ).at(-1)!;
    expect(staleTrend.cancelled).toBe(true);
    expect(staleDispersion.cancelled).toBe(true);

    staleTrend.resolve({ op: 'trend', trend: fakeTrend(99) });
    staleDispersion.resolve(dispersionResultFor(staleDispersion));
    liveTrend.resolve({ op: 'trend', trend: fakeTrend(3) });
    liveDispersion.resolve(dispersionResultFor(liveDispersion));
    await flush();
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find',
      find: {
        query: { raw: 'moriarty' },
        trend: { status: 'ready', trend: { count: Uint32Array.of(3) } },
        dispersion: { status: 'ready', result: { tracks: [{ total: 1 }] } },
      },
    });
    f.runtime.dispose();
  });

  it('routes shared occurrence navigation through Find even with an empty notebook', () => {
    const f = setup();
    f.store.getState().submitFind('holmes');
    const forward = f.occurrenceSteps().at(-1)!;

    f.store.getState().stepOccurrence(-1);
    const backward = f.occurrenceSteps().at(-1)!;
    expect(backward).not.toBe(forward);
    expect(forward.cancelled).toBe(true);
    expect((backward.query as { request: { direction: number } }).request.direction).toBe(-1);
    expect(f.store.getState().series).toHaveLength(0);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find', find: { state: { status: 'pending', direction: -1 } },
    });
    f.runtime.dispose();
  });

  it('reissues only the temporary trend when bins change during Find', () => {
    const f = setup();
    f.store.getState().submitFind('holmes');
    const trendCount = f.trends().length;
    const dispersionCount = f.issued.filter((entry) => entry.op === 'dispersion').length;
    const matchesCount = f.kwics().length;

    expect(f.store.getState().applyTrendSettings({
      bins: { mode: 'fixed-tokens', count: 250 },
      measure: { kind: 'count' },
    })).toBe('applied');
    expect(f.trends()).toHaveLength(trendCount + 1);
    expect(f.issued.filter((entry) => entry.op === 'dispersion')).toHaveLength(dispersionCount);
    expect(f.kwics()).toHaveLength(matchesCount);
    const reissued = f.trends().at(-1)!;
    expect(reissued.term).toBe('holmes');
    expect((reissued.query as { request: { bins: unknown } }).request.bins)
      .toEqual({ mode: 'fixed-tokens', count: 250 });
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find', find: { trend: { status: 'pending' } },
    });
    f.runtime.dispose();
  });

  it('does not call a first backward seek from the synthetic corpus edge a wrap', async () => {
    const f = setup();
    f.store.getState().submitFind('holmes');
    const initial = f.occurrenceSteps().at(-1)!;
    initial.resolve(resultFor(initial, {
      doc: 'a', token: 4, spanTokens: 1, members: [0],
    }));
    await flush();
    f.store.setState({ scrub: null });
    f.store.getState().stepFind(-1);
    const backward = f.occurrenceSteps().at(-1)!;
    expect((backward.query as { request: unknown }).request).toEqual({
      method: 'occurrence-step/1', doc: 'a', token: 0, direction: -1,
    });
    backward.resolve(resultFor(backward, {
      doc: 'a', token: 80, spanTokens: 1, members: [0],
    }));
    await flush();
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find', find: { state: { status: 'ready', direction: -1, wrapped: false } },
    });
  });

  it('cycles from the displayed Find hit instead of ambient cursor drift', async () => {
    const f = setup();
    f.store.getState().setScrub({ doc: 'a', token: 10 });
    f.store.getState().submitFind('holmes');
    const initial = f.occurrenceSteps().at(-1)!;
    initial.resolve(resultFor(initial, {
      doc: 'a', token: 4, spanTokens: 1, members: [0],
    }));
    await flush();

    // Hovering/scrubbing remains allowed while Find is open, but Next still
    // names the exact result that the Find status and progress UI display.
    f.store.getState().setScrub({ doc: 'a', token: 90 });
    f.store.getState().stepFind(1);
    const next = f.occurrenceSteps().at(-1)!;
    expect(next).not.toBe(initial);
    expect((next.query as { request: unknown }).request).toEqual({
      method: 'occurrence-step/1', doc: 'a', token: 4, direction: 1,
    });
    f.runtime.dispose();
  });

  it('moves the truthful cursor, reanchors Matches, detects wrap, and does not open Reader', async () => {
    const f = setup(['a', 'b']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().setScrub({ doc: 'b', token: 90 });
    const kwicBefore = f.kwics().length;
    f.store.getState().submitFind('watson');
    const entry = f.occurrenceSteps().at(-1)!;

    entry.resolve(resultFor(entry, {
      doc: 'a', token: 4, spanTokens: 1, members: [0],
    }));
    await flush();

    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 4 });
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find',
      find: {
        anchor: { doc: 'b', token: 90 },
        state: { status: 'ready', direction: 1, wrapped: true },
      },
    });
    expect(f.store.getState().matchesReveal).toBeNull();
    expect(f.kwics().length).toBeGreaterThan(kwicBefore);
    expect((f.kwics().at(-1)!.query as { request: { anchor: unknown } }).request.anchor)
      .toEqual({ kind: 'position', doc: 'a', token: 4 });
    expect(f.store.getState().readerPlace).toBeNull();
  });

  it('is latest-wins across direction and query changes while ordinary cursor and notebook edits preserve Find', async () => {
    const f = setup();
    f.store.getState().setScrub({ doc: 'a', token: 10 });
    f.store.getState().submitFind('holmes');
    const first = f.occurrenceSteps().at(-1)!;

    f.store.getState().stepFind(1);
    expect(f.occurrenceSteps().at(-1)).toBe(first);
    f.store.getState().stepFind(-1);
    const reversed = f.occurrenceSteps().at(-1)!;
    expect(first.cancelled).toBe(true);

    f.store.getState().setScrub({ doc: 'a', token: 20 });
    f.store.getState().mergeStarterTerms('watson');
    expect(reversed.cancelled).toBe(false);
    expect(f.store.getState().interaction.kind).toBe('find');

    f.store.getState().submitFind('moriarty');
    const latest = f.occurrenceSteps().at(-1)!;
    expect(reversed.cancelled).toBe(true);
    reversed.resolve(resultFor(reversed, {
      doc: 'a', token: 2, spanTokens: 1, members: [0],
    }));
    latest.resolve(resultFor(latest, {
      doc: 'a', token: 30, spanTokens: 1, members: [0],
    }));
    await flush();
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 30 });
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find', find: { query: { raw: 'moriarty' }, state: { status: 'ready' } },
    });
  });

  it('clears and cancels on snapshot replacement', () => {
    const f = setup();
    f.store.getState().submitFind('holmes');
    const pending = f.occurrenceSteps().at(-1)!;
    const pendingTrend = f.trends().filter((entry) => entry.term === 'holmes').at(-1)!;
    const pendingDispersion = f.issued.filter(
      (entry) => entry.op === 'dispersion' && entry.term === 'holmes',
    ).at(-1)!;
    f.port.publishSnapshot('g1', 's2', ['a']);
    expect(pending.cancelled).toBe(true);
    expect(pendingTrend.cancelled).toBe(true);
    expect(pendingDispersion.cancelled).toBe(true);
    expect(f.store.getState().interaction).toEqual({ kind: 'none' });
    expect(f.store.getState().interactionError).toBeNull();
  });

  it('clears and cancels on runtime disposal', () => {
    const f = setup();
    f.store.getState().submitFind('holmes');
    const pending = f.occurrenceSteps().at(-1)!;
    const pendingTrend = f.trends().filter((entry) => entry.term === 'holmes').at(-1)!;
    const pendingDispersion = f.issued.filter(
      (entry) => entry.op === 'dispersion' && entry.term === 'holmes',
    ).at(-1)!;
    f.runtime.dispose();
    expect(pending.cancelled).toBe(true);
    expect(pendingTrend.cancelled).toBe(true);
    expect(pendingDispersion.cancelled).toBe(true);
    expect(f.store.getState().interaction).toEqual({ kind: 'none' });
    expect(f.store.getState().interactionError).toBeNull();
  });

  it('admits only the issued transient identity and maps occurrence-cap errors', async () => {
    const f = setup();
    f.store.getState().setScrub({ doc: 'a', token: 10 });
    f.store.getState().submitFind('holmes');
    const wrong = f.occurrenceSteps().at(-1)!;
    wrong.resolve(resultFor(wrong, {
      doc: 'a', token: 20, spanTokens: 1, members: [0],
    }, { seriesId: 'wrong-series' }));
    await flush();
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 10 });
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find', find: { state: { status: 'error', message: 'worker returned the wrong find query' } },
    });

    f.store.getState().stepFind(1);
    const capped = f.occurrenceSteps().at(-1)!;
    capped.reject(new WorkerClientError('WORKER_ERROR', 'cap', 'CAP_EXCEEDED'));
    await flush();
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find',
      find: {
        state: {
          status: 'error',
          message: 'This query occurs too often to navigate exactly — try a longer phrase.',
        },
      },
    });
  });

  it('settles against the live Reader even when Reader opened after issue', async () => {
    const f = setup(['a', 'b']);
    f.store.getState().setScrub({ doc: 'a', token: 10 });
    f.store.getState().submitFind('holmes');
    const pending = f.occurrenceSteps().at(-1)!;
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 10, from: 'footer', anchor: 'position',
    });
    f.store.getState().setReaderScale('atlas');
    const readerCount = f.readers().filter((entry) => (
      entry.query as { request: { maxTokens: number } }
    ).request.maxTokens === 4_096).length;

    pending.resolve(resultFor(pending, {
      doc: 'b', token: 5, spanTokens: 1, members: [0],
    }));
    await flush();

    expect(f.store.getState().readerPlace).toMatchObject({
      snapshot: 's1',
      doc: 'b',
      from: 'occurrence',
      anchor: 'occurrence',
      cursor: { kind: 'around', token: 5 },
    });
    expect(f.store.getState().readerScale).toBe('atlas');
    expect(f.store.getState().layers.filter((layer) => layer.kind === 'reader')).toHaveLength(1);
    expect(f.readers().filter((entry) => (
      entry.query as { request: { maxTokens: number } }
    ).request.maxTokens === 4_096).length).toBe(readerCount);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find', find: { state: { status: 'ready' } },
    });
  });
});

describe('exact any-term occurrence navigation', () => {
  const resultFor = (
    entry: Issued,
    hit: { readonly doc: string; readonly token: number; readonly spanTokens: number; readonly members: readonly number[] } | null,
    seriesId?: string,
  ): QueryResultDataV4 => {
    const query = entry.query as {
      tracks: readonly { seriesId: string; group: { id: string } }[];
    };
    const track = query.tracks.find((candidate) => candidate.seriesId === seriesId)
      ?? query.tracks[0]!;
    return {
      op: 'occurrence-step',
      seriesId: track.seriesId,
      groupId: track.group.id,
      step: { method: 'occurrence-step/1', hit, atEdge: hit === null },
    };
  };

  it('queries every active term and centers the nearest result in reading + Matches', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes, watson');
    f.store.getState().setScrub({ doc: 'a', token: 2 });

    f.store.getState().stepOccurrence(1);
    const request = f.occurrenceSteps().at(-1)!;
    const query = request.query as {
      selection?: unknown;
      tracks: readonly { seriesId: string; group: { id: string; members: { surface: string }[] } }[];
      request: { method: string; doc: string; token: number; direction: number };
    };
    expect(query.selection).toBeUndefined();
    expect(query.tracks.map((track) => track.seriesId)).toEqual(
      f.store.getState().series.map((series) => series.id),
    );
    expect(query.tracks.map((track) => track.group.members[0]!.surface))
      .toEqual(['holmes', 'watson']);
    expect(query.request).toEqual({
      method: 'occurrence-step/1', doc: 'a', token: 2, direction: 1,
    });
    expect(f.store.getState().occurrenceNavigation?.state.status).toBe('pending');
    expect(request.cancelled).toBe(false);
    expect(f.store.getState().occurrenceNavigation?.state.status).toBe('pending');

    const watson = f.store.getState().series[1]!;
    request.resolve(resultFor(request, {
      doc: 'a', token: 7, spanTokens: 2, members: [0],
    }, watson.id));
    await flush();
    expect(f.store.getState()).toMatchObject({
      scrub: { doc: 'a', token: 7 },
      occurrenceNavigation: {
        direction: 1,
        state: {
          status: 'ready',
          hit: { doc: 'a', token: 7, spanTokens: 2, members: [0] },
        },
      },
    });
    const centered = f.kwics().at(-1)!.query as { request: { anchor: unknown } };
    expect(centered.request.anchor).toEqual({ kind: 'position', doc: 'a', token: 7 });
  });

  it('is latest-wins, rejects a stale settlement, and reports a non-wrapping edge', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().setScrub({ doc: 'a', token: 4 });

    f.store.getState().stepOccurrence(1);
    const stale = f.occurrenceSteps().at(-1)!;
    f.store.getState().stepOccurrence(-1);
    const live = f.occurrenceSteps().at(-1)!;
    expect(stale.cancelled).toBe(true);
    stale.resolve(resultFor(stale, { doc: 'a', token: 9, spanTokens: 1, members: [0] }));
    await flush();
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 4 });

    live.resolve(resultFor(live, null));
    await flush();
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 4 });
    expect(f.store.getState().occurrenceNavigation).toMatchObject({
      direction: -1,
      state: { status: 'edge' },
    });
    expect(occurrenceNavigationText(
      f.store.getState().occurrenceNavigation,
    )).toBe('no references from any term');
  });

  it('describes every reference-navigation state without leaking a term label', () => {
    const base = {
      snapshot: 's1',
      seriesId: 'holmes',
      direction: 1 as const,
    };
    expect(occurrenceNavigationText({ ...base, state: { status: 'pending' } }))
      .toBe('finding next reference from any term');
    expect(occurrenceNavigationText({
      ...base,
      state: {
        status: 'ready',
        hit: { doc: 'a', token: 7, spanTokens: 1, members: [0] },
      },
    })).toBe('next reference from any term');
    expect(occurrenceNavigationText({ ...base, state: { status: 'edge' } }))
      .toBe('no references from any term');
    expect(occurrenceNavigationText({
      ...base,
      state: { status: 'error', message: 'worker unavailable' },
    })).toBe('reference navigation failed: worker unavailable');
    expect(occurrenceNavigationText(null)).toBe('');
  });

  it('retargets Atlas around an exact hit without a prose query or another layer', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 3, from: 'kwic', anchor: 'occurrence',
    });
    const initialReader = f.readers().at(-1)!;
    const initialPage = fakeReaderPage(0, 6, 10, 'a');
    if (initialPage.op !== 'reader-page') throw new Error('expected reader-page');
    initialReader.resolve({
      ...initialPage,
      page: {
        ...initialPage.page,
        anchor: { token: 3, relToken: 3, charsUtf16: { start: 3, end: 4 } },
      },
    });
    await flush();
    f.store.getState().setReaderScale('atlas');
    const readerCount = f.readers().filter((entry) => (
      entry.query as { request: { maxTokens: number } }
    ).request.maxTokens === 4_096).length;

    f.store.getState().stepOccurrence(1);
    const request = f.occurrenceSteps().at(-1)!;
    expect((request.query as { request: { doc: string; token: number } }).request)
      .toMatchObject({ doc: 'a', token: 3 });
    request.resolve(resultFor(request, {
      doc: 'b', token: 2, spanTokens: 1, members: [0],
    }));
    await flush();

    expect(f.store.getState().layers.filter((layer) => layer.kind === 'reader')).toHaveLength(1);
    expect(f.store.getState().readerPlace).toMatchObject({
      doc: 'b',
      from: 'occurrence',
      anchor: 'occurrence',
      cursor: { kind: 'around', token: 2 },
    });
    expect(f.store.getState().readerScale).toBe('atlas');
    expect(f.readers().filter((entry) => (
      entry.query as { request: { maxTokens: number } }
    ).request.maxTokens === 4_096).length).toBe(readerCount);
  });

  it('semantic edits cancel the lane and prevent a late hit from moving the reader', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().setScrub({ doc: 'a', token: 2 });
    f.store.getState().stepOccurrence(1);
    const request = f.occurrenceSteps().at(-1)!;
    const group = f.store.getState().notebook.groups[0]!;
    const member = coreGroupOf(group).members[0]!;
    if (member.kind !== 'token') throw new Error('quick-add should create a token');
    editTerm(f.store.getState(), group.id, { aliases: ['watson'], countOverlaps: false });
    expect(request.cancelled).toBe(true);
    expect(f.store.getState().occurrenceNavigation).toBeNull();
    request.resolve(resultFor(request, { doc: 'a', token: 8, spanTokens: 1, members: [0] }));
    await flush();
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 2 });
  });

  it('refuses mismatched worker identity and malformed hit provenance', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().setScrub({ doc: 'a', token: 2 });

    f.store.getState().stepOccurrence(1);
    const wrongIdentity = f.occurrenceSteps().at(-1)!;
    const wrongIdentityResult = resultFor(
      wrongIdentity,
      { doc: 'a', token: 4, spanTokens: 1, members: [0] },
    );
    if (wrongIdentityResult.op !== 'occurrence-step') throw new Error('expected occurrence-step');
    wrongIdentity.resolve({
      ...wrongIdentityResult,
      groupId: 'wrong-group',
    });
    await flush();
    expect(f.store.getState().occurrenceNavigation?.state).toMatchObject({
      status: 'error', message: 'worker returned an inactive term',
    });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 2 });

    f.store.getState().stepOccurrence(1);
    const malformed = f.occurrenceSteps().at(-1)!;
    malformed.resolve(resultFor(malformed, {
      doc: 'a', token: 4, spanTokens: 1, members: [99],
    }));
    await flush();
    expect(f.store.getState().occurrenceNavigation?.state).toMatchObject({
      status: 'error', message: 'worker returned an invalid reference',
    });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 2 });
  });
});
