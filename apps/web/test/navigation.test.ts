/** navigation behavior through the live application runtime. */

import { describe, expect, it, vi } from 'vitest';
import {
  createAppRuntime,

} from '../src/lib/store.ts';

import { WORKSPACE_SEMANTIC_SOURCE_KEYS, workspaceSemanticKey } from '../src/lib/workspace-state.ts';

import {
  EMPTY_POSITION_HISTORY,
  POSITION_HISTORY_SETTLE_MS,
} from '../src/lib/position-history.ts';
import {
  applyGuideStage,
  type GuideStageActions,
} from '../src/lib/guide/stage.ts';
import { fakeQueryClient, FakeHistoryPort, layerIds, LIBRARY_PROJECT, snap, sessionState, FakeSessionPort, fakeTrend, fakeMatches, fakeInventoryResult, harness, flush } from './support/runtime-harness.ts';

describe('workbench route and history authority', () => {
  it('keeps every durable workspace source and linked selection identical through guide staging', () => {
    const history = new FakeHistoryPort('/textTrends/?p=trends');
    const f = harness(undefined, { history });
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setLinkedSelection({
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 2, end: 5 } }],
    });
    const guardedKeys = [
      ...WORKSPACE_SEMANTIC_SOURCE_KEYS,
      'linkedSelection',
    ] as const;
    const before = guardedKeys.map((key) => f.store.getState()[key]);
    const actions: GuideStageActions = {
      replacePlace: (place) => f.store.getState().replacePlace(place),
      openReader: (intent, returnFocusTo) =>
        f.store.getState().openReader(intent, returnFocusTo),
      closeReader: () => f.store.getState().closeReader(),
    };

    applyGuideStage({ kind: 'place', place: 'matches' }, actions);
    applyGuideStage({
      kind: 'reader-open',
      intent: {
        snapshot: 's1', doc: 'a', token: 3, from: 'barcode', anchor: 'occurrence',
      },
    }, actions);
    expect(f.store.getState()).toMatchObject({
      place: 'matches',
      readerPlace: { snapshot: 's1', doc: 'a', from: 'barcode' },
    });
    applyGuideStage({ kind: 'reader-close' }, actions);

    expect(history.backs).toBe(1);
    expect(f.store.getState().readerPlace).toBeNull();
    for (const [index, key] of guardedKeys.entries()) {
      expect(Object.is(f.store.getState()[key], before[index]), key).toBe(true);
    }
    f.runtime.dispose();
  });

  it('resolves a p-less boot exactly once from the attached corpus without pushing history', () => {
    const emptyHistory = new FakeHistoryPort('/textTrends/?foreign=kept');
    const emptyRuntime = createAppRuntime(fakeQueryClient().client, { history: emptyHistory });
    expect(emptyRuntime.useApp.getState()).toMatchObject({
      place: 'inputs',
      routeStatus: 'pending',
    });
    expect(emptyHistory.url).toBe('/textTrends/?foreign=kept');
    emptyRuntime.attachSession(new FakeSessionPort(sessionState(null, {
      project: { data: { ...LIBRARY_PROJECT.data, order: [] } },
    })));
    expect(emptyRuntime.useApp.getState()).toMatchObject({
      place: 'inputs',
      routeStatus: 'resolved',
    });
    expect(emptyHistory.url).toBe('/textTrends/?foreign=kept&p=inputs');
    expect(emptyHistory.pushes).toBe(0);
    expect(emptyHistory.entries).toHaveLength(1);
    emptyRuntime.dispose();

    const loadedHistory = new FakeHistoryPort('/textTrends/');
    const loadedRuntime = createAppRuntime(fakeQueryClient().client, { history: loadedHistory });
    loadedRuntime.attachSession(new FakeSessionPort(sessionState(null, {
      project: { data: { ...LIBRARY_PROJECT.data, order: ['a'] } },
    })));
    expect(loadedRuntime.useApp.getState()).toMatchObject({
      place: 'trends',
      routeStatus: 'resolved',
    });
    expect(loadedHistory.url).toBe('/textTrends/?p=trends');
    expect(loadedHistory.pushes).toBe(0);
    loadedRuntime.dispose();
  });

  it('never lets corpus defaults override an explicit place', () => {
    const history = new FakeHistoryPort('/textTrends/?p=vocabulary');
    const runtime = createAppRuntime(fakeQueryClient().client, { history });
    runtime.attachSession(new FakeSessionPort(sessionState(null, {
      project: { data: { ...LIBRARY_PROJECT.data, order: [] } },
    })));
    expect(runtime.useApp.getState()).toMatchObject({
      place: 'vocabulary',
      routeStatus: 'resolved',
    });
    expect(history.url).toBe('/textTrends/?p=vocabulary');
    runtime.dispose();
  });

  it('replaces an unavailable place so Back reaches the preceding entry', () => {
    const history = new FakeHistoryPort('/textTrends/?p=trends');
    const runtime = createAppRuntime(fakeQueryClient().client, {
      history,
      newLayerId: layerIds(),
    });
    const store = runtime.useApp;
    store.getState().setPlace('compare');
    expect(history.pushes).toBe(1);
    expect(history.url).toBe('/textTrends/?p=compare');

    store.getState().replacePlace('inputs');
    expect(history.pushes).toBe(1);
    expect(history.url).toBe('/textTrends/?p=inputs');
    history.back();
    expect(store.getState().place).toBe('trends');
    expect(history.url).toBe('/textTrends/?p=trends');
    runtime.dispose();
  });

  it('returns place navigation to the Vocabulary list entry surface', () => {
    const history = new FakeHistoryPort('/textTrends/?p=vocabulary');
    const runtime = createAppRuntime(fakeQueryClient().client, {
      history,
      newLayerId: layerIds(),
    });

    runtime.useApp.getState().setPlace('matches');

    expect(runtime.useApp.getState().layers.at(-1)?.returnFocusTo)
      .toBe('vocabulary-grid-port');
    runtime.dispose();
  });

  it('keeps non-place layers from choosing the provisional place during bootstrap', () => {
    const history = new FakeHistoryPort('/textTrends/?foreign=kept');
    const runtime = createAppRuntime(fakeQueryClient().client, {
      history,
      newLayerId: layerIds(),
    });
    runtime.useApp.getState().pushLayer('row-detail', { surface: 'term-manager' }, 'terms');
    expect(runtime.useApp.getState()).toMatchObject({
      place: 'inputs',
      routeStatus: 'pending',
    });
    expect(history.url).toBe('/textTrends/?foreign=kept');

    runtime.attachSession(new FakeSessionPort(sessionState(null, {
      project: { data: { ...LIBRARY_PROJECT.data, order: ['a'] } },
    })));
    expect(runtime.useApp.getState()).toMatchObject({
      place: 'trends',
      routeStatus: 'resolved',
    });
    expect(history.url).toBe('/textTrends/?foreign=kept&p=trends');
    runtime.dispose();
  });

  it('lets an explicit tab click win while the corpus-aware default is pending', () => {
    const history = new FakeHistoryPort('/textTrends/');
    const runtime = createAppRuntime(fakeQueryClient().client, {
      history,
      newLayerId: layerIds(),
    });
    runtime.useApp.getState().setPlace('inputs');
    expect(runtime.useApp.getState()).toMatchObject({
      place: 'inputs',
      routeStatus: 'resolved',
    });
    expect(history.url).toBe('/textTrends/?p=inputs');
    runtime.attachSession(new FakeSessionPort(sessionState(null, {
      project: { data: { ...LIBRARY_PROJECT.data, order: ['a'] } },
    })));
    expect(runtime.useApp.getState().place).toBe('inputs');
    runtime.dispose();
  });

  it('resolves a failed p-less bootstrap to a usable Inputs route', () => {
    const history = new FakeHistoryPort('/textTrends/?foreign=kept');
    const runtime = createAppRuntime(fakeQueryClient().client, { history });
    runtime.failBootstrap(new Error('database unavailable'));
    expect(runtime.useApp.getState()).toMatchObject({
      place: 'inputs',
      routeStatus: 'resolved',
      bootstrap: { phase: 'error', message: 'database unavailable' },
    });
    expect(history.url).toBe('/textTrends/?foreign=kept&p=inputs');
    runtime.dispose();
  });

  it('normalizes a p-less popstate with the same corpus-aware default', () => {
    const history = new FakeHistoryPort('/textTrends/?p=compare');
    const runtime = createAppRuntime(fakeQueryClient().client, { history });
    history.restore({ tt: { v: 1, layers: [] } }, '/textTrends/?foreign=kept');
    expect(runtime.useApp.getState()).toMatchObject({
      place: 'inputs',
      routeStatus: 'resolved',
    });
    expect(history.url).toBe('/textTrends/?foreign=kept&p=inputs');
    runtime.dispose();
  });

  it('canonicalizes a legacy Catalog link to Inputs immediately', () => {
    const history = new FakeHistoryPort('/textTrends/?foreign=kept&p=catalog');
    const runtime = createAppRuntime(fakeQueryClient().client, { history });
    expect(runtime.useApp.getState()).toMatchObject({
      place: 'inputs',
      routeStatus: 'resolved',
    });
    expect(history.url).toBe('/textTrends/?foreign=kept&p=inputs');
    runtime.dispose();
  });

  it('clears transient notebook refusals on direct and history place changes', () => {
    const q = fakeQueryClient();
    const history = new FakeHistoryPort('/textTrends/?p=trends');
    const runtime = createAppRuntime(q.client, {
      history,
      newLayerId: layerIds(),
    });
    const store = runtime.useApp;

    store.setState({ notebookError: 'first refusal' });
    store.getState().setPlace('inputs');
    expect(store.getState()).toMatchObject({
      place: 'inputs',
      notebookError: null,
    });

    store.setState({ notebookError: 'second refusal' });
    history.back();
    expect(store.getState()).toMatchObject({
      place: 'trends',
      notebookError: null,
    });
    runtime.dispose();
  });

  it('does not leave the app or double-traverse when there is no layer to unwind', () => {
    const q = fakeQueryClient();
    const history = new FakeHistoryPort('/textTrends/?p=trends');
    const runtime = createAppRuntime(q.client, {
      history,
      newLayerId: layerIds(),
    });
    expect(runtime.useApp.getState().popLayer()).toBe(false);
    expect(runtime.useApp.getState().popLayer()).toBe(false);
    expect(history.backs).toBe(0);
    expect(history.leftApp).toBe(0);
    runtime.dispose();
  });

  it('closes two governed details in one Back traversal', () => {
    const q = fakeQueryClient();
    const history = new FakeHistoryPort('/textTrends/?p=catalog');
    const runtime = createAppRuntime(q.client, {
      history,
      newLayerId: layerIds(),
    });
    const store = runtime.useApp;

    store.getState().pushLayer(
      'row-detail',
      { surface: 'book-sheet', doc: 'book' },
      'book-title',
    );
    store.getState().pushLayer(
      'row-detail',
      { surface: 'vocab-row', key: 'word' },
      'vocabulary-word',
    );
    expect(store.getState().layers).toHaveLength(2);

    store.getState().popLayer(2);
    expect(history.backs).toBe(1);
    expect(store.getState().layers).toHaveLength(0);

    history.forward();
    expect(store.getState().layers).toHaveLength(1);
    history.forward();
    expect(store.getState().layers).toHaveLength(2);
    expect(q.issued).toHaveLength(0);
    runtime.dispose();
  });

  it('leaves foreign fragments opaque while normalizing owned route keys', () => {
    const q = fakeQueryClient();
    const history = new FakeHistoryPort(
      '/textTrends/?foreign=a+b&p=compare&opaque=sheet#foreign-payload',
    );
    const runtime = createAppRuntime(q.client, {
      history,
      newLayerId: layerIds(),
    });
    expect(runtime.useApp.getState()).toMatchObject({
      place: 'compare',
      layers: [],
    });
    expect(history.url).toBe(
      '/textTrends/?foreign=a+b&opaque=sheet&p=compare#foreign-payload',
    );
    expect(history.entries).toHaveLength(1);
    expect(q.issued).toHaveLength(0);
    runtime.dispose();
  });

  it('keeps route/layer changes outside research, queries, and serialized targets', async () => {
    const q = fakeQueryClient();
    const history = new FakeHistoryPort('/textTrends/?foreign=%2f&p=trends');
    const runtime = createAppRuntime(q.client, {
      newId: () => 'semantic-id',
      newLayerId: layerIds(),
      history,
    });
    const port = new FakeSessionPort();
    runtime.attachSession(port);
    await Promise.resolve();
    await Promise.resolve();

    const store = runtime.useApp;
    const before = workspaceSemanticKey(store.getState());
    const issuedBefore = q.issued.length;
    const assertFenced = () => {
      expect(workspaceSemanticKey(store.getState())).toBe(before);
      expect(q.issued).toHaveLength(issuedBefore);
      expect(store.getState().workspacePersistence.phase).toBe('idle');
    };

    store.getState().setPlace('inputs');
    assertFenced();
    store.getState().pushLayer(
      'row-detail',
      { term: 'Holmes', note: 'private target' },
      'vocabulary-row',
    );
    assertFenced();
    store.getState().replaceLayer(
      'row-detail',
      { term: 'Moriarty', token: 42 },
      'other-row',
    );
    assertFenced();

    expect(history.pushes).toBe(2);
    expect(history.url).toBe('/textTrends/?foreign=%2f&p=inputs');
    expect(JSON.stringify(history.state)).not.toMatch(
      /Holmes|Moriarty|private|token|vocabulary-row|local-scroll/,
    );

    store.getState().popLayer();
    expect(store.getState().layers.at(-1)?.kind).toBe('place');
    expect(store.getState()).toMatchObject({
      place: 'inputs',
      layers: [{ kind: 'place' }],
    });
    assertFenced();

    runtime.dispose();
  });

  it('truncates an unresolvable forward stack and normalizes its URL and state', () => {
    const q = fakeQueryClient();
    const history = new FakeHistoryPort('/textTrends/?p=trends');
    const runtime = createAppRuntime(q.client, {
      history,
      newLayerId: layerIds(),
    });
    const store = runtime.useApp;
    store.getState().setPlace('inputs');
    const live = store.getState().layers;
    history.restore({
      tt: {
        v: 1,
        layers: [
          ...live.map(({ kind, id }) => ({ kind, id })),
          { kind: 'reader', id: '00000000-0000-4000-8000-999999999999' },
        ],
      },
    }, '/textTrends/?p=catalog');

    expect(store.getState()).toMatchObject({
      place: 'inputs',
      layers: live,
    });
    expect(history.url).toBe('/textTrends/?p=inputs');
    expect(history.state).toEqual({
      tt: {
        v: 1,
        layers: live.map(({ kind, id }) => ({ kind, id })),
      },
    });
    runtime.dispose();
  });

  it('bounds forward targets and normalizes entries whose layer was evicted', () => {
    const q = fakeQueryClient();
    const history = new FakeHistoryPort('/textTrends/?p=trends');
    const runtime = createAppRuntime(q.client, {
      history,
      newLayerId: layerIds(),
    });
    const store = runtime.useApp;
    const oldest = history.state as {
      readonly tt: { readonly v: 1; readonly layers: readonly unknown[] };
    };
    for (let index = 0; index < 200; index += 1) {
      store.getState().setPlace(index % 2 === 0 ? 'inputs' : 'trends');
    }

    history.restore(oldest, '/textTrends/?p=trends');
    expect(store.getState()).toMatchObject({
      place: 'trends',
      layers: [],
    });
    expect(history.url).toBe('/textTrends/?p=trends');
    expect(history.state).toEqual({ tt: { v: 1, layers: [] } });
    runtime.dispose();
  });
});

describe('linked token-range selection', () => {
  const range = (f: ReturnType<typeof harness>, start: number, end: number) => ({
    snapshot: f.store.getState().snapshot!.snapshot,
    ranges: [{ doc: 'a', tokens: { start, end } }],
  });

  it('committing a range leaves the full-corpus match set untouched and issues overlays on separate lanes', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.getState().mergeStarterTerms('holmes');
    const baseTrend = f.trends().filter((t) => !t.cancelled).at(-1)!;
    const matches = f.kwics().filter((query) => !query.cancelled).at(-1)!;
    const matchesCount = f.kwics().length;
    f.store.getState().setLinkedSelection(range(f, 10, 20));
    expect(f.kwics()).toHaveLength(matchesCount);
    expect(matches.cancelled).toBe(false);
    expect((matches.query as { selection?: unknown }).selection).toBeUndefined();
    // Overlays issued; the BASELINE trend job was NOT cancelled.
    expect(baseTrend.cancelled).toBe(false);
    expect(f.store.getState().selectedTrends.get(f.store.getState().series[0]!.id)!.status).toBe('pending');
    expect(f.store.getState().selectedDispersion!.state.status).toBe('pending');
    const selTrend = f.trends().filter((t) => !t.cancelled).at(-1)!.query as { selection: { docs: string[] } };
    expect(selTrend.selection.docs).toEqual(['a']);
  });

  it('does no work when a new selection is value-equal to the active range', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().setLinkedSelection(range(f, 10, 20));
    const active = f.store.getState().linkedSelection;
    const issuedCount = f.issued.length;

    f.store.getState().setLinkedSelection(range(f, 10, 20));

    expect(f.store.getState().linkedSelection).toBe(active);
    expect(f.issued).toHaveLength(issuedCount);
  });

  it('clearing drops overlays without reissuing the full-corpus match set or resident baselines', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const baseTrend = f.trends().filter((t) => !t.cancelled).at(-1)!;
    baseTrend.resolve({ op: 'trend', trend: fakeTrend(5) });
    await flush();
    const matches = f.kwics().filter((query) => !query.cancelled).at(-1)!;
    const matchesCount = f.kwics().length;
    f.store.getState().setLinkedSelection(range(f, 3, 9));
    const trendCount = f.trends().length;
    f.store.getState().setLinkedSelection(null);
    expect(f.store.getState().selectedTrends.size).toBe(0);
    expect(f.store.getState().selectedDispersion).toBeNull();
    expect(f.trends().length).toBe(trendCount); // NO baseline trend reissue
    expect(f.store.getState().trends.get(f.store.getState().series[0]!.id)!.status).toBe('ready'); // resident evidence stands
    expect(f.kwics()).toHaveLength(matchesCount);
    expect(matches.cancelled).toBe(false);
    const issuedCount = f.issued.length;
    f.store.getState().setLinkedSelection(null);
    expect(f.issued).toHaveLength(issuedCount);
  });

  it('scopes range-aware detail consumers, but never Matches, to every explicit range', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b', 'c']);
    f.store.getState().mergeStarterTerms('holmes');
    const ranges = [
      { doc: 'a', tokens: { start: 8, end: 10 } },
      { doc: 'b', tokens: { start: 0, end: 20 } },
      { doc: 'c', tokens: { start: 0, end: 3 } },
    ];
    const matches = f.kwics().filter((query) => !query.cancelled).at(-1)!;
    const matchesCount = f.kwics().length;
    f.store.getState().setLinkedSelection({ snapshot: 's1', ranges });
    for (const issued of [
      f.trends().filter((query) => !query.cancelled).at(-1)!,
      f.inventories().at(-1)!,
      f.frequencies().at(-1)!,
    ]) {
      expect((issued.query as { selection: unknown }).selection).toEqual({
        docs: ['a', 'b', 'c'],
        ranges,
      });
    }
    expect(f.kwics()).toHaveLength(matchesCount);
    expect((matches.query as { selection?: unknown }).selection).toBeUndefined();
    f.store.getState().centerKwicAt(f.store.getState().series[0]!.id, 'b', 10);
    expect(f.store.getState().linkedSelection).not.toBeNull();
    f.store.getState().centerKwicAt(f.store.getState().series[0]!.id, 'b', 25);
    expect(f.store.getState().linkedSelection).not.toBeNull();
  });

  it('keeps cross-book analysis active as transient linked scope', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const selection = {
      snapshot: 's1',
      ranges: [
        { doc: 'a', tokens: { start: 8, end: 10 } },
        { doc: 'b', tokens: { start: 0, end: 3 } },
      ],
    };
    f.store.getState().setLinkedSelection(selection);
    expect(f.store.getState().linkedSelection).toEqual(selection);
  });

  it('a snapshot replacement clears the (snapshot-bound) selection with its overlays', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().setLinkedSelection(range(f, 1, 4));
    expect(f.store.getState().linkedSelection).not.toBeNull();
    f.port.publishSnapshot('g1', 's2', ['a']);
    expect(f.store.getState().linkedSelection).toBeNull();
    expect(f.store.getState().selectedTrends.size).toBe(0);
    expect(f.store.getState().selectedDispersion).toBeNull();
  });

  it('rapid A→B range replacement does not supersede the independent Matches window', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const matches = f.kwics().filter((x) => !x.cancelled).at(-1)!;
    const count = f.kwics().length;
    f.store.getState().setLinkedSelection(range(f, 0, 5));
    f.store.getState().setLinkedSelection(range(f, 50, 60));
    expect(f.kwics()).toHaveLength(count);
    expect(matches.cancelled).toBe(false);
    matches.resolve(fakeMatches(9));
    await flush();
    expect(f.store.getState().kwic!.state.status).toBe('ready');
  });

  it('late selected trend/dispersion results cannot land after A→B or after deactivating the last series', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const sid = f.store.getState().series[0]!.id;
    f.store.getState().setLinkedSelection(range(f, 0, 5));
    const selectionStart = (q: { query: unknown }) =>
      (q.query as { selection?: { ranges?: { tokens: { start: number } }[] } })
        .selection?.ranges?.[0]?.tokens.start;
    const staleTrend = f.trends().filter((q) => selectionStart(q) === 0).at(-1)!;
    const staleDispersion = f.issued
      .filter((q) => q.op === 'dispersion' && selectionStart(q) === 0)
      .at(-1)!;

    f.store.getState().setLinkedSelection(range(f, 50, 60));
    staleTrend.resolve({ op: 'trend', trend: fakeTrend(99) });
    staleDispersion.resolve({
      op: 'dispersion',
      dispersion: { method: 'dispersion/1', geometry: null, tracks: [] },
    });
    await flush();
    expect(f.store.getState().selectedTrends.get(sid)!.status).toBe('pending');
    expect(f.store.getState().selectedDispersion!.state.status).toBe('pending');

    const pendingTrend = f.trends().filter((q) => selectionStart(q) === 50).at(-1)!;
    const pendingDispersion = f.issued
      .filter((q) => q.op === 'dispersion' && selectionStart(q) === 50)
      .at(-1)!;
    f.store.getState().setGroupActive(sid, false);
    expect(f.store.getState().notebook.groups.some((group) => group.id === sid)).toBe(true);
    expect(pendingTrend.cancelled).toBe(true);
    expect(pendingDispersion.cancelled).toBe(true);
    expect(f.store.getState().selectedTrends.size).toBe(0);
    expect(f.store.getState().selectedDispersion).toBeNull();
    pendingTrend.resolve({ op: 'trend', trend: fakeTrend(101) });
    pendingDispersion.resolve({
      op: 'dispersion',
      dispersion: { method: 'dispersion/1', geometry: null, tracks: [] },
    });
    await flush();
    expect(f.store.getState().selectedTrends.size).toBe(0);
    expect(f.store.getState().selectedDispersion).toBeNull();
  });

  it('exact Matches activation preserves the independent linked range inside or outside it', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const sid = f.store.getState().series[0]!.id;
    f.store.getState().setLinkedSelection(range(f, 10, 20));
    f.store.getState().centerKwicAt(sid, 'a', 15); // inside
    expect(f.store.getState().linkedSelection).not.toBeNull();
    f.store.getState().centerKwicAt(sid, 'a', 42); // outside is still independent
    expect(f.store.getState().linkedSelection).not.toBeNull();
    expect(f.store.getState().selectedTrends.size).toBeGreaterThan(0);
  });

  it('refuses a gesture from a superseded snapshot or a departed doc', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().setLinkedSelection({ snapshot: 'sX', ranges: [{ doc: 'a', tokens: { start: 0, end: 2 } }] });
    expect(f.store.getState().linkedSelection).toBeNull();
    f.store.getState().setLinkedSelection({ snapshot: 's1', ranges: [{ doc: 'zz', tokens: { start: 0, end: 2 } }] });
    expect(f.store.getState().linkedSelection).toBeNull();
  });
});

describe('reading position history intent', () => {
  it('settles drift without delaying the cursor and flushes it before a jump', () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().setScrub({ doc: 'a', token: 10 });
      expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 10 });
      expect(f.store.getState().positionHistory.entries).toEqual([]);
      vi.advanceTimersByTime(POSITION_HISTORY_SETTLE_MS);
      expect(f.store.getState().positionHistory.entries).toMatchObject([
        { doc: 'a', token: 10 },
      ]);

      f.store.getState().setScrub({ doc: 'a', token: 500 });
      vi.advanceTimersByTime(POSITION_HISTORY_SETTLE_MS / 2);
      f.store.getState().setScrub({ doc: 'a', token: 700 });
      f.store.getState().setScrub(
        { doc: 'a', token: 1_200 },
        { kind: 'jump', origin: 'find' },
      );
      expect(f.store.getState().positionHistory.entries).toMatchObject([
        { doc: 'a', token: 10 },
        { doc: 'a', token: 700 },
        { doc: 'a', token: 1_200, origin: 'find' },
      ]);
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('traverses and permits a small landing refinement without clearing forward', () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      for (const token of [0, 1_000, 2_000]) {
        f.store.getState().setScrub(
          { doc: 'a', token },
          { kind: 'jump', origin: 'occurrence' },
        );
      }
      expect(f.store.getState().stepPositionHistory(-1)).toEqual({ doc: 'a', token: 1_000 });
      f.store.getState().setScrub(
        { doc: 'a', token: 1_010 },
        { kind: 'drift', origin: 'reader' },
      );
      vi.advanceTimersByTime(POSITION_HISTORY_SETTLE_MS);
      expect(f.store.getState().positionHistory.entries.map((entry) => entry.token))
        .toEqual([0, 1_010, 2_000]);
      expect(f.store.getState().stepPositionHistory(1)).toEqual({ doc: 'a', token: 2_000 });
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the traversal landing contract when measured extents arrive', async () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      const inventory = f.inventories().at(-1)!;
      for (const token of [0, 5_000, 10_000]) {
        f.store.getState().setScrub(
          { doc: 'a', token },
          { kind: 'jump', origin: 'occurrence' },
        );
      }
      expect(f.store.getState().stepPositionHistory(-1)).toEqual({ doc: 'a', token: 5_000 });
      expect(f.store.getState().positionHistory.tail).toBe('settling');

      inventory.resolve(fakeInventoryResult(6_000, [{ doc: 'a', fullTokens: 6_000 }]));
      await Promise.resolve();
      await Promise.resolve();
      expect(f.store.getState().positionHistory.tail).toBe('settling');
      f.store.getState().setScrub({ doc: 'a', token: 5_500 });
      vi.advanceTimersByTime(POSITION_HISTORY_SETTLE_MS);
      expect(f.store.getState().positionHistory.entries.map((entry) => entry.token))
        .toEqual([0, 5_500, 5_999]);
      expect(f.store.getState().stepPositionHistory(1)).toEqual({ doc: 'a', token: 5_999 });
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the shared cursor and settled history when the last term is deactivated', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    for (const token of [0, 1_000, 2_000]) {
      f.store.getState().setScrub(
        { doc: 'a', token },
        { kind: 'jump', origin: 'occurrence' },
      );
    }
    f.store.getState().setScrub({ doc: 'a', token: 3_000 });
    const group = f.store.getState().notebook.groups[0]!;
    f.store.getState().setGroupActive(group.id, false);

    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 3_000 });
    expect(f.store.getState().positionHistory.entries.map((entry) => entry.token))
      .toEqual([0, 1_000, 2_000, 3_000]);
    expect(f.store.getState().stepPositionHistory(-1)).toEqual({ doc: 'a', token: 2_000 });
    expect(f.store.getState().stepPositionHistory(1)).toEqual({ doc: 'a', token: 3_000 });
    f.runtime.dispose();
  });

  it('preserves an unsettled scrub departure when a barcode jump follows', () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().mergeStarterTerms('holmes');
      const seriesId = f.store.getState().series[0]!.id;
      f.store.getState().setScrub({ doc: 'a', token: 40_000 });
      f.store.getState().centerKwicAt(
        seriesId,
        'a',
        90_000,
        { kind: 'bucket', count: 1 },
      );
      expect(f.store.getState().positionHistory.entries).toMatchObject([
        { doc: 'a', token: 40_000 },
        { doc: 'a', token: 90_000, origin: 'barcode' },
      ]);
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retargets an open Reader without closing its governed browser-history layer', () => {
    const q = fakeQueryClient();
    const history = new FakeHistoryPort('/textTrends/?p=trends');
    const runtime = createAppRuntime(q.client, { history, newLayerId: layerIds() });
    const port = new FakeSessionPort();
    runtime.attachSession(port);
    port.publishSnapshot('g1', 's1', ['a']);
    runtime.useApp.getState().setScrub(
      { doc: 'a', token: 100 },
      { kind: 'jump', origin: 'seek' },
    );
    runtime.useApp.getState().openReader({
      snapshot: 's1', doc: 'a', token: 1_000, from: 'kwic', anchor: 'occurrence',
    });
    const browserEntries = history.entries.length;
    const layerId = runtime.useApp.getState().layers.at(-1)?.id;

    expect(runtime.useApp.getState().stepPositionHistory(-1))
      .toEqual({ doc: 'a', token: 100 });
    expect(runtime.useApp.getState()).toMatchObject({
      readerPlace: { doc: 'a', cursor: { kind: 'around', token: 100 } },
      layers: [{ id: layerId, kind: 'reader' }],
    });
    expect(history.entries).toHaveLength(browserEntries);
    expect(runtime.useApp.getState().stepPositionHistory(1))
      .toEqual({ doc: 'a', token: 1_000 });
    expect(runtime.useApp.getState().readerPlace).toMatchObject({
      cursor: { kind: 'around', token: 1_000 },
    });
    runtime.dispose();
  });

  it('moves the shared cursor on Reader entry and maps Reader origins into history', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 100, from: 'kwic', anchor: 'occurrence',
    });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 100 });
    expect(f.store.getState().positionHistory.entries.at(-1)).toMatchObject({
      token: 100, origin: 'matches',
    });

    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 1_000, from: 'footer', anchor: 'position',
    });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 1_000 });
    expect(f.store.getState().positionHistory.entries.at(-1)).toMatchObject({
      token: 1_000, origin: 'seek',
    });

    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 2_000, from: 'occurrence', anchor: 'occurrence',
    });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 2_000 });
    expect(f.store.getState().positionHistory.entries.at(-1)).toMatchObject({
      token: 2_000, origin: 'occurrence',
    });
    f.runtime.dispose();
  });

  it('reconciles surviving positions through the real null-to-replacement publication sequence', () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a', 'b']);
      f.store.setState({ corpusTokenCounts: new Map([['a', 500], ['b', 300]]) });
      f.store.getState().setScrub(
        { doc: 'a', token: 100 },
        { kind: 'jump', origin: 'seek' },
      );
      f.store.getState().setScrub(
        { doc: 'b', token: 250 },
        { kind: 'jump', origin: 'barcode' },
      );
      f.store.getState().setScrub({ doc: 'b', token: 275 });

      f.port.emit(sessionState(null));
      expect(f.store.getState().positionHistory).toBe(EMPTY_POSITION_HISTORY);
      f.port.publishSnapshot('g2', 's2', ['b']);
      expect(f.store.getState().positionHistory).toMatchObject({
        index: 0,
        entries: [{ snapshot: 's2', doc: 'b', token: 275 }],
      });
      vi.advanceTimersByTime(POSITION_HISTORY_SETTLE_MS);
      expect(f.store.getState().positionHistory.entries).toHaveLength(1);
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not carry pending positions into a different project', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setScrub(
      { doc: 'a', token: 100 },
      { kind: 'jump', origin: 'seek' },
    );
    f.port.emit(sessionState(null, { project: { id: 'library/other' } }));
    f.port.emit(sessionState(snap('g2', 's2', ['a']), {
      project: { id: 'library/other' },
    }));
    expect(f.store.getState().positionHistory).toBe(EMPTY_POSITION_HISTORY);
    f.runtime.dispose();
  });

  it('clears a pending settle timer when the runtime is disposed', () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().setScrub({ doc: 'a', token: 100 });
      f.runtime.dispose();
      vi.advanceTimersByTime(POSITION_HISTORY_SETTLE_MS);
      expect(f.store.getState().positionHistory.entries).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('browser History API exhaustion', () => {
  it('publishes place and Reader layers and closes locally after a throttled push', () => {
    const history = new FakeHistoryPort('/textTrends/?p=trends');
    const f = harness(undefined, { history });
    f.port.publishSnapshot('g1', 's1', ['a']);
    history.push = () => { throw new DOMException('rate limit', 'SecurityError'); };
    f.store.getState().setPlace('matches');
    expect(f.store.getState().place).toBe('matches');
    f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 1, from: 'kwic', anchor: 'position' });
    expect(f.store.getState().readerPlace?.doc).toBe('a');
    f.store.getState().closeReader();
    expect(f.store.getState().readerPlace).toBeNull();
    expect(history.backs).toBe(0);
    f.runtime.dispose();
  });

  it('survives a throttled initialization replace without hiding unrelated failures', () => {
    const history = new FakeHistoryPort('/textTrends/?p=trends');
    history.replace = () => { throw new DOMException('rate limit', 'SecurityError'); };
    const f = harness(undefined, { history });
    f.store.getState().replacePlace('matches');
    expect(f.store.getState().place).toBe('matches');
    f.runtime.dispose();
    history.replace = () => { throw new Error('broken port'); };
    expect(() => harness(undefined, { history })).toThrow('broken port');
  });
});
