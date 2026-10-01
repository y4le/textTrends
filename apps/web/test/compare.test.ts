/** compare behavior through the live application runtime. */

import { describe, expect, it } from 'vitest';

import { effectiveKeynessMinDocFreq, reconcileKeynessView } from '../src/lib/keyness-view.ts';

import { DEFAULT_KEYNESS_VIEW } from '../src/lib/app-defaults.ts';
import { workspaceSemanticKey } from '../src/lib/workspace-state.ts';

import type { SessionState } from '../src/lib/project-session.ts';

import { libraryProject } from '../src/lib/project.ts';

import { STOPLIST_EN_ID, STOPLIST_EN_VERSION, type WorkspaceV1 } from '@texttrends/core';
import { workspaceState } from './support/workspace-fixtures.ts';

import { COMPARE_MAX_RESIDENT_ROWS } from '../src/lib/compare-scroll.ts';

import { LIBRARY_PROJECT, snap, sessionState, fakeInventoryResult, fakeKeynessPage, harness, restoreFixture, flush } from './support/runtime-harness.ts';

describe('dueling keyness query intent', () => {
  it('forces only the one-text comparison and preserves an explicit multi-text choice', () => {
    const forced = reconcileKeynessView(DEFAULT_KEYNESS_VIEW, ['a']);
    expect(forced).toMatchObject({
      mode: 'selection-rest',
      documentA: 'a',
      documentB: null,
    });
    expect(reconcileKeynessView(forced, ['a', 'b']).mode).toBe('document-rest');

    const explicit = {
      ...DEFAULT_KEYNESS_VIEW,
      mode: 'selection-rest' as const,
      documentA: 'a',
      documentB: 'b',
    };
    expect(reconcileKeynessView(explicit, ['a', 'b'])).toBe(explicit);
  });

  it('clamps effective document range to the smaller side in every comparison mode', () => {
    expect(effectiveKeynessMinDocFreq(
      { ...DEFAULT_KEYNESS_VIEW, mode: 'selection-rest' },
      { a: { docs: ['a'] }, b: { docs: ['a', 'b', 'c'] } },
    )).toBe(1);
    expect(effectiveKeynessMinDocFreq(
      DEFAULT_KEYNESS_VIEW,
      { a: { docs: ['a'] }, b: { docs: ['b', 'c'] } },
    )).toBe(1);
    expect(effectiveKeynessMinDocFreq(
      { ...DEFAULT_KEYNESS_VIEW, mode: 'documents', minDocFreqTotal: 4 },
      { a: { docs: ['a'] }, b: { docs: ['b'] } },
    )).toBe(1);
  });

  it('defaults to the first document against the rest with log-ratio projections', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b', 'c']);
    expect(Object.isFrozen(DEFAULT_KEYNESS_VIEW)).toBe(true);
    expect(Object.isFrozen(DEFAULT_KEYNESS_VIEW.sort)).toBe(true);
    expect(Object.isFrozen(DEFAULT_KEYNESS_VIEW.classes)).toBe(true);
    expect(f.keynesses()).toHaveLength(2);
    const [a, b] = f.keynesses().map((issued) => issued.query as {
      request: {
        a: { docs: string[] };
        b: { docs: string[] };
        side: string;
        sort: { by: string; dir: number };
      };
    });
    expect(a!.request).toMatchObject({
      a: { docs: ['a'] },
      b: { docs: ['b', 'c'] },
      side: 'a',
      sort: { by: 'logRatio', dir: -1 },
    });
    expect(b!.request).toMatchObject({
      a: { docs: ['a'] },
      b: { docs: ['b', 'c'] },
      side: 'b',
      sort: { by: 'logRatio', dir: 1 },
    });
    expect(f.keynessInventories()).toHaveLength(2);
    expect(f.keynessInventories().map((issued) =>
      (issued.query as { selection: { docs: string[] } }).selection.docs,
    )).toEqual([['a'], ['b', 'c']]);
  });

  it('holds a demo reset on its first document while later books become ready first', () => {
    const project = (order: readonly string[]) => ({
      id: 'library',
      data: { ...LIBRARY_PROJECT.data, id: 'library', order },
    });
    const pendingFirst = {
      doc: 'book-1',
      sourceName: 'book-1.txt',
      library: `txt:${'1'.repeat(64)}`,
      status: 'extracting' as const,
      published: false,
    };
    const initial: SessionState = {
      ...sessionState(null, { project: project([]) }),
      imports: [
        pendingFirst,
        { ...pendingFirst, doc: 'book-2', sourceName: 'book-2.txt', library: `txt:${'2'.repeat(64)}` },
        { ...pendingFirst, doc: 'book-3', sourceName: 'book-3.txt', library: `txt:${'3'.repeat(64)}` },
      ],
    };
    const f = harness(initial);

    f.store.getState().resetKeynessComparison('book-1');
    f.port.emit({
      ...sessionState(snap('g1', 'partial', ['book-2', 'book-3']), {
        project: project(['book-2', 'book-3']),
      }),
      imports: [pendingFirst],
    });
    expect(f.store.getState().keynessView).toMatchObject({
      mode: 'document-rest',
      documentA: null,
      documentB: null,
      restOn: 'b',
    });

    f.port.emit(sessionState(snap('g1', 'complete', ['book-2', 'book-3', 'book-1']), {
      project: project(['book-1', 'book-2', 'book-3']),
    }));
    expect(f.store.getState().keynessView).toMatchObject({
      mode: 'document-rest',
      documentA: 'book-1',
      documentB: 'book-2',
      restOn: 'b',
    });
    const requests = f.keynesses().slice(-2).map((issued) =>
      (issued.query as {
        request: { a: { docs: string[] }; b: { docs: string[] } };
      }).request);
    expect(requests[0]).toMatchObject({
      a: { docs: ['book-1'] },
      b: { docs: ['book-2', 'book-3'] },
    });
  });

  it('temporarily compares a linked trend brush with the rest of the corpus', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const keynessCount = f.keynesses().length;
    f.store.setState({ corpusTokenCounts: new Map([['a', 10], ['b', 8]]) });
    f.store.getState().setLinkedSelection({
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 1, end: 4 } }],
    });
    expect(f.keynesses()).toHaveLength(keynessCount + 2);
    expect(f.store.getState().keynessView.mode).toBe('document-rest');
    expect((f.keynesses().at(-1)!.query as {
      request: { a: unknown; b: unknown };
    }).request).toMatchObject({
      a: { docs: ['a'], ranges: [{ doc: 'a', tokens: { start: 1, end: 4 } }] },
      b: {
        docs: ['a', 'b'],
        ranges: [
          { doc: 'a', tokens: { start: 0, end: 1 } },
          { doc: 'a', tokens: { start: 4, end: 10 } },
        ],
      },
    });

    f.store.getState().setLinkedSelection(null);
    expect(f.keynesses()).toHaveLength(keynessCount + 4);
    expect((f.keynesses().at(-1)!.query as {
      request: { a: { docs: string[] }; b: { docs: string[] } };
    }).request).toMatchObject({
      a: { docs: ['a'] },
      b: { docs: ['b'] },
    });
  });

  it('compares a linked range with its exact complement in a single text', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    expect(f.store.getState().keynessView.mode).toBe('selection-rest');
    expect(f.keynesses()).toHaveLength(0);

    f.store.setState({ corpusTokenCounts: new Map([['a', 10]]) });
    f.store.getState().setLinkedSelection({
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 2, end: 4 } }],
    });

    expect(f.keynesses()).toHaveLength(2);
    const firstPair = f.keynesses().map((issued) => (issued.query as {
      request: {
        a: { docs: string[]; ranges: unknown[] };
        b: { docs: string[]; ranges: unknown[] };
        filter: { minDocFreqTotal: number };
      };
    }).request);
    for (const request of firstPair) {
      expect(request).toMatchObject({
        a: {
          docs: ['a'],
          ranges: [{ doc: 'a', tokens: { start: 2, end: 4 } }],
        },
        b: {
          docs: ['a'],
          ranges: [
            { doc: 'a', tokens: { start: 0, end: 2 } },
            { doc: 'a', tokens: { start: 4, end: 10 } },
          ],
        },
        filter: { minDocFreqTotal: 1 },
      });
    }

    const old = [...f.keynesses()];
    f.store.getState().setLinkedSelection({
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 3, end: 6 } }],
    });
    expect(f.keynesses()).toHaveLength(4);
    expect(old.every((issued) => issued.cancelled)).toBe(true);
    expect((f.keynesses().at(-1)!.query as {
      request: { a: { ranges: unknown[] }; b: { ranges: unknown[] } };
    }).request).toMatchObject({
      a: { ranges: [{ doc: 'a', tokens: { start: 3, end: 6 } }] },
      b: {
        ranges: [
          { doc: 'a', tokens: { start: 0, end: 3 } },
          { doc: 'a', tokens: { start: 6, end: 10 } },
        ],
      },
    });

    f.store.getState().setLinkedSelection(null);
    expect(f.store.getState().keynessA).toBeNull();
    expect(f.store.getState().keynessB).toBeNull();
    expect(f.store.getState().keynessInventoryA).toBeNull();
    expect(f.store.getState().keynessInventoryB).toBeNull();
  });

  it('keeps untouched documents whole in the outside-selection side', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.setState({ corpusTokenCounts: new Map([['a', 10], ['b', 8]]) });
    f.store.getState().setKeynessMode('selection-rest');
    f.store.getState().setLinkedSelection({
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 2, end: 4 } }],
    });
    const request = (f.keynesses().at(-1)!.query as {
      request: {
        a: { docs: string[]; ranges: unknown[] };
        b: { docs: string[]; ranges: unknown[] };
        filter: { minDocFreqTotal: number };
      };
    }).request;
    expect(request).toMatchObject({
      a: {
        docs: ['a'],
        ranges: [{ doc: 'a', tokens: { start: 2, end: 4 } }],
      },
      b: {
        docs: ['a', 'b'],
        ranges: [
          { doc: 'a', tokens: { start: 0, end: 2 } },
          { doc: 'a', tokens: { start: 4, end: 10 } },
        ],
      },
      filter: { minDocFreqTotal: 1 },
    });
  });

  it('waits without issuing when selection geometry is unavailable', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setLinkedSelection({
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 2, end: 4 } }],
    });
    expect(f.keynesses()).toHaveLength(0);
    expect(f.store.getState().keynessA).toBeNull();
    expect(f.store.getState().keynessB).toBeNull();
  });

  it.each(['baseline', 'selected'] as const)(
    'starts a waiting range comparison when the %s inventory supplies token counts',
    async (first) => {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      const baseline = f.inventories().at(-1)!;
      f.store.getState().setLinkedSelection({
        snapshot: 's1',
        ranges: [{ doc: 'a', tokens: { start: 2, end: 4 } }],
      });
      const selected = f.inventories().at(-1)!;
      expect(f.keynesses()).toHaveLength(0);

      const leading = first === 'baseline' ? baseline : selected;
      const trailing = first === 'baseline' ? selected : baseline;
      leading.resolve(fakeInventoryResult(10, [{ doc: 'a', fullTokens: 10 }]));
      await flush();

      expect(f.keynesses()).toHaveLength(2);
      expect(f.keynessInventories().filter((query) => query !== selected)).toHaveLength(2);
      expect((f.keynesses()[0]!.query as {
        request: { a: unknown; b: unknown };
      }).request).toMatchObject({
        a: { docs: ['a'], ranges: [{ doc: 'a', tokens: { start: 2, end: 4 } }] },
        b: {
          docs: ['a'],
          ranges: [
            { doc: 'a', tokens: { start: 0, end: 2 } },
            { doc: 'a', tokens: { start: 4, end: 10 } },
          ],
        },
      });

      trailing.resolve(fakeInventoryResult(10, [{ doc: 'a', fullTokens: 10 }]));
      await flush();
      expect(f.keynesses()).toHaveLength(2);
      expect(f.keynesses().every((query) => !query.cancelled)).toBe(true);
    },
  );

  it('leaves selection comparison when a document is chosen', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.getState().setKeynessMode('selection-rest');
    f.store.getState().setKeynessSelection('a', 'b');
    expect(f.store.getState().keynessView).toMatchObject({
      mode: 'documents',
      documentA: 'b',
      documentB: 'a',
    });
    expect((f.keynesses().at(-1)!.query as {
      request: { a: { docs: string[] }; b: { docs: string[] } };
    }).request).toMatchObject({
      a: { docs: ['b'] },
      b: { docs: ['a'] },
    });
  });

  it('appends independently loaded viewport chunks while retaining prior ranks', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const initialA = f.keynesses().find((issued) =>
      (issued.query as { request: { side: string } }).request.side === 'a')!;
    const initialB = f.keynesses().find((issued) =>
      (issued.query as { request: { side: string } }).request.side === 'b')!;
    initialA.resolve(fakeKeynessPage(3, [1]));
    initialB.resolve(fakeKeynessPage(1, [9]));
    await flush();
    f.store.getState().loadMoreKeyness('a');
    expect(initialA.cancelled).toBe(false); // paging only cancels in-flight work
    expect(initialB.cancelled).toBe(false);
    expect(f.keynesses()).toHaveLength(3);
    expect((f.keynesses().at(-1)!.query as {
      request: { side: string; page: { offset: number; limit: number } };
    }).request).toMatchObject({
      side: 'a',
      page: { offset: 1, limit: 2 },
    });
    expect(f.store.getState().keynessA).toMatchObject({
      resident: { rows: [{ typeId: 1 }] },
      state: { status: 'pending' },
    });
    f.keynesses().at(-1)!.resolve(fakeKeynessPage(3, [2, 3]));
    await flush();
    expect(f.store.getState().keynessA).toMatchObject({
      resident: { rows: [{ typeId: 1 }, { typeId: 2 }, { typeId: 3 }] },
      state: { status: 'ready' },
    });
  });

  it('retains resident ranks when a follow-up chunk changes shape or is empty', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const initialA = f.keynesses().find((issued) =>
      (issued.query as { request: { side: string } }).request.side === 'a')!;
    initialA.resolve(fakeKeynessPage(3, [1]));
    await flush();

    f.store.getState().loadMoreKeyness('a');
    f.keynesses().at(-1)!.resolve(fakeKeynessPage(4, [2, 3]));
    await flush();
    expect(f.store.getState().keynessA).toMatchObject({
      resident: { total: 3, rows: [{ typeId: 1 }] },
      state: { status: 'error', message: expect.stringMatching(/ranks changed/) },
    });

    f.store.getState().loadMoreKeyness('a');
    expect((f.keynesses().at(-1)!.query as {
      request: { page: { offset: number; limit: number } };
    }).request.page).toEqual({ offset: 1, limit: 2 });
    f.keynesses().at(-1)!.resolve(fakeKeynessPage(3, []));
    await flush();
    expect(f.store.getState().keynessA).toMatchObject({
      resident: { total: 3, rows: [{ typeId: 1 }] },
      state: { status: 'error', message: expect.stringMatching(/ranks changed/) },
    });
  });

  it('retries a failed follow-up chunk from the retained offset', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const initialA = f.keynesses().find((issued) =>
      (issued.query as { request: { side: string } }).request.side === 'a')!;
    initialA.resolve(fakeKeynessPage(3, [1]));
    await flush();

    f.store.getState().loadMoreKeyness('a');
    f.keynesses().at(-1)!.reject(new Error('network unavailable'));
    await flush();
    expect(f.store.getState().keynessA).toMatchObject({
      resident: { rows: [{ typeId: 1 }] },
      state: { status: 'error', message: expect.stringMatching(/network unavailable/) },
    });

    f.store.getState().loadMoreKeyness('a');
    const retry = f.keynesses().at(-1)!;
    expect((retry.query as {
      request: { page: { offset: number; limit: number } };
    }).request.page).toEqual({ offset: 1, limit: 2 });
    retry.resolve(fakeKeynessPage(3, [2, 3]));
    await flush();
    expect(f.store.getState().keynessA).toMatchObject({
      resident: { rows: [{ typeId: 1 }, { typeId: 2 }, { typeId: 3 }] },
      state: { status: 'ready' },
    });
  });

  it('trims the final browser chunk and stops at the resident display bound', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const initialA = f.keynesses().find((issued) =>
      (issued.query as { request: { side: string } }).request.side === 'a')!;
    const firstCount = COMPARE_MAX_RESIDENT_ROWS - 50;
    initialA.resolve(fakeKeynessPage(
      COMPARE_MAX_RESIDENT_ROWS + 1,
      Array.from({ length: firstCount }, (_, index) => index),
    ));
    await flush();

    f.store.getState().loadMoreKeyness('a');
    const finalChunk = f.keynesses().at(-1)!;
    expect((finalChunk.query as {
      request: { page: { offset: number; limit: number } };
    }).request.page).toEqual({ offset: firstCount, limit: 50 });
    finalChunk.resolve(fakeKeynessPage(
      COMPARE_MAX_RESIDENT_ROWS + 1,
      Array.from({ length: 50 }, (_, index) => firstCount + index),
    ));
    await flush();
    const issued = f.keynesses().length;
    f.store.getState().loadMoreKeyness('a');
    expect(f.keynesses()).toHaveLength(issued);
    expect(f.store.getState().keynessA?.resident?.rows)
      .toHaveLength(COMPARE_MAX_RESIDENT_ROWS);
  });

  it('table-only view changes do not strand inventory headers', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const inventories = f.keynessInventories();
    const semantic = workspaceSemanticKey(f.store.getState());
    const before = f.store.getState().keynessView;
    f.store.getState().applyKeynessSettings({
      minCountTotal: 8,
      minDocFreqTotal: 3,
      classes: ['lexical', 'numeral'],
      stoplistTopN: before.stoplistTopN,
      sortBy: 'countA',
      dirA: before.sort.dirA,
      dirB: before.sort.dirB,
      showConfidenceIntervals: false,
    });
    expect(f.keynesses()).toHaveLength(4);
    expect(f.keynessInventories()).toHaveLength(2);
    expect(f.store.getState().keynessView).toMatchObject({
      minCountTotal: 8,
      minDocFreqTotal: 3,
      classes: ['lexical', 'numeral'],
      sort: {
        by: 'countA',
        dirA: before.sort.dirA,
        dirB: before.sort.dirB,
      },
      pageLimit: 100,
    });
    expect(workspaceSemanticKey(f.store.getState())).not.toBe(semantic);
    expect(inventories.every((issued) => !issued.cancelled)).toBe(true);

    inventories[0]!.resolve(fakeInventoryResult(4));
    inventories[1]!.resolve(fakeInventoryResult(5));
    await flush();
    expect(f.store.getState().keynessInventoryA?.state.status).toBe('ready');
    expect(f.store.getState().keynessInventoryB?.state.status).toBe('ready');
  });

  it('reissues both Compare rankings when common-word depth changes', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const view = f.store.getState().keynessView;
    const before = f.keynesses().length;
    f.store.getState().applyKeynessSettings({
      minCountTotal: view.minCountTotal,
      minDocFreqTotal: view.minDocFreqTotal,
      classes: view.classes,
      stoplistTopN: 500,
      sortBy: view.sort.by,
      dirA: view.sort.dirA,
      dirB: view.sort.dirB,
      showConfidenceIntervals: view.showConfidenceIntervals,
    });
    expect(f.keynesses()).toHaveLength(before + 2);
    for (const issued of f.keynesses().slice(-2)) {
      expect((issued.query as {
        request: { filter: Record<string, unknown> };
      }).request.filter.stoplist).toEqual({
        id: STOPLIST_EN_ID,
        version: STOPLIST_EN_VERSION,
        topN: 500,
      });
    }
  });

  it('applies only one changed direction and refuses invalid shared settings', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const semantic = workspaceSemanticKey(f.store.getState());
    const issued = f.keynesses().length;
    const initial = f.store.getState().keynessView;
    f.store.getState().applyKeynessSettings({
      minCountTotal: initial.minCountTotal,
      minDocFreqTotal: initial.minDocFreqTotal,
      classes: initial.classes,
      stoplistTopN: initial.stoplistTopN,
      sortBy: initial.sort.by,
      dirA: 1,
      dirB: initial.sort.dirB,
      showConfidenceIntervals: initial.showConfidenceIntervals,
    });
    expect(f.keynesses()).toHaveLength(issued + 1);
    expect((f.keynesses().at(-1)!.query as {
      request: { side: string; sort: { by: string; dir: number } };
    }).request).toMatchObject({
      side: 'a',
      sort: { by: 'logRatio', dir: 1 },
    });
    expect(f.store.getState().keynessView.sort).toEqual({
      by: 'logRatio',
      dirA: 1,
      dirB: 1,
    });
    expect(workspaceSemanticKey(f.store.getState())).not.toBe(semantic);

    const view = f.store.getState().keynessView;
    f.store.getState().applyKeynessSettings({
      minCountTotal: 0,
      minDocFreqTotal: 1,
      classes: ['lexical'],
      stoplistTopN: view.stoplistTopN,
      sortBy: 'g2',
      dirA: view.sort.dirA,
      dirB: view.sort.dirB,
      showConfidenceIntervals: view.showConfidenceIntervals,
    });
    expect(f.keynesses()).toHaveLength(issued + 1);
    expect(f.store.getState().keynessView).toBe(view);
    const invalidSettings = [
      {
        minCountTotal: 1,
        minDocFreqTotal: 1,
        classes: ['lexical', 'lexical'],
        sortBy: 'g2',
        dirA: -1,
        dirB: 1,
        showConfidenceIntervals: false,
      },
      {
        minCountTotal: 1,
        minDocFreqTotal: 1,
        classes: [],
        sortBy: 'g2',
        dirA: -1,
        dirB: 1,
        showConfidenceIntervals: false,
      },
      {
        minCountTotal: 1,
        minDocFreqTotal: 1,
        classes: ['foreign'],
        sortBy: 'g2',
        dirA: -1,
        dirB: 1,
        showConfidenceIntervals: false,
      },
      {
        minCountTotal: 1,
        minDocFreqTotal: 1,
        classes: ['lexical'],
        sortBy: 'foreign',
        dirA: -1,
        dirB: 1,
        showConfidenceIntervals: false,
      },
    ] as const;
    for (const settings of invalidSettings) {
      f.store.getState().applyKeynessSettings(settings as never);
      expect(f.keynesses()).toHaveLength(issued + 1);
      expect(f.store.getState().keynessView).toBe(view);
    }
  });

  it('round-trips shared settings through research', () => {
    const f = harness(sessionState(snap('g1', 's1', ['a', 'b']), {
      project: { data: { ...LIBRARY_PROJECT.data, order: ['a', 'b'] } },
    }));
    f.store.getState().applyKeynessSettings({
      minCountTotal: 9,
      minDocFreqTotal: 4,
      classes: ['numeral'],
      stoplistTopN: 750,
      sortBy: 'g2',
      dirA: 1,
      dirB: -1,
      showConfidenceIntervals: true,
    });
    const durable = workspaceSemanticKey(f.store.getState());
    expect(durable).not.toBeNull();
    const workspace = JSON.parse(durable!) as WorkspaceV1;
    restoreFixture(f, workspace);
    expect(f.store.getState().keynessView).toMatchObject({
      minCountTotal: 9,
      minDocFreqTotal: 4,
      classes: ['numeral'],
      stoplistTopN: 750,
      sort: { by: 'g2', dirA: 1, dirB: -1 },
      showConfidenceIntervals: true,
      pageLimit: 100,
    });
    expect(workspaceSemanticKey(f.store.getState())).toBe(durable);
  });

  it('applies Compare display preferences without reissuing rankings', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const view = f.store.getState().keynessView;
    const issued = f.keynesses().length;
    f.store.getState().applyKeynessSettings({
      minCountTotal: view.minCountTotal,
      minDocFreqTotal: view.minDocFreqTotal,
      classes: view.classes,
      stoplistTopN: view.stoplistTopN,
      sortBy: view.sort.by,
      dirA: view.sort.dirA,
      dirB: view.sort.dirB,
      showConfidenceIntervals: true,
    });
    expect(f.keynesses()).toHaveLength(issued);
    expect(f.store.getState().keynessView.showConfidenceIntervals).toBe(true);
  });

  it('swaps sides and constructs document-v-rest without overlapping membership', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b', 'c']);
    f.store.getState().setKeynessMode('documents');
    f.store.getState().setKeynessDocument('a', 'c');
    expect(f.store.getState().keynessView).toMatchObject({
      documentA: 'c',
    });
    f.store.getState().setKeynessDocument('a', 'a');
    f.store.getState().swapKeynessSides();
    let requests = f.keynesses().slice(-2).map((issued) =>
      (issued.query as {
        request: { a: { docs: string[] }; b: { docs: string[] } };
      }).request);
    expect(requests[0]).toMatchObject({ a: { docs: ['b'] }, b: { docs: ['a'] } });

    f.store.getState().setKeynessMode('document-rest');
    requests = f.keynesses().slice(-2).map((issued) =>
      (issued.query as {
        request: { a: { docs: string[] }; b: { docs: string[] } };
      }).request);
    expect(requests[0]).toMatchObject({
      a: { docs: ['b'] },
      b: { docs: ['a', 'c'] },
    });
    f.store.getState().swapKeynessSides();
    requests = f.keynesses().slice(-2).map((issued) =>
      (issued.query as {
        request: { a: { docs: string[] }; b: { docs: string[] } };
      }).request);
    expect(requests[0]).toMatchObject({
      a: { docs: ['a', 'c'] },
      b: { docs: ['b'] },
    });
  });

  it('drives both visible side selectors through document and rest comparisons', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b', 'c']);
    f.store.getState().setKeynessMode('documents');

    f.store.getState().setKeynessSelection('a', null);
    expect(f.store.getState().keynessView).toMatchObject({
      mode: 'document-rest',
      restOn: 'a',
      documentB: 'b',
    });
    let requests = f.keynesses().slice(-2).map((issued) =>
      (issued.query as {
        request: { a: { docs: string[] }; b: { docs: string[] } };
      }).request);
    expect(requests[0]).toMatchObject({
      a: { docs: ['a', 'c'] },
      b: { docs: ['b'] },
    });

    f.store.getState().setKeynessSelection('a', 'c');
    expect(f.store.getState().keynessView).toMatchObject({
      mode: 'documents',
      documentA: 'c',
      documentB: 'b',
    });
    f.store.getState().setKeynessSelection('a', 'b');
    expect(f.store.getState().keynessView).toMatchObject({
      documentA: 'c',
      documentB: 'b',
    });

    f.store.getState().setKeynessSelection('b', null);
    f.store.getState().setKeynessSelection('a', 'b');
    expect(f.store.getState().keynessView).toMatchObject({
      mode: 'document-rest',
      restOn: 'b',
      documentA: 'b',
    });
    requests = f.keynesses().slice(-2).map((issued) =>
      (issued.query as {
        request: { a: { docs: string[] }; b: { docs: string[] } };
      }).request);
    expect(requests[0]).toMatchObject({
      a: { docs: ['b'] },
      b: { docs: ['a', 'c'] },
    });

    f.store.getState().setKeynessSelection('a', null);
    expect(f.store.getState().keynessView).toMatchObject({
      mode: 'document-rest',
      restOn: 'a',
      documentB: 'b',
    });
  });

  it.each([false, true])('preserves restored comparison sides through partial cold snapshots (unavailable text: %s)', async (withUnavailable) => {
    const base = workspaceState();
    const docs = ['a', 'b'].map((doc) => ({ doc, library: `txt:${doc.repeat(64)}`, meta: { title: doc, language: 'en', tags: [] } }));
    const saved = { ...base, corpus: { kind: 'library' as const, order: ['a', 'b'], docs }, views: { ...base.views, compare: { ...base.views.compare, mode: 'documents' as const, documentA: 'a', documentB: 'b' } } };
    const data = await libraryProject(saved, new Map(docs.map((doc) => [doc.library, { id: doc.library, name: `${doc.doc}.txt`, format: 'txt' as const, size: 10, contentHash: doc.doc.repeat(64) }])));
    const restored = withUnavailable ? {
      ...saved,
      corpus: {
        ...saved.corpus,
        order: [...saved.corpus.order, 'damaged'],
        docs: [...saved.corpus.docs, { doc: 'damaged', library: `txt:${'d'.repeat(64)}`, meta: { title: 'Damaged source', language: 'en', tags: [] } }],
      },
    } : saved;
    const f = harness();
    try {
      f.port.emit(sessionState(null, { project: { data } }));
      restoreFixture(f, restored);
      f.port.emit(sessionState(snap('g1', 'partial', ['b']), { project: { data } }));
      expect(f.store.getState().keynessView).toMatchObject({ mode: 'documents', documentA: 'a', documentB: 'b' });
      f.port.emit(sessionState(snap('g1', 'complete', ['a', 'b']), { project: { data } }));
      expect(f.store.getState().keynessView).toMatchObject({ mode: 'documents', documentA: 'a', documentB: 'b' });
      f.port.emit(sessionState(snap('g2', 'removed', ['b']), { project: { data: { ...data, order: ['b'], docs: data.docs.filter((doc) => doc.doc === 'b') } } }));
      expect(f.store.getState().keynessView).toMatchObject({ mode: 'selection-rest', documentA: 'b', documentB: null });
    } finally { f.runtime.dispose(); }
  });

  it('reconciles departed documents on the next snapshot', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b', 'c']);
    f.store.getState().setKeynessDocument('a', 'c');
    f.port.publishSnapshot('g1', 's2', ['a', 'b']);
    expect(f.store.getState().keynessView).toMatchObject({
      documentA: 'a',
      documentB: 'b',
    });
    const latest = f.keynesses().slice(-2).map((issued) =>
      (issued.query as {
        request: { a: { docs: string[] }; b: { docs: string[] } };
      }).request);
    expect(latest[0]).toMatchObject({ a: { docs: ['a'] }, b: { docs: ['b'] } });
  });
});
