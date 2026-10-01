/** runtime session behavior through the live application runtime. */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createAppRuntime,

} from '../src/lib/store.ts';

import { emptyLibraryWorkspace, workspaceFromApp } from '../src/lib/workspace-state.ts';

import type { SessionState } from '../src/lib/project-session.ts';
import { SessionCommandError } from '../src/lib/project-session.ts';
import { libraryProject } from '../src/lib/project.ts';

import type { SnapshotInfo } from '../src/lib/client.ts';
import { DEFAULT_INDEX_RECIPE, parseWorkspace, type WorkspaceV1 } from '@texttrends/core';
import { workspaceState } from './support/workspace-fixtures.ts';
import type { LocalLibraryFile } from '../src/lib/local-library.ts';
import { groupTitle } from '../src/lib/notebook.ts';

import { fakeQueryClient, LIBRARY_PROJECT, snap, sessionState, FakeSessionPort, FakeWorkspaceStore, fakeTrend, fakeInventoryResult, harness, flush } from './support/runtime-harness.ts';

describe('the session bridge', () => {
  it('flushes a pending workspace on hide and releases the visibility listener on disposal', async () => {
    vi.useFakeTimers();
    const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const removed = vi.spyOn(visibility, 'removeEventListener');
    vi.stubGlobal('document', visibility);
    const workspace = new FakeWorkspaceStore();
    const { runtime, store } = harness(undefined, { workspace });
    try {
      store.getState().addTerm({ aliases: ['clue'] });
      visibility.dispatchEvent(new Event('visibilitychange'));
      expect(workspace.saves).toHaveLength(0);
      visibility.visibilityState = 'hidden';
      visibility.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(workspace.saves).toHaveLength(1);
      expect(workspace.saves[0]?.notebook.groups.map(groupTitle)).toEqual(['clue']);
      expect(store.getState().workspacePersistence.phase).toBe('saved');
      runtime.dispose();
      expect(removed).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      visibility.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(workspace.saves).toHaveLength(1);
    } finally {
      runtime.dispose(); vi.unstubAllGlobals(); vi.useRealTimers();
    }
  });

  it('defines a fresh install as a valid empty library workspace', () => {
    const workspace = emptyLibraryWorkspace();
    expect(parseWorkspace(workspace)).toEqual(workspace);
  });

  it('retains unavailable references through edits and reordering, then removes them explicitly', async () => {
    const documents = ['a', 'damaged', 'b'].map((doc, index) => ({
      doc, library: `txt:${String(index + 1).repeat(64)}`,
      meta: { title: doc, language: 'en', tags: [] },
    }));
    const durable = workspaceState({ corpus: { kind: 'library', order: documents.map((doc) => doc.doc), docs: documents } });
    const healthy = documents.filter((doc) => doc.doc !== 'damaged');
    const data = await libraryProject({ ...durable, corpus: { ...durable.corpus, order: ['a', 'b'], docs: healthy } }, new Map(healthy.map((doc) => [doc.library, {
      id: doc.library, name: `${doc.doc}.txt`, format: 'txt' as const, size: 1, contentHash: doc.library.slice(4),
    }])));
    vi.useFakeTimers();
    const workspace = new FakeWorkspaceStore();
    const runtime = createAppRuntime(fakeQueryClient().client, { workspace });
    const port = new FakeSessionPort(sessionState(null, { project: { data } }));
    try {
      runtime.attachSession(port, durable);
      runtime.useApp.getState().mergeStarterTerms('Watson');
      await vi.advanceTimersByTimeAsync(1_500);
      expect(workspace.saves.at(-1)?.corpus.order).toEqual(['a', 'damaged', 'b']);
      expect(workspace.saves.at(-1)?.corpus.docs).toContainEqual(documents[1]);
      port.emit(sessionState(null, { project: { data: { ...data, order: ['b', 'a'] } } }));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(workspace.saves.at(-1)?.corpus.order).toEqual(['b', 'damaged', 'a']);
      runtime.useApp.getState().removeDocuments(['damaged']);
      runtime.useApp.getState().mergeStarterTerms('Holmes');
      await vi.advanceTimersByTimeAsync(1_500);
      expect(workspace.saves.at(-1)?.corpus.order).toEqual(['b', 'a']);
      expect(runtime.useApp.getState().unavailableDocs).toEqual([]);
    } finally { runtime.dispose(); vi.useRealTimers(); }
  });

  it('counts unavailable references in import admission while allowing source repair at the cap', () => {
    const docs = Array.from({ length: 256 }, (_, index) => ({
      doc: `unavailable-${index}`, library: `txt:${index.toString(16).padStart(64, '0')}`,
      meta: { title: `Text ${index}`, language: 'en', tags: [] },
    }));
    const { store, port, runtime } = harness(undefined, { saved: workspaceState({ corpus: { kind: 'library', order: docs.map((doc) => doc.doc), docs } }) });
    const input: LocalLibraryFile = { name: 'extra.txt', size: 1, format: 'txt', contentHash: 'b'.repeat(64), library: `txt:${'b'.repeat(64)}`, arrayBuffer: async () => new ArrayBuffer(1) };
    expect(store.getState().importFiles([input])).toBe(false);
    expect(store.getState().commandError).toContain('256 saved active texts');
    expect(port.calls.some((call) => call.method === 'appendFiles')).toBe(false);
    expect(store.getState().importFiles([{ ...input, library: docs[0]!.library, contentHash: docs[0]!.library.slice(4) }])).toBe(true);
    expect(store.getState().commandError).toBeNull();
    runtime.dispose();
  });

  it('repairing a retained source under a new document id does not duplicate it', async () => {
    const doc = { doc: 'damaged', library: `txt:${'a'.repeat(64)}`, meta: { title: 'Repair', language: 'en', tags: [] } };
    const durable = workspaceState({ corpus: { kind: 'library', order: [doc.doc], docs: [doc] } });
    const { store, port, runtime } = harness(undefined, { saved: durable });
    expect(store.getState().unavailableDocs).toHaveLength(1);
    const repaired = { ...doc, doc: 'reimported' };
    const data = await libraryProject({ ...durable, corpus: { ...durable.corpus, order: [repaired.doc], docs: [repaired] } }, new Map([[doc.library, {
      id: doc.library, name: 'repair.txt', format: 'txt', size: 1, contentHash: 'a'.repeat(64),
    }]]));
    port.emit(sessionState(null, { project: { data } }));
    expect(workspaceFromApp(store.getState())?.corpus.order).toEqual(['reimported']);
    expect(store.getState().unavailableDocs).toEqual([]);
    runtime.dispose();
  });

  it.each(['clear', 'replace'] as const)('%s discards retained unavailable references', (action) => {
    const doc = { doc: 'damaged', library: `txt:${'a'.repeat(64)}`, meta: { title: 'Repair', language: 'en', tags: [] } };
    const { store, runtime } = harness(undefined, { saved: workspaceState({ corpus: { kind: 'library', order: [doc.doc], docs: [doc] } }) });
    const result = action === 'clear' ? store.getState().clearActiveInputsAndTerms() : store.getState().replaceInputsAndTerms([]);
    expect(result?.texts).toBe(1);
    expect(workspaceFromApp(store.getState())?.corpus.order).toEqual([]);
    runtime.dispose();
  });

  it('autosaves workspace changes after 1.5 seconds and excludes transient paging', async () => {
    vi.useFakeTimers();
    try {
      const workspace = new FakeWorkspaceStore();
      const { runtime, store } = harness(undefined, { workspace });
      store.getState().mergeStarterTerms('Watson');
      expect(store.getState().workspacePersistence.phase).toBe('dirty');
      await vi.advanceTimersByTimeAsync(1_500);
      expect(workspace.saves).toHaveLength(1);
      expect(workspace.saves[0]).toMatchObject({
        schema: 'texttrends/workspace/1',
        corpus: { kind: 'library', order: [], docs: [] },
        notebook: { groups: [{ aliases: ['Watson'] }] },
      });
      await Promise.resolve();
      await Promise.resolve();
      const group = store.getState().notebook.groups[0]!;
      store.getState().setSolo(group.id);
      store.getState().setFrequencyPage(10);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(workspace.saves).toHaveLength(1);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues autosaving settled intent while a failed import awaits dismissal', async () => {
    vi.useFakeTimers();
    try {
      const workspace = new FakeWorkspaceStore();
      const { runtime, store, port } = harness(undefined, { workspace });
      const failed: SessionState = {
        ...sessionState(null, { project: { id: 'library' } }),
        imports: [{
          doc: 'failed-doc',
          sourceName: 'failed.txt',
          library: `txt:${'f'.repeat(64)}`,
          status: 'failed',
          published: false,
        }],
      };
      port.emit(failed);
      store.getState().mergeStarterTerms('Moriarty');
      expect(store.getState().workspacePersistence.phase).toBe('dirty');
      await vi.advanceTimersByTimeAsync(1_500);
      await Promise.resolve();
      expect(workspace.saves.at(-1)?.notebook.groups.map(groupTitle)).toContain('Moriarty');
      expect(store.getState().workspacePersistence.phase).toBe('saved');
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists replacement corpus and notebook together after synchronous session publication', async () => {
    const doc = { doc: 'replacement', library: `txt:${'a'.repeat(64)}`, meta: { title: 'Replacement', language: 'en', tags: [] } };
    const durable = workspaceState({ corpus: { kind: 'library', order: [doc.doc], docs: [doc] } });
    const data = await libraryProject(durable, new Map([[doc.library, {
      id: doc.library, name: 'replacement.txt', format: 'txt' as const, size: 1, contentHash: 'a'.repeat(64),
    }]]));
    vi.useFakeTimers();
    const workspace = new FakeWorkspaceStore();
    const f = harness(undefined, { workspace, seed: true });
    try {
      await vi.advanceTimersByTimeAsync(1_500);
      workspace.saves.length = 0;
      vi.spyOn(f.port, 'replaceFiles').mockImplementation(() => {
        f.port.emit(sessionState(null, { project: { data } }));
      });
      expect(f.store.getState().replaceInputsAndTerms([{
        name: 'replacement.txt', size: 1, format: 'txt', library: doc.library,
        contentHash: 'a'.repeat(64), arrayBuffer: async () => new Uint8Array([1]).buffer,
      }])).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(workspace.saves).toHaveLength(1);
      expect(workspace.saves[0]).toMatchObject({
        corpus: { order: ['replacement'], docs: [{ doc: 'replacement' }] },
        notebook: { groups: [] }, active: [],
      });
    } finally {
      f.runtime.dispose();
      vi.useRealTimers();
    }
  });

  it('fences pending save settlement and cancels scheduled writes on disposal', async () => {
    vi.useFakeTimers();
    const workspace = new FakeWorkspaceStore();
    let finish!: () => void;
    vi.spyOn(workspace, 'saveWorkspace').mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const f = harness(undefined, { workspace });
    try {
      f.store.getState().mergeStarterTerms('Watson');
      await vi.advanceTimersByTimeAsync(1_500);
      f.store.getState().mergeStarterTerms('Holmes');
      f.runtime.dispose();
      const phase = f.store.getState().workspacePersistence;
      finish();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(workspace.saveWorkspace).toHaveBeenCalledTimes(1);
      expect(f.store.getState().workspacePersistence).toBe(phase);
    } finally {
      f.runtime.dispose();
      vi.useRealTimers();
    }
  });

  it('drains issued saves before restore and resumes the latest intent after an aborted restore', async () => {
    vi.useFakeTimers();
    const workspace = new FakeWorkspaceStore();
    let finish!: () => void;
    const save = vi.spyOn(workspace, 'saveWorkspace').mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { runtime, store } = harness(undefined, { workspace });
    try {
      store.getState().mergeStarterTerms('Watson');
      await vi.advanceTimersByTimeAsync(1_500);
      let drained = false;
      const suspension = runtime.suspendWorkspaceSaving().then((resume) => { drained = true; return resume; });
      store.getState().mergeStarterTerms('Holmes');
      store.getState().retryWorkspaceSave();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(drained).toBe(false);
      expect(save).toHaveBeenCalledTimes(1);
      finish();
      const resume = await suspension;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(save).toHaveBeenCalledTimes(1);
      resume();
      resume();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(save).toHaveBeenCalledTimes(2);
      expect(workspace.saves.at(-1)?.notebook.groups.map(groupTitle)).toEqual(['Watson', 'Holmes']);
      expect(store.getState().workspacePersistence.phase).toBe('saved');
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });

  it('surfaces a workspace write failure and retries the latest state', async () => {
    vi.useFakeTimers();
    try {
      const workspace = new FakeWorkspaceStore();
      workspace.error = new Error('quota full');
      const { runtime, store } = harness(undefined, { workspace });
      store.getState().mergeStarterTerms('Lestrade');
      await vi.advanceTimersByTimeAsync(1_500);
      await Promise.resolve();
      expect(store.getState().workspacePersistence).toMatchObject({
        phase: 'error',
        message: expect.stringMatching(/quota full/),
      });
      expect(workspace.saves).toHaveLength(1);
      workspace.error = null;
      store.getState().retryWorkspaceSave();
      await Promise.resolve();
      await Promise.resolve();
      expect(workspace.saves).toHaveLength(2);
      expect(store.getState().workspacePersistence.phase).toBe('saved');
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a workspace notebook from the active selection', async () => {
    const q = fakeQueryClient();
    const runtime = createAppRuntime(q.client, { newId: () => 'new' });
    const port = new FakeSessionPort(sessionState(null, {
      project: { data: { ...LIBRARY_PROJECT.data, order: ['a', 'b'] } },
    }));
    const durable = {
        ...workspaceState(),
        notebook: {
          schema: 'texttrends/query-notebook/3',
          groups: [{
            id: 'durable',
            aliases: ['Irene'],
            exactMatch: false,
            countOverlaps: false,
            style: { color: 'blue', line: 'solid' },
          }],
        },
        active: ['durable'],
        views: {
          ...workspaceState().views,
          trend: {
            mode: 'by-book',
            bins: { mode: 'fixed-tokens', count: 500 },
            measure: {
              kind: 'rate',
              denominator: 10_000,
              smoothing: 7,
              showRaw: true,
            },
          },
        },
    } as unknown as WorkspaceV1;
    runtime.attachSession(port, parseWorkspace(durable));
    expect(runtime.useApp.getState()).toMatchObject({
      trendView: 'by-book',
      trendBins: { mode: 'fixed-tokens', count: 500 },
      trendMeasure: {
        kind: 'rate',
        denominator: 10_000,
        smoothing: 7,
        showRaw: true,
      },
      notebook: { groups: [{ id: 'durable', aliases: ['Irene'] }] },
      workspacePersistence: { phase: 'idle' },
    });
    expect(runtime.useApp.getState().activeGroupIds.has('durable')).toBe(true);
    expect(runtime.useApp.getState().series.map((series) => series.id)).toEqual(['durable']);
    expect(workspaceFromApp(runtime.useApp.getState())).toMatchObject({
      active: ['durable'],
    });
    runtime.dispose();
  });

  it('retains restored Compare selections through pre-snapshot loading publications', () => {
    const q = fakeQueryClient();
    const runtime = createAppRuntime(q.client);
    const project = {
      ...LIBRARY_PROJECT,
      data: { ...LIBRARY_PROJECT.data, order: ['a'] },
    };
    const port = new FakeSessionPort(sessionState(null, { project }));
    const base = workspaceState();
    const durable: WorkspaceV1 = {
      ...base,
      views: {
        ...base.views,
        compare: { ...base.views.compare, documentA: 'a' },
      },
    };
    runtime.attachSession(port, durable);
    expect(runtime.useApp.getState().keynessView.documentA).toBe('a');
    port.emit(sessionState(null, { project }));
    expect(runtime.useApp.getState().keynessView.documentA).toBe('a');
    runtime.dispose();
  });

  it('announces and persists geometry normalized after corpus extents arrive', async () => {
    vi.useFakeTimers();
    try {
      const q = fakeQueryClient();
      const workspace = new FakeWorkspaceStore();
      const runtime = createAppRuntime(q.client, { newId: () => 'new', workspace });
      const port = new FakeSessionPort();
      const durable = workspaceState();
      runtime.attachSession(port, {
          ...durable,
          views: {
            ...durable.views,
            trend: {
              ...durable.views.trend,
              bins: { mode: 'fixed-tokens', count: 250 },
            },
          },
      });
      port.publishSnapshot('g1', 's1', ['a', 'b']);
      q.inventories().at(-1)!.resolve(
        fakeInventoryResult(2_000_000, [
          { doc: 'a', fullTokens: 1_000_000 },
          { doc: 'b', fullTokens: 1_000_000 },
        ]),
      );
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(runtime.useApp.getState().trendBins).toEqual({
        mode: 'fixed-tokens',
        count: 500,
      });
      expect(runtime.useApp.getState().trendSettingsNotice).toMatch(/saved preference/);
      expect(runtime.useApp.getState().workspacePersistence.phase).toBe('dirty');
      await vi.advanceTimersByTimeAsync(1_500);
      expect(workspace.saves.at(-1)?.views.trend.bins).toEqual({
        mode: 'fixed-tokens',
        count: 500,
      });
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('seeds the current session state on attach, before any publication', () => {
    const q = fakeQueryClient();
    const runtime = createAppRuntime(q.client);
    const userState = sessionState(null, { project: { id: 'library' } });
    runtime.attachSession(new FakeSessionPort(userState));
    const s = runtime.useApp.getState();
    expect(s.bootstrap.phase).toBe('attached');
    expect(s.projectSession).toBe(userState);
    expect(s.projectSession!.project.id).toBe('library');
    // A null-snapshot seed must not issue any query.
    expect(q.issued.length).toBe(0);
  });

  it('rejects a second, different attachment (one session per lifetime)', () => {
    const { runtime, port } = harness();
    expect(() => runtime.attachSession(new FakeSessionPort())).toThrow(/already attached/);
    // Re-attaching the SAME session is an idempotent no-op.
    expect(() => runtime.attachSession(port)).not.toThrow();
  });

  it('a non-snapshot publication updates projection but issues/cancels no query', () => {
    const { store, port, trends } = harness(undefined, { seed: true });
    port.publishSnapshot('g1', 's1'); // default series → issues
    const issuedAfterSnapshot = trends().length;
    expect(issuedAfterSnapshot).toBeGreaterThan(0);
    const before = trends().map((t) => t.cancelled);
    // Same snapshot identity, different unrelated project metadata.
    port.emit(sessionState(snap('g1', 's1'), {
      project: { data: { ...LIBRARY_PROJECT.data, indexRecipeHash: 'changed' } },
    }));
    expect(store.getState().projectSession!.project.data.indexRecipeHash).toBe('changed');
    expect(trends().length).toBe(issuedAfterSnapshot); // no new query
    expect(trends().map((t) => t.cancelled)).toEqual(before); // none cancelled
  });

  it('a new snapshot identity issues exactly one refresh; a repeat is a no-op', () => {
    const { port, trends, kwics } = harness(undefined, { seed: true });
    port.publishSnapshot('g1', 's1');
    const t1 = trends().length;
    const k1 = kwics().length;
    expect(t1).toBe(2); // Holmes, Moriarty
    expect(k1).toBe(1);
    port.emit(sessionState(snap('g1', 's1'))); // identical key
    expect(trends().length).toBe(t1);
    expect(kwics().length).toBe(k1);
  });

  it('the same snapshot id under a NEW generation is a fresh identity (reissues)', () => {
    const { port, trends } = harness(undefined, { seed: true });
    port.publishSnapshot('g1', 's');
    expect(trends().filter((t) => !t.cancelled).length).toBe(2);
    port.publishSnapshot('g2', 's'); // same snapshot string, new generation
    expect(trends().length).toBe(4);
    // The g1 queries were superseded.
    expect(trends().slice(0, 2).every((t) => t.cancelled)).toBe(true);
  });

  it('a snapshot → null transition cancels work and clears evidence once', async () => {
    const { store, port, trends } = harness(undefined, { seed: true });
    port.publishSnapshot('g1', 's1');
    const live = trends().filter((t) => !t.cancelled);
    live[0]!.resolve({ op: 'trend', trend: fakeTrend(4) });
    await flush();
    expect(store.getState().trends.size).toBe(2);
    port.emit(sessionState(null)); // worker restarting: snapshot gone
    expect(live[0]!.cancelled).toBe(false); // completed work was already released
    expect(live[1]!.cancelled).toBe(true);
    expect(store.getState().trends.size).toBe(0);
    expect(store.getState().snapshot).toBeNull();
  });

  it('after null→B, a late result from the superseded A snapshot cannot write', async () => {
    const { store, port, trends } = harness(undefined, { seed: true });
    port.publishSnapshot('g1', 'A');
    const aQuery = trends().filter((t) => !t.cancelled).at(-1)!;
    port.emit(sessionState(null));
    port.publishSnapshot('g2', 'B');
    aQuery.resolve({ op: 'trend', trend: fakeTrend(9) }); // raced past its supersession
    await flush();
    for (const [, state] of store.getState().trends) expect(state.status).toBe('pending');
    expect(trends().at(-1)!.snapshot).toBe('B');
  });

  it('each command wrapper dispatches to the attached session', () => {
    const { store, port } = harness();
    const s = store.getState();
    s.removeImport('d');
    s.removeDocument('d');
    s.removeDocuments(['d', 'e']);
    s.editMeta('d', { title: 't' });
    s.setLanguage('d', 'fr');
    s.reorder(['d']);
    s.retryAnalysis();
    expect(port.calls.map((c) => c.method)).toEqual([
      'removeImport', 'removeDocument', 'removeDocuments', 'editMeta', 'setLanguage', 'reorder', 'start',
    ]);
  });

  it('clears finalized and pending inputs once with the complete notebook and its undo state', () => {
    const active: SessionState = {
      ...sessionState(null, {
        project: {
          id: 'library',
          data: {
            ...LIBRARY_PROJECT.data,
            id: 'library',
            order: ['finalized', 'pending'],
          },
        },
      }),
      imports: [{
        doc: 'pending',
        sourceName: 'pending.txt',
        library: `txt:${'p'.repeat(64)}`,
        status: 'planned',
        published: false,
      }],
    };
    const { store, port } = harness(active, { seed: true });
    const [kept, removed] = store.getState().notebook.groups;
    store.getState().setSolo(kept!.id);
    store.getState().removeGroup(removed!.id);
    expect(store.getState().removedGroups).toHaveLength(1);

    expect(store.getState().clearActiveInputsAndTerms()).toEqual({ texts: 2, terms: 1 });
    expect(port.calls.filter((call) => call.method === 'removeDocuments')).toEqual([{
      method: 'removeDocuments',
      args: [['finalized', 'pending']],
    }]);
    expect(store.getState()).toMatchObject({
      notebook: { groups: [] },
      activeGroupIds: new Set(),
      soloGroupId: null,
      styles: new Map(),
      series: [],
      removedGroups: [],
    });
  });

  it('refuses to clear terms before a project is available', () => {
    const runtime = createAppRuntime(fakeQueryClient().client);
    runtime.useApp.getState().mergeStarterTerms('Watson');
    expect(runtime.useApp.getState().clearActiveInputsAndTerms()).toEqual({ texts: 0, terms: 0 });
    expect(runtime.useApp.getState().notebook.groups.map(groupTitle)).toEqual(['Watson']);
    expect(runtime.useApp.getState().commandError).toBe('the project is still initializing');
    runtime.dispose();
  });

  it('keeps the notebook intact when the session refuses the batch removal', () => {
    const active = sessionState(null, {
      project: {
        id: 'library',
        data: { ...LIBRARY_PROJECT.data, id: 'library', order: ['active'] },
      },
    });
    const { store, port } = harness(active, { seed: true });
    const removed = store.getState().notebook.groups[1]!;
    store.getState().removeGroup(removed.id);
    expect(store.getState().removedGroups).toHaveLength(1);
    port.errors.removeDocuments = new SessionCommandError('batch removal refused');

    expect(store.getState().clearActiveInputsAndTerms()).toEqual({ texts: 0, terms: 0 });
    expect(store.getState().notebook.groups.map(groupTitle)).toEqual(['Holmes']);
    expect(store.getState().activeGroupIds.size).toBe(1);
    expect(store.getState().removedGroups).toHaveLength(1);
    expect(store.getState().commandError).toBe('batch removal refused');
    expect(port.calls.filter((call) => call.method === 'removeDocuments')).toHaveLength(1);
  });

  it('keeps unrelated term undo history when only texts are cleared', () => {
    const active = sessionState(null, {
      project: {
        id: 'library',
        data: { ...LIBRARY_PROJECT.data, id: 'library', order: ['active'] },
      },
    });
    const { store } = harness(active);
    store.getState().mergeStarterTerms('Holmes');
    store.getState().removeGroup(store.getState().notebook.groups[0]!.id);
    expect(store.getState().notebook.groups).toHaveLength(0);
    expect(store.getState().removedGroups).toHaveLength(1);

    expect(store.getState().clearActiveInputsAndTerms()).toEqual({ texts: 1, terms: 0 });
    expect(store.getState().removedGroups).toHaveLength(1);
  });

  it('treats an already-empty local workspace as a command-free no-op', () => {
    const empty = sessionState(null, { project: { id: 'library' } });
    const { store, port } = harness(empty);
    expect(store.getState().clearActiveInputsAndTerms()).toEqual({ texts: 0, terms: 0 });
    expect(port.calls).toHaveLength(0);
  });

  it('merges starter terms additively and activates only those that fit', () => {
    const { store } = harness(undefined, { seed: true });
    expect(store.getState().notebook.groups.map(groupTitle)).toEqual(['Holmes', 'Moriarty']);
    expect(store.getState().mergeStarterTerms('Holmes, Jon, Tyrion, Daenerys')).toEqual({
      added: 3,
      activated: 3,
      skipped: 1,
    });
    expect(store.getState().notebook.groups.map(groupTitle)).toEqual([
      'Holmes', 'Moriarty', 'Jon', 'Tyrion', 'Daenerys',
    ]);
    expect(store.getState().activeGroupIds.size).toBe(5);

    expect(store.getState().mergeStarterTerms('Sauron')).toEqual({ added: 1, activated: 0, skipped: 0 });
    expect(store.getState().notebook.groups.map(groupTitle).at(-1)).toBe('Sauron');
    expect(store.getState().activeGroupIds.size).toBe(5);
  });

  it('preserves notebook and comparison when replacement admission fails', () => {
    const { store, port } = harness(undefined, { seed: true });
    const before = store.getState();
    port.errors.replaceFiles = new SessionCommandError('replacement refused');
    expect(store.getState().replaceInputsAndTerms([])).toBeNull();
    expect(store.getState().notebook).toBe(before.notebook);
    expect(store.getState().keynessView).toBe(before.keynessView);
    expect(store.getState().commandError).toContain('replacement refused');
    delete port.errors.replaceFiles;
    expect(store.getState().replaceInputsAndTerms([])?.terms).toBe(2);
    expect(store.getState().commandError).toBeNull();
    expect(store.getState().notebook.groups).toHaveLength(0);
  });

  it('importFiles appends to the library-backed corpus', () => {
    const { store, port } = harness();
    const files: LocalLibraryFile[] = [{
      name: 'a.txt',
      size: 3,
      format: 'txt',
      contentHash: 'a'.repeat(64),
      library: `txt:${'a'.repeat(64)}`,
      arrayBuffer: async () => new ArrayBuffer(3),
    }];
    store.getState().importFiles(files);
    expect(port.calls.at(-1)!.method).toBe('appendFiles');
  });

  it('a synchronous SessionCommandError becomes one bounded UI command error', () => {
    const { store, port } = harness();
    port.errors.removeDocument = new SessionCommandError('removeDocument requires a library corpus');
    store.getState().removeDocument('d');
    expect(store.getState().commandError).toContain('library corpus');
    store.getState().clearCommandError();
    expect(store.getState().commandError).toBeNull();
  });

  it('a command before any session is attached surfaces a bounded error, not a throw', () => {
    const q = fakeQueryClient();
    const runtime = createAppRuntime(q.client); // no attachSession
    expect(() => runtime.useApp.getState().removeDocument('d')).not.toThrow();
    expect(runtime.useApp.getState().commandError).toContain('initializing');
  });

  it('keeps startup notices separate from command errors and reports durability failures as retryable', () => {
    const q = fakeQueryClient();
    const runtime = createAppRuntime(q.client);
    runtime.reportNotice('migration started');
    expect(runtime.useApp.getState()).toMatchObject({
      appNotice: 'migration started',
      commandError: null,
    });
    runtime.useApp.getState().clearAppNotice();
    expect(runtime.useApp.getState().appNotice).toBeNull();

    runtime.reportWorkspaceFailure(new Error('quota'));
    expect(runtime.useApp.getState().workspacePersistence).toEqual({
      phase: 'error',
      message: 'Workspace could not be saved: quota',
    });
    runtime.dispose();
  });

  it('mirrors analysis loading detail and error into the header fields', () => {
    const { store, port } = harness();
    port.emit(sessionState(null, { analysis: { phase: 'loading', detail: 'index: a-doc' } }));
    expect(store.getState().loadingPhase).toBe('index: a-doc');
    expect(store.getState().loadError).toBeNull();
    port.emit(sessionState(null, { analysis: { phase: 'error', message: 'boom', fatal: false } }));
    expect(store.getState().loadError).toBe('boom');
    expect(store.getState().loadingPhase).toBeNull();
  });

  it('dispose fences the bridge: a later publication does not update the store', () => {
    const { store, port, runtime, trends } = harness();
    port.publishSnapshot('g1', 's1');
    const t1 = trends().length;
    runtime.dispose();
    expect(port.disposed).toBe(true);
    port.publishSnapshot('g2', 's2');
    expect(store.getState().snapshot!.snapshot).toBe('s1'); // unchanged
    expect(trends().length).toBe(t1); // no reissue
  });

  it('dispose cancels in-flight queries AND a late settlement cannot write (even uncancelled)', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    const q = f.trends().filter((t) => !t.cancelled).at(-1)!;
    f.runtime.dispose();
    expect(q.cancelled).toBe(true); // best-effort transport cleanup ran
    // Even if the worker never acknowledged the cancel, the settled result's
    // lease is dead — the store must not mutate after disposal.
    const before = f.store.getState().trends;
    q.resolve({ op: 'trend', trend: fakeTrend(3) });
    await flush();
    expect(f.store.getState().trends).toBe(before); // no write, same map identity
  });

  it('a session attached AFTER dispose is disposed, never bridged (late async bootstrap)', () => {
    // No harness(): the race under test is dispose BEFORE any attachment.
    const q = fakeQueryClient();
    const runtime = createAppRuntime(q.client);
    runtime.dispose();
    const late = new FakeSessionPort();
    runtime.attachSession(late);
    expect(late.disposed).toBe(true); // the runtime owns and retires it
    expect(runtime.useApp.getState().bootstrap.phase).toBe('initializing'); // never seeded
    // And a torn-down runtime reports no late bootstrap failure either.
    runtime.failBootstrap(new Error('late'));
    expect(runtime.useApp.getState().bootstrap.phase).toBe('initializing');
  });

  it('dispose cancels the active Matches window and scrub cannot mint another', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const window = f.kwics().filter((query) => !query.cancelled).at(-1)!;
    const count = f.kwics().length;
    f.store.getState().setScrub({ doc: 'a', token: 100 });
    expect(f.kwics()).toHaveLength(count);
    f.runtime.dispose();
    expect(window.cancelled).toBe(true);
    expect(f.kwics()).toHaveLength(count);
  });
});

describe('real ProjectSession composes with the store bridge', () => {
  beforeAll(async () => {
    // Warm the shared memoized canonical hashes so startGeneration settles fast.
    const { canonicalRecipeHashes } = await import('./support/spec-fixtures.ts');
    await canonicalRecipeHashes();
  });

  it('attaching a real session mirrors its analysis + snapshot into the store', async () => {
    const { ProjectSession } = await import('../src/lib/project-session.ts');
    const { canonicalRecipeHashes } = await import('./support/spec-fixtures.ts');
    const canon = await canonicalRecipeHashes();
    const { txt } = canon.recipes;
    const [erh, irh] = [canon.txtRecipeHash, canon.indexRecipeHash];
    const doc = {
      doc: 'd1',
      sourceName: 'd1',
      meta: { title: 'D1', language: 'en', tags: [] as string[] },
      source: { hash: 'a'.repeat(64), byteLength: 10, format: 'txt' as const },
      library: `txt:${'a'.repeat(64)}`,
      extraction: { recipe: txt, recipeHash: erh, text: 'txthash', textLengthUtf16: 8 },
    };
    const data = { id: 'library', order: ['d1'], docs: [doc], indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: irh };

    // A minimal fake ProjectSessionClient: open resolves a warm snapshot, so the
    // session publishes a ready snapshot without needing bytes.
    const hold: { snapshotL: ((i: SnapshotInfo) => void) | null } = { snapshotL: null };
    const client = {
      onSnapshot: (l: (i: SnapshotInfo) => void) => { hold.snapshotL = l; },
      onProgress: () => undefined,
      onIngestError: () => undefined,
      onSourceReady: () => undefined,
      onRestart: () => undefined,
      openGeneration: (generation: string) => ({
        result: Promise.resolve({ generation, snapshot: `${generation}#snap`, readyDocs: ['d1'], missingDocs: [] }),
        cancel: () => undefined,
      }),
      ingest: () => ({ job: 1 }),
    };
    const session = new ProjectSession(data, {
      client,
      libraryFiles: { get: async () => { throw new Error('not used'); } },
      newDocId: () => 'id',
    });

    const q = fakeQueryClient();
    const runtime = createAppRuntime(q.client);
    runtime.attachSession(session); // proves ProjectSession is assignable to SessionPort
    runtime.useApp.getState().mergeStarterTerms('Holmes, Moriarty');
    expect(runtime.useApp.getState().projectSession!.project.id).toBe('library');

    session.start();
    expect(runtime.useApp.getState().projectSession!.analysis.phase).toBe('loading');
    // Let the open barrier resolve and the warm snapshot publish.
    await flush();
    hold.snapshotL?.({ generation: 'library#gen-1', snapshot: 'library#gen-1#snap', readyDocs: ['d1'], missingDocs: [] });
    expect(runtime.useApp.getState().snapshot?.snapshot).toBe('library#gen-1#snap');
    // The store issued its default-series trend queries against the new snapshot.
    expect(q.trends().length).toBeGreaterThan(0);
    runtime.dispose();
  });
});
