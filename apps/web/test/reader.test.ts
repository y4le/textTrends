/** reader behavior through the live application runtime. */

import { describe, expect, it } from 'vitest';
import {
  createAppRuntime,

} from '../src/lib/store.ts';

import { workspaceSemanticKey } from '../src/lib/workspace-state.ts';

import type { ProjectView } from '../src/lib/project-session.ts';

import { coreGroupOf } from '../src/lib/notebook.ts';

import { fakeQueryClient, FakeHistoryPort, layerIds, LIBRARY_PROJECT, snap, sessionState, FakeSessionPort, fakeReaderPage, harness, editTerm, flush } from './support/runtime-harness.ts';

describe('latest-wins full reader intent', () => {
  const setup = () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    return f;
  };

  it('latches live-seek bounds and coalesces history without rewriting browser state', async () => {
    const history = new FakeHistoryPort('/textTrends/?p=matches');
    const f = harness(undefined, { history });
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 4, from: 'kwic', anchor: 'occurrence',
    });
    f.readers().at(-1)!.resolve(fakeReaderPage(0, 200, 200_000, 'a', 4));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 0, end: 100 }, geometry: 'test',
    });
    const replacesBefore = history.replaces;
    const issuedBefore = f.readers().length;

    f.store.getState().seekReader(20_000, 'start');
    f.store.getState().seekReader(40_000, 'preview');
    f.store.getState().seekReader(60_000, 'commit');

    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 60_000 });
    expect(f.readers()).toHaveLength(issuedBefore + 3);
    expect(history.replaces).toBe(replacesBefore);
    expect(f.store.getState().positionHistory.entries.map((entry) => entry.token))
      .toEqual([4, 60_000]);
    f.runtime.dispose();
  });

  it('clears a rejected live-seek commit before the next independent jump', async () => {
    const f = setup();
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 4, from: 'kwic', anchor: 'occurrence',
    });
    f.readers().at(-1)!.resolve(fakeReaderPage(0, 200, 200_000, 'a', 4));
    await flush();

    f.store.getState().seekReader(20_000, 'start');
    f.store.setState({ readerScale: 'atlas', scrub: { doc: 'a', token: 1_200 } });
    f.store.getState().seekReader(30_000, 'commit');
    f.store.setState({
      readerScale: 'read',
      corpusTokenCounts: new Map([['a', 200_000]]),
    });
    f.store.getState().seekReader(40_000, 'commit');

    expect(f.store.getState().positionHistory.entries.slice(-2)).toMatchObject([
      { doc: 'a', token: 1_200 },
      { doc: 'a', token: 40_000, origin: 'seek' },
    ]);
    f.runtime.dispose();
  });

  it('keeps scale transient, makes Atlas query-free, and restores resident Read', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 3, from: 'footer', anchor: 'position',
    });
    const pending = f.readers().at(-1)!;
    const beforeAtlas = f.readers().length;

    f.store.getState().setReaderScale('atlas');
    expect(pending.cancelled).toBe(true);
    expect(f.store.getState()).toMatchObject({
      readerScale: 'atlas',
      readerPlace: { anchor: 'position' },
    });
    f.store.getState().setAtlasNormalization('to-scale');
    f.store.getState().enterRsvp(true);
    f.store.getState().runReader();
    expect(f.store.getState().atlasNormalization).toBe('to-scale');
    expect(f.store.getState().interaction.kind).not.toBe('rsvp');
    expect(f.readers()).toHaveLength(beforeAtlas);

    f.store.getState().setReaderScale('read');
    expect(f.readers()).toHaveLength(beforeAtlas + 1);
    f.readers().at(-1)!.resolve(fakeReaderPage(0, 6, 12, 'a', 3));
    await flush();
    const residentCount = f.readers().length;
    f.store.getState().setReaderScale('atlas');
    const group = f.store.getState().notebook.groups[0]!;
    editTerm(f.store.getState(), group.id, { displayName: 'Detective' });
    f.store.getState().setReaderScale('read');
    expect(f.readers()).toHaveLength(residentCount);

    f.store.getState().setReaderScale('atlas');
    f.store.getState().enterFind();
    f.store.getState().submitFind('watson');
    const beforeFindReturn = f.readers().length;
    f.store.getState().setReaderScale('read');
    const find = f.store.getState().interaction;
    if (find.kind !== 'find' || find.find === null) throw new Error('Find did not start');
    expect(f.store.getState()).toMatchObject({
      readerScale: 'read',
      readerPlace: { anchor: 'position' },
    });
    expect(f.readers()).toHaveLength(beforeFindReturn + 1);
    expect((f.readers().at(-1)!.query as { tracks: { seriesId: string }[] }).tracks)
      .toEqual([{ seriesId: find.find.query.seriesId, group: find.find.query.group }]);

    f.store.getState().setReaderScale('atlas');
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 4, from: 'kwic', anchor: 'occurrence',
    });
    expect(f.store.getState()).toMatchObject({
      readerScale: 'read',
      readerPlace: { anchor: 'occurrence' },
    });
    f.runtime.dispose();
  });

  it('does not expose Atlas for one text', () => {
    const f = setup();
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 3, from: 'kwic', anchor: 'occurrence',
    });
    f.store.getState().setReaderScale('atlas');
    expect(f.store.getState().readerScale).toBe('read');
    f.runtime.dispose();
  });

  it('commits Atlas positions query-free and descends with the evidence claim', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.setState({ corpusTokenCounts: new Map([['a', 100], ['b', 50]]) });
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 10, from: 'footer', anchor: 'position',
    });
    f.store.getState().setReaderScale('atlas');
    const fullReaders = () => f.readers().filter((entry) => (
      entry.query as { request: { maxTokens: number } }
    ).request.maxTokens === 4_096);
    const before = fullReaders().length;

    f.store.getState().selectAtlasPosition({ doc: 'b', token: 20 }, 'position');
    expect(f.store.getState()).toMatchObject({
      readerScale: 'atlas',
      scrub: { doc: 'b', token: 20 },
      readerPlace: {
        doc: 'b', anchor: 'position', cursor: { kind: 'around', token: 20 },
      },
    });
    expect(fullReaders()).toHaveLength(before);

    f.store.getState().selectAtlasPosition({ doc: 'b', token: 21 }, 'occurrence', true);
    expect(f.store.getState()).toMatchObject({
      readerScale: 'read',
      scrub: { doc: 'b', token: 21 },
      readerPlace: {
        doc: 'b', anchor: 'occurrence', cursor: { kind: 'around', token: 21 },
      },
    });
    expect(fullReaders()).toHaveLength(before + 1);
    f.runtime.dispose();
  });

  it('preserves Atlas while position history retargets the existing layer', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 10, from: 'footer', anchor: 'position',
    });
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 200, from: 'kwic', anchor: 'occurrence',
    });
    f.store.getState().setReaderScale('atlas');
    const readerCount = f.readers().filter((entry) => (
      entry.query as { request: { maxTokens: number } }
    ).request.maxTokens === 4_096).length;

    expect(f.store.getState().stepPositionHistory(-1)).toEqual({ doc: 'a', token: 10 });
    expect(f.store.getState()).toMatchObject({
      readerScale: 'atlas',
      readerPlace: {
        doc: 'a',
        anchor: 'position',
        cursor: { kind: 'around', token: 10 },
      },
    });
    expect(f.store.getState().layers.filter((layer) => layer.kind === 'reader')).toHaveLength(1);
    expect(f.readers().filter((entry) => (
      entry.query as { request: { maxTokens: number } }
    ).request.maxTokens === 4_096).length).toBe(readerCount);
    f.runtime.dispose();
  });

  it('keeps the full reader query-free and bound to one restorable layer', async () => {
    const q = fakeQueryClient();
    const history = new FakeHistoryPort('/textTrends/?p=trends');
    const runtime = createAppRuntime(q.client, {
      history,
      newLayerId: layerIds(),
    });
    const port = new FakeSessionPort();
    runtime.attachSession(port);
    port.publishSnapshot('g1', 's1', ['a']);
    runtime.useApp.getState().mergeStarterTerms('holmes');
    runtime.useApp.getState().openReader({
      snapshot: 's1',
      doc: 'a',
      token: 1,
      from: 'kwic',
      anchor: 'occurrence',
    });
    const request = q.readers().at(-1)!;
    request.resolve(fakeReaderPage(0, 4));
    await flush();

    const store = runtime.useApp;
    const semantic = workspaceSemanticKey(store.getState());
    const serialized = structuredClone(history.state);
    const url = history.url;
    const issued = q.issued.length;
    const page = store.getState().readerPage;
    const navigation = store.getState().readerNavigation;
    const pushes = history.pushes;

    expect(store.getState()).toMatchObject({ readerPage: page, readerNavigation: navigation });
    expect(store.getState().readerPlace).not.toBeNull();
    expect(workspaceSemanticKey(store.getState())).toBe(semantic);
    expect(q.issued).toHaveLength(issued);
    expect(history.pushes).toBe(pushes);
    expect(history.state).toEqual(serialized);
    expect(history.url).toBe(url);

    store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 2, end: 4 }, geometry: '800x600',
    });
    expect(store.getState().scrub).toEqual({ doc: 'a', token: 2 });
    const readerRequestsBeforeClose = q.readers().length;
    store.getState().closeReader();
    expect(store.getState().readerPlace).toBeNull();
    expect(q.readers()).toHaveLength(readerRequestsBeforeClose + 1);
    expect((q.readers().at(-1)!.query as {
      request: { cursor: { token: number } };
    }).request.cursor.token).toBe(2);
    history.forward();
    expect(store.getState().layers.at(-1)?.kind).toBe('reader');

    store.getState().closeReader();
    store.getState().openReader({
      snapshot: 's1',
      doc: 'a',
      token: 2,
      from: 'barcode',
      anchor: 'occurrence',
    });
    runtime.dispose();
  });

  it('governs open, replace, Back, Forward, and place departure with one reader layer', () => {
    const q = fakeQueryClient();
    const history = new FakeHistoryPort('/textTrends/?p=trends');
    const runtime = createAppRuntime(q.client, {
      history,
      newLayerId: layerIds(),
    });
    const port = new FakeSessionPort();
    runtime.attachSession(port);
    port.publishSnapshot('g1', 's1', ['a']);
    const store = runtime.useApp;

    store.getState().openReader(
      { snapshot: 's1', doc: 'a', token: 1, from: 'kwic', anchor: 'occurrence' },
      'reader-origin',
    );
    expect(store.getState()).toMatchObject({
      readerPlace: { doc: 'a', cursor: { kind: 'around', token: 1 } },
      layers: [{ kind: 'reader', returnFocusTo: 'reader-origin' }],
    });
    expect(history.entries).toHaveLength(2);
    expect(history.url).toBe('/textTrends/?p=trends');
    const firstLayer = store.getState().layers[0]!.id;

    store.getState().openReader(
      { snapshot: 's1', doc: 'a', token: 2, from: 'barcode', anchor: 'occurrence' },
      'second-reader-origin',
    );
    expect(history.entries).toHaveLength(2);
    expect(store.getState().layers).toHaveLength(1);
    expect(store.getState().layers[0]!.id).not.toBe(firstLayer);
    expect(store.getState().readerPlace).toMatchObject({
      from: 'barcode',
      cursor: { kind: 'around', token: 2 },
    });

    store.getState().closeReader();
    expect(store.getState()).toMatchObject({
      readerPlace: null,
      layers: [],
    });
    history.forward();
    expect(store.getState()).toMatchObject({
      readerPlace: { from: 'barcode', cursor: { kind: 'around', token: 2 } },
      layers: [{ kind: 'reader' }],
    });

    store.getState().setPlace('inputs');
    expect(store.getState()).toMatchObject({
      place: 'inputs',
      readerPlace: null,
      layers: [{ kind: 'place' }],
    });
    runtime.dispose();
  });

  it('snapshot invalidation consumes the reader entry without traversing history', () => {
    const q = fakeQueryClient();
    const history = new FakeHistoryPort('/textTrends/?p=trends');
    const runtime = createAppRuntime(q.client, {
      history,
      newLayerId: layerIds(),
    });
    const port = new FakeSessionPort();
    runtime.attachSession(port);
    port.publishSnapshot('g1', 's1', ['a']);
    runtime.useApp.getState().openReader({
      snapshot: 's1',
      doc: 'a',
      token: 1,
      from: 'kwic',
      anchor: 'occurrence',
    });
    const backs = history.backs;
    const replaces = history.replaces;

    port.publishSnapshot('g1', 's2', ['a']);
    expect(history.backs).toBe(backs);
    expect(history.replaces).toBe(replaces + 1);
    expect(history.url).toBe('/textTrends/?p=trends');
    expect(runtime.useApp.getState()).toMatchObject({
      readerPlace: null,
      layers: [],
    });
    runtime.dispose();
  });

  it('opens one directional source slice under the current snapshot and captured track semantics', async () => {
    const f = setup();
    f.store.getState().openReader({
      snapshot: 's1',
      doc: 'a',
      token: 3,
      from: 'kwic',
      anchor: 'occurrence',
    });
    const request = f.readers().at(-1)!;
    const query = request.query as {
      tracks: { seriesId: string; group: { id: string } }[];
      request: { method: string; doc: string; cursor: unknown; maxTokens: number };
      selection?: unknown;
    };
    expect(query.selection).toBeUndefined();
    expect(query.request).toEqual({
      method: 'reader-page/1',
      doc: 'a',
      cursor: { kind: 'around', token: 3 },
      maxTokens: 4_096,
    });
    expect(query.tracks).toHaveLength(1);
    expect(f.store.getState().readerPage).toEqual(expect.objectContaining({
      snapshot: 's1',
      place: expect.objectContaining({ doc: 'a', from: 'kwic' }),
      state: { status: 'pending' },
    }));
    request.resolve(fakeReaderPage(0, 4));
    await flush();
    const reader = f.store.getState().readerPage!;
    expect(reader.state.status).toBe('ready');
    if (reader.state.status === 'ready') expect(reader.state.page.tokens).toEqual({ start: 0, end: 4 });
  });

  it('uses fitted visible boundaries and remembers exact previous pages at one geometry', async () => {
    const f = setup();
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 40, from: 'barcode', anchor: 'occurrence',
    });
    f.readers().at(-1)!.resolve(fakeReaderPage(0, 200, 500));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 20, end: 60 }, geometry: '800x600',
    });
    expect(f.store.getState()).toMatchObject({
      scrub: { doc: 'a', token: 40 },
      readerVisibleRange: { tokens: { start: 20, end: 60 } },
      readerNavigation: {
        previous: { doc: 'a', cursor: { kind: 'before', token: 20 } },
        next: { doc: 'a', cursor: { kind: 'from', token: 60 } },
      },
    });

    f.store.getState().navigateReader({ kind: 'from', token: 60 });
    f.readers().at(-1)!.resolve(fakeReaderPage(60, 260, 500));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 60, end: 105 }, geometry: '800x600',
    });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 60 });
    expect(f.store.getState().readerNavigation?.previous)
      .toEqual({ doc: 'a', cursor: { kind: 'from', token: 20 } });

    f.store.getState().navigateReader({ kind: 'from', token: 20 });
    f.readers().at(-1)!.resolve(fakeReaderPage(20, 220, 500));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 20, end: 60 }, geometry: '800x600',
    });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 20 });
    expect(f.store.getState().readerNavigation?.next)
      .toEqual({ doc: 'a', cursor: { kind: 'from', token: 60 } });

    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 20, end: 52 }, geometry: '390x700',
    });
    expect(f.store.getState().readerNavigation?.previous)
      .toEqual({ doc: 'a', cursor: { kind: 'before', token: 20 } });
  });

  it('publishes a prose-picked cursor without querying and preserves it only while visible', async () => {
    const f = setup();
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 40, from: 'barcode', anchor: 'occurrence',
    });
    f.readers().at(-1)!.resolve(fakeReaderPage(0, 200, 500));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 20, end: 60 }, geometry: '800x600',
    });
    const issued = f.issued.length;

    f.store.getState().setReadingCursor(48);
    expect(f.store.getState()).toMatchObject({
      scrub: { doc: 'a', token: 48 },
      readerCursorToken: 48,
      readerVisibleRange: { tokens: { start: 20, end: 60 } },
    });
    expect(f.issued).toHaveLength(issued);

    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 20, end: 52 }, geometry: '390x700',
    });
    expect(f.store.getState()).toMatchObject({
      scrub: { doc: 'a', token: 48 },
      readerCursorToken: 48,
    });

    f.store.getState().setReadingCursor(60);
    expect(f.store.getState().readerCursorToken).toBe(48);
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 60, end: 100 }, geometry: '390x700',
    });
    expect(f.store.getState()).toMatchObject({
      scrub: { doc: 'a', token: 60 },
      readerCursorToken: null,
    });
    expect(f.issued).toHaveLength(issued);
    f.runtime.dispose();
  });

  it('preserves a prose-picked cursor through a query-free Atlas round trip', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 40, from: 'barcode', anchor: 'occurrence',
    });
    f.readers().at(-1)!.resolve(fakeReaderPage(0, 200, 500));
    await flush();
    const visible = {
      snapshot: 's1', doc: 'a', tokens: { start: 20, end: 60 }, geometry: '800x600',
    } as const;
    f.store.getState().setReaderVisibleRange(visible);
    f.store.getState().setReadingCursor(48);
    const history = f.store.getState().positionHistory;
    const issued = f.issued.length;

    f.store.getState().setReaderScale('atlas');
    expect(f.store.getState()).toMatchObject({
      readerScale: 'atlas',
      scrub: { doc: 'a', token: 48 },
      readerCursorToken: 48,
    });
    f.store.getState().setReaderScale('read');
    f.store.getState().setReaderVisibleRange(visible);
    expect(f.store.getState()).toMatchObject({
      readerScale: 'read',
      scrub: { doc: 'a', token: 48 },
      readerCursorToken: 48,
      positionHistory: history,
    });
    expect(f.issued).toHaveLength(issued);
    f.runtime.dispose();
  });

  it('rolls fitted page navigation across nonempty texts in declared corpus order', async () => {
    const project: ProjectView = {
      ...LIBRARY_PROJECT,
      data: { ...LIBRARY_PROJECT.data, order: ['a', 'empty', 'b'] },
    };
    const f = harness(sessionState(snap('g1', 's1', ['b', 'empty', 'a']), { project }));
    f.store.setState({
      corpusTokenCounts: new Map([['a', 4], ['empty', 0], ['b', 6]]),
    });
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().openReader({
      snapshot: 's1', doc: 'b', token: 2, from: 'barcode', anchor: 'occurrence',
    });
    f.readers().at(-1)!.resolve(fakeReaderPage(0, 6, 6, 'b'));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'b', tokens: { start: 0, end: 6 }, geometry: 'test',
    });

    expect(f.store.getState().readerNavigation).toEqual({
      previous: { doc: 'a', cursor: { kind: 'before', token: 4 } },
      next: null,
    });
    f.store.getState().navigateReader(f.store.getState().readerNavigation!.previous!);
    expect((f.readers().at(-1)!.query as {
      request: { doc: string; cursor: unknown };
    }).request).toEqual({
      method: 'reader-page/1',
      doc: 'a',
      cursor: { kind: 'before', token: 4 },
      maxTokens: 4_096,
    });
    f.readers().at(-1)!.resolve(fakeReaderPage(0, 4, 4, 'a'));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 0, end: 4 }, geometry: 'test',
    });

    expect(f.store.getState().readerNavigation).toEqual({
      previous: null,
      next: { doc: 'b', cursor: { kind: 'from', token: 0 } },
    });
    f.store.getState().navigateReader(f.store.getState().readerNavigation!.next!);
    expect((f.readers().at(-1)!.query as {
      request: { doc: string; cursor: unknown };
    }).request).toMatchObject({
      doc: 'b',
      cursor: { kind: 'from', token: 0 },
    });
    expect(f.store.getState().layers.filter((layer) => layer.kind === 'reader')).toHaveLength(1);
    f.runtime.dispose();
  });

  it('steps texts at relative position and preserves Atlas', () => {
    const project: ProjectView = {
      ...LIBRARY_PROJECT,
      data: { ...LIBRARY_PROJECT.data, order: ['a', 'empty', 'b'] },
    };
    const f = harness(sessionState(snap('g1', 's1', ['b', 'empty', 'a']), { project }));
    f.store.setState({
      corpusTokenCounts: new Map([['a', 101], ['empty', 0], ['b', 11]]),
    });
    f.store.getState().mergeStarterTerms('holmes');
    f.store.getState().openReader({
      snapshot: 's1', doc: 'b', token: 5, from: 'footer', anchor: 'position',
    });

    expect(f.store.getState().stepReaderDocument(-1)).toEqual({ doc: 'a', token: 50 });
    expect(f.store.getState()).toMatchObject({
      scrub: { doc: 'a', token: 50 },
      readerPlace: {
        doc: 'a',
        anchor: 'position',
        cursor: { kind: 'around', token: 50 },
      },
    });
    expect((f.readers().filter((entry) => (
      entry.query as { request: { maxTokens: number } }
    ).request.maxTokens === 4_096).at(-1)!.query as {
      request: { doc: string; cursor: unknown };
    }).request).toMatchObject({ doc: 'a', cursor: { kind: 'around', token: 50 } });

    f.store.getState().setReaderScale('atlas');
    const fullReaderCount = f.readers().filter((entry) => (
      entry.query as { request: { maxTokens: number } }
    ).request.maxTokens === 4_096).length;
    expect(f.store.getState().stepReaderDocument(1)).toEqual({ doc: 'b', token: 5 });
    expect(f.store.getState()).toMatchObject({
      readerScale: 'atlas',
      readerPlace: { doc: 'b', anchor: 'position' },
    });
    expect(f.readers().filter((entry) => (
      entry.query as { request: { maxTokens: number } }
    ).request.maxTokens === 4_096).length).toBe(fullReaderCount);
    expect(f.store.getState().stepReaderDocument(1)).toBeNull();
    f.runtime.dispose();
  });

  it('can refill a saturated fitted page only from its authenticated visible start', async () => {
    const f = setup();
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 40, from: 'barcode', anchor: 'occurrence',
    });
    f.readers().at(-1)!.resolve(fakeReaderPage(0, 200, 500));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 20, end: 60 }, geometry: '800x600',
    });
    const before = f.readers().length;
    f.store.getState().refitReaderAt(21);
    expect(f.readers()).toHaveLength(before);
    f.store.getState().refitReaderAt(20);
    expect(f.readers()).toHaveLength(before + 1);
    expect((f.readers().at(-1)!.query as { request: { cursor: unknown } }).request.cursor)
      .toEqual({ kind: 'from', token: 20 });
  });

  it('rapid cursor replacements cancel and reject an older page that arrives last', async () => {
    const f = setup();
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 5, from: 'barcode', anchor: 'occurrence',
    });
    const around = f.readers().at(-1)!;
    around.resolve(fakeReaderPage(4, 8));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 4, end: 8 }, geometry: 'test',
    });

    f.store.getState().navigateReader({ kind: 'from', token: 8 });
    const next = f.readers().at(-1)!;
    const countAfterNext = f.readers().length;
    f.store.getState().navigateReader({ kind: 'from', token: 8 });
    expect(f.readers()).toHaveLength(countAfterNext); // same pending cursor is inert
    f.store.getState().navigateReader({ kind: 'before', token: 4 });
    const previous = f.readers().at(-1)!;
    expect(next.cancelled).toBe(true);
    expect(f.store.getState().readerPage?.state.status).toBe('pending');
    next.resolve(fakeReaderPage(8, 10));
    await flush();
    expect(f.store.getState().readerPage?.state.status).toBe('pending');
    previous.resolve(fakeReaderPage(0, 4));
    await flush();
    const reader = f.store.getState().readerPage!;
    expect(reader.place.cursor).toEqual({ kind: 'before', token: 4 });
    if (reader.state.status !== 'ready') throw new Error('reader did not settle');
    expect(reader.state.page.tokens).toEqual({ start: 0, end: 4 });
  });

  it('admits explicit first/last-book cursors only against a ready authenticated page', async () => {
    const f = setup();
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 5, from: 'barcode', anchor: 'occurrence',
    });
    const pendingCount = f.readers().length;
    f.store.getState().navigateReader({ kind: 'from', token: 0 });
    expect(f.readers()).toHaveLength(pendingCount);
    f.readers().at(-1)!.resolve(fakeReaderPage(4, 8));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 4, end: 8 }, geometry: 'test',
    });

    const readyCount = f.readers().length;
    f.store.getState().navigateReader({ kind: 'before', token: 9 });
    expect(f.readers()).toHaveLength(readyCount);
    f.store.getState().navigateReader({ kind: 'from', token: 0 });
    expect((f.readers().at(-1)!.query as { request: { cursor: unknown } }).request.cursor)
      .toEqual({ kind: 'from', token: 0 });
    f.readers().at(-1)!.resolve(fakeReaderPage(0, 4));
    await flush();

    f.store.getState().navigateReader({ kind: 'before', token: 10 });
    expect((f.readers().at(-1)!.query as { request: { cursor: unknown } }).request.cursor)
      .toEqual({ kind: 'before', token: 10 });
  });

  it('rename is presentation-only; semantic and active-track changes reissue highlights', () => {
    const f = setup();
    const group = f.store.getState().notebook.groups[0]!;
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 1, from: 'kwic', anchor: 'occurrence',
    });
    const first = f.readers().at(-1)!;
    const count = f.readers().length;

    editTerm(f.store.getState(), group.id, { displayName: 'Detective' });
    expect(f.readers()).toHaveLength(count);
    expect(first.cancelled).toBe(false);

    const member = coreGroupOf(group).members[0]!;
    if (member.kind !== 'token') throw new Error('quick-add must create a token member');
    editTerm(f.store.getState(), group.id, { aliases: ['watson'], countOverlaps: false });
    const edited = f.readers().at(-1)!;
    expect(first.cancelled).toBe(true);
    expect(edited).not.toBe(first);
    expect((edited.query as { tracks: { group: { members: { surface: string }[] } }[] })
      .tracks[0]!.group.members[0]!.surface).toBe('watson');

    f.store.getState().setGroupActive(group.id, false);
    const plain = f.readers().at(-1)!;
    expect(edited.cancelled).toBe(true);
    expect((plain.query as { tracks: unknown[] }).tracks).toEqual([]);
    expect(f.store.getState().readerPlace).not.toBeNull();
  });

  it('close/snapshot replacement/dispose cancel the lane and late pages cannot reopen it', async () => {
    const f = setup();
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 1, from: 'barcode', anchor: 'occurrence',
    });
    const closed = f.readers().at(-1)!;
    f.store.getState().closeReader();
    expect(closed.cancelled).toBe(true);
    closed.resolve(fakeReaderPage(0, 4));
    await flush();
    expect(f.store.getState().readerPlace).toBeNull();
    expect(f.store.getState().readerPage).toBeNull();

    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 2, from: 'kwic', anchor: 'occurrence',
    });
    const replaced = f.readers().at(-1)!;
    f.port.publishSnapshot('g1', 's2', ['a']);
    expect(replaced.cancelled).toBe(true);
    expect(f.store.getState().readerPlace).toBeNull();

    f.store.getState().openReader({
      snapshot: 's2', doc: 'a', token: 2, from: 'kwic', anchor: 'occurrence',
    });
    const disposed = f.readers().at(-1)!;
    f.runtime.dispose();
    expect(disposed.cancelled).toBe(true);
    disposed.resolve(fakeReaderPage(0, 4));
    await flush();
    expect(f.store.getState()).toMatchObject({
      readerPlace: null,
      readerPage: null,
      readerNavigation: null,
    });
    expect(f.store.getState().layers.some((layer) => layer.kind === 'reader')).toBe(false);
  });

  it('surfaces an impossible doc mismatch as an error instead of a permanent skeleton', async () => {
    const f = setup();
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 1, from: 'kwic', anchor: 'occurrence',
    });
    f.readers().at(-1)!.resolve(fakeReaderPage(0, 4, 10, 'wrong'));
    await flush();
    expect(f.store.getState().readerPage?.state).toEqual({
      status: 'error',
      message: 'reader returned the wrong document',
    });
  });
});

describe('Reader browser-history budget', () => {
  it('retargets a retained Reader layer 200 times without rewriting its browser entry', async () => {
    const history = new FakeHistoryPort('/textTrends/?p=matches');
    const f = harness(undefined, { history });
    f.port.publishSnapshot('g1', 's1', ['a']);
    const open = (token: number) => f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token, from: 'kwic', anchor: 'position',
    });
    open(0);
    f.readers().at(-1)!.resolve(fakeReaderPage(0, 200, 200_000, 'a', 0));
    await flush();
    const before = { pushes: history.pushes, replaces: history.replaces };
    for (let i = 0; i < 200; i++) {
      const token = 20_000 + i;
      f.store.getState().seekReader(token, 'commit');
      f.readers().at(-1)!.resolve(fakeReaderPage(token, token + 200, 200_000, 'a', token));
      await flush();
    }
    expect({ pushes: history.pushes, replaces: history.replaces }).toEqual(before);
    expect(f.store.getState().readerPlace?.cursor.token).toBe(20_199);
    expect(f.store.getState().layers.filter((layer) => layer.kind === 'reader')).toHaveLength(1);
    f.runtime.dispose();
  });
});
