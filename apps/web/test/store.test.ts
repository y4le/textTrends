/**
 * Commit 7c — the UI store as the sole React-facing projection, driven through
 * a fake `SessionPort` state emitter and a fake `QueryClient`. Two concerns:
 *
 * 1. The bridge: one-shot attachment seeds current state, mirrors snapshot +
 *    analysis, and reissues queries ONLY on a (generation, snapshot) identity
 *    change (including → null). Thin command wrappers forward to the attached
 *    session and translate a synchronous SessionCommandError into one bounded
 *    UI error. A second attachment is rejected; dispose fences the bridge.
 * 2. The retained query/KWIC/scrub intent discipline (unchanged from the
 *    listener-owning store): lease lanes, snapshot fences, and stale-result guards.
 *
 * The generation lifecycle (built-in fetch/restart/library import)
 * moved WHOLESALE to `ProjectSession` and is covered in project-session.test.ts;
 * those store-owned tests are deleted here. One composition test proves the real
 * `ProjectSession` satisfies `SessionPort` and drives the bridge end to end.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createAppRuntime,
  DEFAULT_KEYNESS_VIEW,
  emptyLibraryWorkspace,
  MAX_SERIES,
  occurrenceNavigationText,
  workspaceFromApp,
  workspaceSemanticKey,
  type MetaPatch,
  type QueryClient,
  type SessionPort,
  type WorkspaceStorePort,
} from '../src/lib/store.ts';
import type { HistoryPort } from '../src/lib/history-port.ts';
import type { QueryResultDataV4 } from '../src/worker/protocol-v4.ts';
import type {
  AnalysisPhase,
  ProjectView,
  SessionState,
} from '../src/lib/project-session.ts';
import { SessionCommandError } from '../src/lib/project-session.ts';
import { BUILTIN_SHERLOCK_ID, SHERLOCK } from '../src/lib/project.ts';
import { WorkerClientError } from '../src/lib/client.ts';
import type { SnapshotInfo } from '../src/lib/client.ts';
import {
  DEFAULT_INDEX_RECIPE,
  parseWorkspace,
  STOPLIST_EN_ID,
  STOPLIST_EN_VERSION,
  TERM_GROUP_LIMITS_V1,
  type NumericTrend,
  type WorkspaceV1,
} from '@texttrends/core';
import { workspaceState } from './support/workspace-fixtures.ts';
import type { LocalLibraryFile } from '../src/lib/local-library.ts';
import { coreGroupOf, groupTitle, type NotebookGroupV1 } from '../src/lib/notebook.ts';
import { COMPARE_MAX_RESIDENT_ROWS } from '../src/lib/compare-scroll.ts';
import {
  RSVP_RHYTHM_PRESETS,
  RSVP_RHYTHM_RESET,
  type RsvpPacing,
} from '@texttrends/rsvp';

// ── A fake QueryClient that records issued analysis queries. ──
interface Issued {
  snapshot: string;
  term: string;
  groupId: string;
  memberId: string;
  op: string;
  query: unknown;
  resolve: (r: QueryResultDataV4) => void;
  reject: (e: Error) => void;
  cancelled: boolean;
}

function fakeQueryClient() {
  const issued: Issued[] = [];
  const client: QueryClient = {
    query: (snapshot, query) => {
      const q = query as unknown as {
        op: string;
        group?: { id: string; members: { id: string; surface: string }[] };
        track?: { seriesId: string; group: { id: string; members: { id: string; surface: string }[] } };
        tracks?: readonly { seriesId: string; group: { id: string; members: readonly { id: string; surface: string }[] } }[];
        request?: { doc: string; centerToken: number; tracks: { seriesId: string }[] };
      };
      // Single-track operations carry `group`; merged operations carry
      // `tracks` (the first track's group is sufficient for these fixtures).
      const primaryGroup = q.group ?? q.track?.group ?? q.tracks?.[0]?.group;
      const entry: Issued = {
        snapshot,
        term: primaryGroup?.members[0]?.surface ?? q.request?.doc ?? '',
        groupId: primaryGroup?.id ?? '',
        memberId: primaryGroup?.members[0]?.id ?? '',
        op: q.op,
        query,
        resolve: () => undefined,
        reject: () => undefined,
        cancelled: false,
      };
      const result = new Promise<QueryResultDataV4>((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      issued.push(entry);
      return {
        result,
        // Realistic: cancel only MARKS intent (a real worker may still emit a
        // raced result afterward) — the store's lease gate must protect.
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
  };
  const isKeynessInventory = (candidate: Issued): boolean => {
    if (candidate.op !== 'inventory') return false;
    const selection = (candidate.query as { selection?: unknown }).selection;
    return issued.some((entry) => {
      if (entry.op !== 'keyness') return false;
      const request = (entry.query as {
        request?: { a?: unknown; b?: unknown };
      }).request;
      return [request?.a, request?.b].some(
        (side) => side !== undefined
          && JSON.stringify(side) === JSON.stringify(selection),
      );
    });
  };
  return {
    client,
    issued,
    trends: () => issued.filter((q) => q.op === 'trend'),
    kwics: () => issued.filter((q) => q.op === 'matches-window'),
    readers: () => issued.filter((q) => q.op === 'reader-page'),
    occurrenceSteps: () => issued.filter((q) => q.op === 'occurrence-step'),
    inventories: () => issued.filter(
      (q) => q.op === 'inventory' && !isKeynessInventory(q),
    ),
    keynessInventories: () => issued.filter(isKeynessInventory),
    frequencies: () => issued.filter((q) => q.op === 'freq-list'),
    keynesses: () => issued.filter((q) => q.op === 'keyness'),
    companies: () => issued.filter((q) => q.op === 'company'),
    destinations: () => issued.filter((q) => q.op === 'destinations'),
  };
}

class FakeHistoryPort implements HistoryPort {
  readonly entries: Array<{ state: unknown; url: string }>;
  private index = 0;
  private readonly listeners = new Set<() => void>();
  pushes = 0;
  replaces = 0;
  backs = 0;
  leftApp = 0;
  deferBack = false;
  private queuedBack = 0;

  constructor(url = '/textTrends/?p=trends') {
    this.entries = [{ state: null, url }];
  }

  get state() {
    return this.entries[this.index]!.state;
  }

  get url() {
    return this.entries[this.index]!.url;
  }

  push(state: unknown, url: string) {
    this.entries.splice(this.index + 1, Infinity, { state, url });
    this.index += 1;
    this.pushes += 1;
  }

  replace(state: unknown, url: string) {
    this.entries[this.index] = { state, url };
    this.replaces += 1;
  }

  back(steps = 1) {
    this.backs += 1;
    if (this.deferBack) {
      this.queuedBack = steps;
      return;
    }
    this.commitBack(steps);
  }

  flushBack() {
    if (this.queuedBack === 0) return;
    const steps = this.queuedBack;
    this.queuedBack = 0;
    this.commitBack(steps);
  }

  private commitBack(steps = 1) {
    if (this.index === 0) {
      this.leftApp += 1;
      return;
    }
    this.index = Math.max(0, this.index - steps);
    this.emit();
  }

  forward() {
    if (this.index >= this.entries.length - 1) return;
    this.index += 1;
    this.emit();
  }

  restore(state: unknown, url: string) {
    this.entries[this.index] = { state, url };
    this.emit();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

function layerIds() {
  let next = 0;
  return () =>
    `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
}

// ── A fake SessionPort: a spyable immutable-state emitter. ──
const BUILTIN_PROJECT: ProjectView = {
  kind: 'builtin',
  id: 'builtin/sherlock',
  data: { id: 'builtin/sherlock', order: [], docs: [], indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: 'idx' },
};

function snap(generation: string, snapshot: string, readyDocs: readonly string[] = ['a']): SnapshotInfo {
  return { generation, snapshot, readyDocs, missingDocs: [] };
}

function sessionState(
  snapshot: SnapshotInfo | null,
  opts: { analysis?: AnalysisPhase; project?: Partial<ProjectView> } = {},
): SessionState {
  return {
    project: { ...BUILTIN_PROJECT, ...opts.project },
    analysis: opts.analysis ?? (snapshot ? { phase: 'ready' } : { phase: 'loading', detail: null }),
    snapshot,
    imports: [],
    sources: {},
    extractionDiagnostics: {},
  };
}

interface Call {
  method: string;
  args: readonly unknown[];
}

class FakeSessionPort implements SessionPort {
  private state: SessionState;
  private readonly listeners = new Set<(s: SessionState) => void>();
  readonly calls: Call[] = [];
  /** Per-method thrower — set to make a command throw (SessionCommandError). */
  errors: Record<string, SessionCommandError | undefined> = {};
  disposed = false;

  constructor(initial: SessionState = sessionState(null)) {
    this.state = initial;
  }

  getState(): SessionState { return this.state; }
  subscribe(listener: (s: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose(): void { this.disposed = true; }

  /** Test driver: publish a new immutable state to subscribers. */
  emit(next: SessionState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }
  publishSnapshot(generation: string, snapshot: string, readyDocs?: readonly string[]): void {
    this.emit(sessionState(snap(generation, snapshot, readyDocs)));
  }

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args });
    const e = this.errors[method];
    if (e) throw e;
  }
  start(): void { this.record('start', []); }
  openBuiltinProject(id: string): void { this.record('openBuiltinProject', [id]); }
  createLibraryCorpus(files: readonly LocalLibraryFile[]): void { this.record('createLibraryCorpus', [files]); }
  appendFiles(files: readonly LocalLibraryFile[]): void { this.record('appendFiles', [files]); }
  removeImport(doc: string): void { this.record('removeImport', [doc]); }
  removeDocument(doc: string): void { this.record('removeDocument', [doc]); }
  removeDocuments(docs: readonly string[]): void { this.record('removeDocuments', [docs]); }
  editMeta(doc: string, patch: MetaPatch): void { this.record('editMeta', [doc, patch]); }
  setLanguage(doc: string, language: string): void { this.record('setLanguage', [doc, language]); }
  reorder(order: readonly string[]): void { this.record('reorder', [order]); }
}

class FakeWorkspaceStore implements WorkspaceStorePort {
  readonly saves: WorkspaceV1[] = [];
  error: Error | null = null;

  async saveWorkspace(workspace: WorkspaceV1): Promise<void> {
    this.saves.push(workspace);
    if (this.error !== null) throw this.error;
  }
}

function fakeTrend(marker: number): NumericTrend {
  return {
    coordinate: 'declared-sequence',
    bins: { mode: 'per-doc', count: 4 },
    rowOffsets: Uint32Array.from([0, 1]),
    docOrdinal: Uint32Array.from([0]),
    binIndex: Uint32Array.from([0]),
    binStartToken: Uint32Array.from([0]),
    binTokens: Uint32Array.from([10]),
    count: Uint32Array.from([marker]),
    ratePer10k: Float64Array.from([marker]),
    order: ['a'],
    sequenceBases: [0],
    docTokenCount: [10],
  };
}

function fakeCompanyResult(entry: Issued): QueryResultDataV4 {
  const wire = entry.query as {
    tracks: readonly { readonly seriesId: string; readonly group: { readonly id: string } }[];
    request: { readonly gapEdges: readonly number[] };
  };
  const histogram = wire.request.gapEdges.map(() => 0);
  return {
    op: 'company',
    company: {
      method: 'company/1',
      gapEdges: [...wire.request.gapEdges],
      tracks: wire.tracks.map((track) => ({
        seriesId: track.seriesId,
        groupId: track.group.id,
        total: 1,
        docCount: 1,
      })),
      corpusTokens: 10,
      pairs: wire.tracks.length < 2 ? [] : [{
        a: 0,
        b: 1,
        fromA: [...histogram],
        fromB: [...histogram],
        noneA: 0,
        noneB: 0,
        forwardA: 0,
        backwardA: 0,
        tiedA: 0,
        overlapA: 0,
        forwardB: 0,
        backwardB: 0,
        tiedB: 0,
        overlapB: 0,
        docsWithBoth: 1,
      }],
    },
  };
}

function fakeDestinationsResult(entry: Issued): QueryResultDataV4 {
  const wire = entry.query as {
    tracks: readonly { readonly seriesId: string; readonly group: { readonly id: string } }[];
    request: {
      readonly windowTokens: 400;
      readonly focus: { readonly a: number; readonly b: number } | null;
    };
  };
  return {
    op: 'destinations',
    destinations: {
      method: 'destinations/1',
      windowTokens: wire.request.windowTokens,
      focus: wire.request.focus,
      tracks: wire.tracks.map((track) => ({
        seriesId: track.seriesId,
        groupId: track.group.id,
        total: 1,
        weight: 65_536,
      })),
      destinations: [],
    },
  };
}

function fakeMatches(
  total = 0,
  rows: Extract<QueryResultDataV4, { op: 'matches-window' }>['window']['rows'] = [],
  includeAxis = true,
): QueryResultDataV4 {
  return {
    op: 'matches-window',
    window: {
      method: 'matches-window/1',
      total,
      trackCount: 1,
      anchorRank: total > 0 ? 0 : null,
      firstRank: 0,
      preceding: null,
      rows,
      ...(includeAxis
        ? { axis: { ranks: total > 0 ? Uint32Array.of(0) : new Uint32Array(), globalTokens: total > 0 ? Uint32Array.of(0) : new Uint32Array() } }
        : {}),
    },
  };
}

function fakeReaderPage(
  start: number,
  end: number,
  docTokenCount = 10,
  doc = 'a',
  anchorToken?: number,
): QueryResultDataV4 {
  const count = end - start;
  return {
    op: 'reader-page',
    page: {
      method: 'reader-page/1',
      doc,
      tokens: { start, end },
      docCharsUtf16: { start, end },
      text: 'x'.repeat(count),
      tokenStartsUtf16: Array.from({ length: count }, (_, index) => index),
      tokenEndsUtf16: Array.from({ length: count }, (_, index) => index + 1),
      sentenceBounds: [0, count],
      paragraphBounds: [0, count],
      anchor: anchorToken === undefined
        ? null
        : {
            token: anchorToken,
            relToken: anchorToken - start,
            charsUtf16: { start: anchorToken - start, end: anchorToken - start + 1 },
          },
      previous: start === 0 ? null : { kind: 'before', token: start },
      next: end === docTokenCount ? null : { kind: 'from', token: end },
      atStart: start === 0,
      atEnd: end === docTokenCount,
      docTokenCount,
      cappedBy: end === docTokenCount ? null : 'tokens',
      marks: [],
      marksTruncated: false,
    },
  };
}

function fakeInventoryResult(
  marker: number,
  extents: readonly { readonly doc: string; readonly fullTokens: number }[] = [],
): QueryResultDataV4 {
  return {
    op: 'inventory',
    inventory: {
      method: 'inventory/1',
      selection: `selection-${marker}`,
      order: extents.length === 0 ? ['a'] : extents.map((row) => row.doc),
      totals: {
        selectedDocs: 1,
        expectedDocs: 1,
        missingDocs: 0,
        tokens: marker,
        lexicalTokens: marker,
        numeralTokens: 0,
        types: 1,
        hapax: 0,
        sentences: 1,
        paragraphs: 1,
        charsUtf16: marker,
      },
      documents: extents.map((row) => ({
        doc: row.doc,
        fullTokens: row.fullTokens,
      })),
      rhythm: null,
      missingDocs: [],
      mattrWindow: 500,
    },
  } as unknown as QueryResultDataV4;
}

function fakeFrequencyResult(marker: number): QueryResultDataV4 {
  return {
    op: 'freq-list',
    frequency: {
      method: 'freq-list/2',
      selection: `selection-${marker}`,
      total: marker,
      totalTokens: marker,
      parts: 1,
      rows: [],
    },
  } as unknown as QueryResultDataV4;
}

function fakeFrequencyPage(
  selection: string,
  total: number,
  rows: readonly { readonly key: string; readonly typeId: number }[],
): QueryResultDataV4 {
  return {
    op: 'freq-list',
    frequency: {
      method: 'freq-list/2',
      selection,
      total,
      totalTokens: 12,
      parts: 1,
      rows: rows.map((row) => ({
        ...row,
        class: 'lexical',
        count: 1,
        ratePer10k: 1,
        docFreq: 1,
        dp: 0,
        dpNorm: null,
      })),
    },
  } as unknown as QueryResultDataV4;
}

function fakeKeynessPage(
  total: number,
  typeIds: readonly number[],
): QueryResultDataV4 {
  return {
    op: 'keyness',
    keyness: {
      method: 'keyness-g2-2x2/1',
      effect: 'log-ratio-halves/1',
      selectionA: 'a' as never,
      selectionB: 'b' as never,
      totalsA: { tokens: 10, documents: 1, positiveParts: 1 },
      totalsB: { tokens: 10, documents: 1, positiveParts: 1 },
      divergence: { method: 'jsd-log2/1' as const, bits: 0.5, types: 2 },
      total,
      rows: typeIds.map((typeId) => ({
        key: `term-${typeId}`,
        typeId,
        class: 'lexical' as const,
        countA: 2,
        countB: 1,
        rateAper10k: 2_000,
        rateBper10k: 1_000,
        logRatio: 1,
        logRatioLow: 1 - 1,
        logRatioHigh: 1 + 1,
        g2: 1,
        rangeA: 1,
        rangeB: 1,
        dpA: null,
        dpB: null,
      })),
    },
  };
}

/** A runtime with a fresh fake QueryClient + an attached fake SessionPort. */
function harness(initial?: SessionState, opts?: {
  seed?: boolean;
  workspace?: FakeWorkspaceStore;
  rsvpPacing?: RsvpPacing;
}) {
  const q = fakeQueryClient();
  // Deterministic injected UUIDs: u1, u2, … (creation order).
  let n = 0;
  const runtime = createAppRuntime(q.client, {
    newId: () => `u${++n}`,
    ...(opts?.workspace === undefined ? {} : { workspace: opts.workspace }),
    ...(opts?.rsvpPacing === undefined ? {} : { rsvpPacing: opts.rsvpPacing }),
  });
  const port = new FakeSessionPort(initial);
  runtime.attachSession(port);
  // The store starts EMPTY (the composition root seeds the demo comparison
  // in production — store-instance.ts). Bridge tests that need series present
  // BEFORE a publication opt in with seed:true.
  if (opts?.seed === true) runtime.useApp.getState().quickAdd('Holmes, Moriarty');
  return { ...q, runtime, store: runtime.useApp, port };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('workbench route and history authority', () => {
  it('resolves a p-less boot exactly once from the attached corpus without pushing history', () => {
    const emptyHistory = new FakeHistoryPort('/textTrends/?foreign=kept');
    const emptyRuntime = createAppRuntime(fakeQueryClient().client, { history: emptyHistory });
    expect(emptyRuntime.useApp.getState()).toMatchObject({
      place: 'inputs',
      routeStatus: 'pending',
    });
    expect(emptyHistory.url).toBe('/textTrends/?foreign=kept');
    emptyRuntime.attachSession(new FakeSessionPort(sessionState(null, {
      project: { data: { ...BUILTIN_PROJECT.data, order: [] } },
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
      project: { data: { ...BUILTIN_PROJECT.data, order: ['a'] } },
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
      project: { data: { ...BUILTIN_PROJECT.data, order: [] } },
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
      project: { data: { ...BUILTIN_PROJECT.data, order: ['a'] } },
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
      project: { data: { ...BUILTIN_PROJECT.data, order: ['a'] } },
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

    const navigation = {
      place: store.getState().place,
      layers: store.getState().layers,
    };
    store.getState().restoreWorkspace(workspaceState(BUILTIN_SHERLOCK_ID));
    expect(store.getState()).toMatchObject(navigation);

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

describe('the session bridge', () => {
  it('defines a fresh install as a valid empty library workspace', () => {
    const workspace = parseWorkspace(emptyLibraryWorkspace());
    expect(workspace.corpus).toEqual({ kind: 'library', order: [], docs: [] });
    expect(workspace.notebook.groups).toEqual([]);
    expect(workspace.active).toEqual([]);
    expect(workspace.views.trend.mode).toBe('by-book');
    expect(workspace.views.trend).not.toHaveProperty('focusedDoc');
    expect(workspace.views.compare.documentA).toBeNull();
    expect(workspace.views.compare.documentB).toBeNull();
  });

  it('autosaves workspace changes after 1.5 seconds and excludes transient paging', async () => {
    vi.useFakeTimers();
    try {
      const workspace = new FakeWorkspaceStore();
      const { runtime, store } = harness(undefined, { workspace });
      store.getState().quickAdd('Watson');
      expect(store.getState().workspacePersistence.phase).toBe('dirty');
      await vi.advanceTimersByTimeAsync(1_500);
      expect(workspace.saves).toHaveLength(1);
      expect(workspace.saves[0]).toMatchObject({
        schema: 'texttrends/workspace/1',
        corpus: { kind: 'builtin', id: BUILTIN_SHERLOCK_ID },
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
        ...sessionState(null, { project: { kind: 'library', id: 'library' } }),
        imports: [{
          doc: 'failed-doc',
          sourceName: 'failed.txt',
          library: `txt:${'f'.repeat(64)}`,
          status: 'failed',
          published: false,
        }],
      };
      port.emit(failed);
      store.getState().quickAdd('Moriarty');
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

  it('surfaces a workspace write failure and retries the latest state', async () => {
    vi.useFakeTimers();
    try {
      const workspace = new FakeWorkspaceStore();
      workspace.error = new Error('quota full');
      const { runtime, store } = harness(undefined, { workspace });
      store.getState().quickAdd('Lestrade');
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

  it('restores a workspace notebook from active state, ignoring the deprecated Matches filter', async () => {
    const q = fakeQueryClient();
    const runtime = createAppRuntime(q.client, { newId: () => 'new' });
    const port = new FakeSessionPort(sessionState(null, {
      project: { data: { ...BUILTIN_PROJECT.data, order: ['a', 'b'] } },
    }));
    const durable = {
        ...workspaceState(BUILTIN_SHERLOCK_ID),
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
        kwicEnabled: [],
        views: {
          ...workspaceState(BUILTIN_SHERLOCK_ID).views,
          trend: {
            mode: 'by-book',
            focusedDoc: null,
            bins: { mode: 'fixed-tokens', count: 500 },
            measure: {
              kind: 'rate',
              denominator: 100_000,
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
      kwicEnabled: ['durable'],
    });
    runtime.dispose();
  });

  it('retains restored Compare selections through pre-snapshot loading publications', () => {
    const q = fakeQueryClient();
    const runtime = createAppRuntime(q.client);
    const project = {
      ...BUILTIN_PROJECT,
      data: { ...BUILTIN_PROJECT.data, order: ['a'] },
    };
    const port = new FakeSessionPort(sessionState(null, { project }));
    const base = workspaceState(BUILTIN_SHERLOCK_ID);
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
      const durable = workspaceState(BUILTIN_SHERLOCK_ID);
      runtime.attachSession(port);
      runtime.useApp.getState().restoreWorkspace({
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
    const userState = sessionState(null, { project: { kind: 'library', id: 'library' } });
    runtime.attachSession(new FakeSessionPort(userState));
    const s = runtime.useApp.getState();
    expect(s.bootstrap.phase).toBe('attached');
    expect(s.projectSession).toBe(userState);
    expect(s.projectSession!.project.kind).toBe('library');
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
      project: { data: { ...BUILTIN_PROJECT.data, indexRecipeHash: 'changed' } },
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
    expect(trends().every((t) => t.cancelled)).toBe(true);
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
          kind: 'library',
          id: 'library',
          data: {
            ...BUILTIN_PROJECT.data,
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
      inputError: null,
    });
  });

  it('refuses an unavailable or read-only corpus without partially clearing terms', () => {
    const runtime = createAppRuntime(fakeQueryClient().client);
    runtime.useApp.getState().quickAdd('Watson');
    expect(runtime.useApp.getState().clearActiveInputsAndTerms()).toEqual({ texts: 0, terms: 0 });
    expect(runtime.useApp.getState().notebook.groups.map(groupTitle)).toEqual(['Watson']);
    expect(runtime.useApp.getState().commandError).toBe('the project is still initializing');
    runtime.dispose();

    const readonly = sessionState(null, {
      project: { data: { ...BUILTIN_PROJECT.data, order: ['bundled'] } },
    });
    const { store, port } = harness(readonly, { seed: true });
    expect(store.getState().clearActiveInputsAndTerms()).toEqual({ texts: 0, terms: 0 });
    expect(store.getState().notebook.groups.map(groupTitle)).toEqual(['Holmes', 'Moriarty']);
    expect(store.getState().commandError).toMatch(/requires a library corpus/);
    expect(port.calls).toHaveLength(0);
  });

  it('keeps the notebook intact when the session refuses the batch removal', () => {
    const active = sessionState(null, {
      project: {
        kind: 'library',
        id: 'library',
        data: { ...BUILTIN_PROJECT.data, id: 'library', order: ['active'] },
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
        kind: 'library',
        id: 'library',
        data: { ...BUILTIN_PROJECT.data, id: 'library', order: ['active'] },
      },
    });
    const { store } = harness(active);
    store.getState().quickAdd('Holmes');
    store.getState().removeGroup(store.getState().notebook.groups[0]!.id);
    expect(store.getState().notebook.groups).toHaveLength(0);
    expect(store.getState().removedGroups).toHaveLength(1);

    expect(store.getState().clearActiveInputsAndTerms()).toEqual({ texts: 1, terms: 0 });
    expect(store.getState().removedGroups).toHaveLength(1);
  });

  it('treats an already-empty local workspace as a command-free no-op', () => {
    const empty = sessionState(null, { project: { kind: 'library', id: 'library' } });
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

  it('importFiles creates a library corpus from a built-in and then appends', () => {
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
    expect(port.calls.at(-1)!.method).toBe('createLibraryCorpus');
    port.emit(sessionState(snap('g1', 's1'), { project: { kind: 'library', id: 'library' } }));
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
    f.store.getState().quickAdd('holmes');
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
    f.store.getState().quickAdd('holmes');
    const window = f.kwics().filter((query) => !query.cancelled).at(-1)!;
    const count = f.kwics().length;
    f.store.getState().setScrub({ doc: 'a', token: 100 });
    expect(f.kwics()).toHaveLength(count);
    f.runtime.dispose();
    expect(window.cancelled).toBe(true);
    expect(f.kwics()).toHaveLength(count);
  });
});

describe('store query intent discipline', () => {
  it('issued group/member ids stay wire-bounded for the LONGEST legal label (ids derive from slots, not labels)', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    const longest = 'x'.repeat(TERM_GROUP_LIMITS_V1.maxSurfaceUnits);
    f.store.getState().quickAdd(longest);
    const q = f.trends().filter((t) => !t.cancelled).at(-1)!;
    expect(q.term).toBe(longest); // the label IS the surface, at full length
    expect(q.groupId.length).toBeLessThanOrEqual(TERM_GROUP_LIMITS_V1.maxIdUnits);
    expect(q.memberId.length).toBeGreaterThan(0);
    expect(q.memberId.length).toBeLessThanOrEqual(TERM_GROUP_LIMITS_V1.maxIdUnits);
  });

  it('issues one trend per series plus one MERGED KWIC over all enabled terms', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
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
    f.store.getState().quickAdd('bear');
    // Replace the comparison: remove bear (supersedes) and add hound.
    f.store.getState().removeGroup(f.store.getState().series[0]!.id);
    f.store.getState().quickAdd('hound');
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
    f.store.getState().quickAdd('holmes, moriarty');
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

    f.store.getState().quickAdd('watson');
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
    f.store.getState().quickAdd('holmes, moriarty');
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
    f.store.getState().quickAdd('holmes, moriarty');
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
    f.store.getState().quickAdd('holmes, moriarty');
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
    f.store.getState().quickAdd('holmes, moriarty');
    const moriarty = f.store.getState().series[1]!;
    f.store.getState().setGroupActive(moriarty.id, false);
    f.store.getState().quickAdd('holmes, watson, moriarty'); // add watson, keep the others
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
    f.store.getState().quickAdd('holmes');
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

    f.store.getState().clearScrub();
    expect((f.kwics().at(-1)!.query as { request: { anchor: unknown } }).request.anchor)
      .toEqual({ kind: 'rank', rank: 0 });
  });

  it('clearing the comparison and a snapshot-null transition discard axis state', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    f.store.getState().setScrub({ doc: 'a', token: 100 });
    f.store.getState().removeGroup(f.store.getState().series[0]!.id);
    expect(f.store.getState().kwic).toBeNull();
    f.store.getState().quickAdd('holmes');
    expect((f.kwics().filter((query) => !query.cancelled).at(-1)!.query as { request: { anchor: unknown } }).request.anchor)
      .toEqual({ kind: 'rank', rank: 0 });
    f.port.emit(sessionState(null));
    expect(f.store.getState().kwic).toBeNull();
  });

  it('scrubbing with no active terms leaves Matches absent and issues no window', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes, moriarty');
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
    f.store.getState().quickAdd('holmes, moriarty');
    const oldKwic = f.kwics().filter((q) => !q.cancelled).at(-1)!;
    f.store.getState().setGroupActive(f.store.getState().series[1]!.id, false); // reissues, supersedes oldKwic
    oldKwic.resolve(fakeMatches(9)); // raced past cancel
    await flush();
    expect(f.store.getState().kwic!.state.status).toBe('pending'); // the stale result did not land
  });

  it('view toggle is presentation-only: no query is issued', () => {
    const project = (order: readonly string[]) => ({
      data: { ...BUILTIN_PROJECT.data, order },
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

    const restored = workspaceState(BUILTIN_SHERLOCK_ID);
    f.store.getState().restoreWorkspace({
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
      kind: 'library' as const,
      id: 'library',
      data: { ...BUILTIN_PROJECT.data, id: 'library', order },
    });
    const migration = harness(sessionState(null, { project: project([]) }));
    const empty = emptyLibraryWorkspace();
    migration.store.getState().restoreWorkspace({
      ...empty,
      views: {
        ...empty.views,
        trend: { ...empty.views.trend, mode: 'by-book' },
      },
    });
    expect(migration.store.getState().trendView).toBe('by-book');

    // Starting analysis publishes the still-empty library before migration
    // stages any source files; the restored preference must survive that gap.
    migration.port.emit(sessionState(null, { project: project([]) }));
    expect(migration.store.getState().trendView).toBe('by-book');

    migration.port.emit({
      ...sessionState(snap('g1', 's1', ['a']), { project: project(['a']) }),
      imports: [{
        doc: 'b',
        sourceName: 'b.txt',
        library: `txt:${'b'.repeat(64)}`,
        status: 'extracting',
        published: false,
      }],
    });
    expect(migration.store.getState().trendView).toBe('by-book');

    migration.port.emit(sessionState(snap('g2', 's2', ['a', 'b']), {
      project: project(['a', 'b']),
    }));
    expect(migration.store.getState().trendView).toBe('by-book');
    migration.runtime.dispose();
  });

  it('normalizes a restored separate view when an import fails with one active text', () => {
    const project = {
      kind: 'library' as const,
      id: 'library',
      data: { ...BUILTIN_PROJECT.data, id: 'library', order: ['a'] },
    };
    const migration = harness(sessionState(null, {
      project: { ...project, data: { ...project.data, order: [] } },
    }));
    const empty = emptyLibraryWorkspace();
    migration.store.getState().restoreWorkspace({
      ...empty,
      views: {
        ...empty.views,
        trend: { ...empty.views.trend, mode: 'by-book' },
      },
    });
    migration.port.emit({
      ...sessionState(snap('g1', 's1', ['a']), { project }),
      imports: [{
        doc: 'b',
        sourceName: 'b.txt',
        library: `txt:${'b'.repeat(64)}`,
        status: 'failed',
        published: false,
      }],
    });
    expect(migration.store.getState().trendView).toBe('series');
    migration.runtime.dispose();
  });

  it('keeps display settings resident-only and reissues only trend lanes for bin changes', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes');
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
    f.store.getState().quickAdd('holmes');

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

    const workspace = workspaceState(BUILTIN_SHERLOCK_ID);
    f.store.getState().restoreWorkspace({
      ...workspace,
      views: {
        ...workspace.views,
        trend: {
          ...workspace.views.trend,
          bins: { mode: 'fixed-tokens', count: 250 },
        },
      },
    });
    expect(f.store.getState().trendBins).toEqual({ mode: 'fixed-tokens', count: 500 });
  });

  it('normalizes a persisted bin preference when expanded-corpus extents arrive', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const workspace = workspaceState(BUILTIN_SHERLOCK_ID);
    f.store.getState().restoreWorkspace({
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

    f.store.getState().setLinkedSelection({
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 10, end: 20 } }],
    });
    f.inventories().at(-1)!.resolve(fakeInventoryResult(10, [
      { doc: 'a', fullTokens: 1_000_000 },
    ]));
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
    f.store.getState().quickAdd('holmes, moriarty');
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
    f.store.getState().quickAdd('holmes');
    const before = workspaceSemanticKey(f.store.getState());
    const issued = f.issued.length;

    f.store.getState().setMatchesColumnWidth('left', 72);
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

    f.store.getState().setMatchesColumnWidth('node', -20);
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
    f.store.getState().setMatchesColumnWidth('left', 61);
    f.store.getState().setMatchesColumnWidth('right', 57);
    f.store.getState().quickAdd('ox, elephants');
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
    f.store.getState().quickAdd('holmes');
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
    f.store.getState().quickAdd('holmes');
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
    f.store.getState().quickAdd('holmes');
    const first = f.trends().filter((q) => !q.cancelled).at(-1)!;
    first.resolve({ op: 'trend', trend: fakeTrend(1) });
    await flush();
    expect(f.store.getState().trends.get(f.store.getState().series[0]!.id)!.status).toBe('ready');
    f.store.getState().quickAdd('other');
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
    f.store.getState().quickAdd('holmes');
    const q = f.trends().filter((x) => !x.cancelled).at(-1)!;
    q.resolve({ op: 'trend', trend: fakeTrend(3) });
    await flush();
    expect(f.store.getState().trends.size).toBe(1);
    const issued = f.issued.length;
    f.store.getState().quickAdd('  ,  '); // blank: nothing added, nothing touched
    expect(f.issued.length).toBe(issued);
    expect(f.store.getState().trends.size).toBe(1);
    f.store.getState().removeGroup(f.store.getState().series[0]!.id);
    expect(f.store.getState().trends.size).toBe(0);
    expect(f.store.getState().kwic).toBeNull();
    expect(q.cancelled).toBe(true);
    await flush();
    expect(f.store.getState().trends.size).toBe(0);
  });

  it('an over-room batch is refused ATOMICALLY: error surfaced, existing evidence and queries stand untouched', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes');
    const live = f.trends().filter((q) => !q.cancelled);
    expect(live.length).toBe(1);
    const issued = f.issued.length;
    f.store.getState().quickAdd('a, b, c, d, e, f'); // 6 new, room for 4
    expect(f.store.getState().inputError).toContain('room');
    expect(live[0]!.cancelled).toBe(false); // append-only: a refusal clears NOTHING
    expect(f.store.getState().series.map((s) => s.label)).toEqual(['holmes']);
    expect(f.issued.length).toBe(issued); // nothing new issued either
    // A later legal add clears the error.
    f.store.getState().quickAdd('watson');
    expect(f.store.getState().inputError).toBeNull();
  });

  it('scrub adopts a valid reading position without issuing Matches work', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    const kwicCount = f.kwics().length;

    f.store.getState().setScrub({ doc: 'a', token: 25 });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 25 });
    expect(f.kwics()).toHaveLength(kwicCount);
  });

  it('manifest byte lengths, source hashes, and text hashes match the shipped assets', async () => {
    const { readFile } = await import('node:fs/promises');
    const { hashSourceBytes, hashText } = await import('@texttrends/core');
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

describe('real ProjectSession composes with the store bridge', () => {
  beforeAll(async () => {
    // Warm the shared memoized canonical hashes so startGeneration settles fast.
    const { canonicalRecipeHashes } = await import('./support/spec-fixtures.ts');
    await canonicalRecipeHashes();
  });

  it('attaching a real session mirrors its analysis + snapshot into the store', async () => {
    const { ProjectSession } = await import('../src/lib/project-session.ts');
    const { builtinProject } = await import('../src/lib/project.ts');
    const { canonicalRecipeHashes } = await import('./support/spec-fixtures.ts');
    const canon = await canonicalRecipeHashes();
    const { txt } = canon.recipes;
    const [erh, irh] = [canon.txtRecipeHash, canon.indexRecipeHash];
    const doc = {
      doc: 'd1',
      sourceName: 'd1',
      meta: { title: 'D1', language: 'en', tags: [] as string[] },
      source: { hash: 'a'.repeat(64), byteLength: 10, format: 'txt' as const },
      sourceAvailability: 'bundled' as const,
      extraction: { recipe: txt, recipeHash: erh, text: 'txthash', textLengthUtf16: 8 },
    };
    const data = { id: 'builtin/x', order: ['d1'], docs: [doc], indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: irh };

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
    const session = new ProjectSession(builtinProject(data), {
      client,
      bundledBytes: { get: async () => new ArrayBuffer(10) },
      libraryFiles: { get: async () => { throw new Error('not used'); } },
      newDocId: () => 'id',
    });

    const q = fakeQueryClient();
    const runtime = createAppRuntime(q.client);
    runtime.attachSession(session); // proves ProjectSession is assignable to SessionPort
    // Mirror the composition root's demo seeding (store-instance.ts).
    runtime.useApp.getState().quickAdd('Holmes, Moriarty');
    expect(runtime.useApp.getState().projectSession!.project.kind).toBe('builtin');

    session.start();
    expect(runtime.useApp.getState().projectSession!.analysis.phase).toBe('loading');
    // Let the open barrier resolve and the warm snapshot publish.
    await flush();
    hold.snapshotL?.({ generation: 'builtin/x#gen-1', snapshot: 'builtin/x#gen-1#snap', readyDocs: ['d1'], missingDocs: [] });
    expect(runtime.useApp.getState().snapshot?.snapshot).toBe('builtin/x#gen-1#snap');
    // The store issued its default-series trend queries against the new snapshot.
    expect(q.trends().length).toBeGreaterThan(0);
    runtime.dispose();
  });
});

// ── The query-notebook state machine from the slice-1 notebook ruling. These
//    prove the model invariants through the store actions alone. ──
describe('query notebook — identity discipline', () => {
  const groupsOf = (f: ReturnType<typeof harness>) => f.store.getState().notebook.groups;

  /** Same UUID, different MATCHING semantics. */
  const semanticEdit = (g: NotebookGroupV1): NotebookGroupV1 => ({
    ...g,
    aliases: ['holm*'],
  });

  it('quickAdd is APPEND-ONLY: a duplicate matching identity is skipped (UUID, member ids, and global activation untouched)', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    f.store.getState().setGroupActive(holmes!.id, false);
    f.store.getState().quickAdd('holmes, watson'); // holmes skipped, watson appended
    const after = groupsOf(f);
    expect(after.map(groupTitle)).toEqual(['holmes', 'moriarty', 'watson']);
    expect(after[0]!.id).toBe(holmes!.id); // the duplicate touched nothing
    expect(after[0]!.aliases).toEqual(holmes!.aliases);
    expect(after[1]!.id).toBe(moriarty!.id); // append-only: nothing replaced
    expect(f.store.getState().activeGroupIds.has(holmes!.id)).toBe(false);
    expect(f.store.getState().activeGroupIds.has(after[2]!.id)).toBe(true);
    expect(f.store.getState().series.map((series) => series.id))
      .toEqual([moriarty!.id, after[2]!.id]);
  });

  it('rename preserves the UUID and issues NO worker request; the projection relabels', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes');
    const g = groupsOf(f)[0]!;
    const issued = f.issued.length;
    f.store.getState().renameGroup(g.id, 'The Detective');
    expect(f.issued.length).toBe(issued); // invariant 2: no occurrence work
    expect(groupsOf(f)[0]!.id).toBe(g.id);
    expect(f.store.getState().series[0]!.label).toBe('The Detective');
    expect(f.store.getState().trends.get(g.id)).toBeDefined(); // results retained
  });

  it('adds one authored term from comma aliases and derives worker members on issue', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    const id = f.store.getState().addTerm({
      aliases: [' NYC ', 'NY', 'New York', 'New Yo*', 'NY'],
    });
    expect(id).not.toBeNull();
    const term = groupsOf(f).at(-1)!;
    expect(term).toMatchObject({
      id,
      aliases: ['NYC', 'NY', 'New York', 'New Yo*'],
      exactMatch: false,
    });
    expect(groupTitle(term)).toBe('NYC');
    expect(coreGroupOf(term).members.map((member) => member.kind))
      .toEqual(['token', 'token', 'phrase', 'phrase']);
    expect(f.store.getState().activeGroupIds.has(term.id)).toBe(true);
  });

  it('refuses an authored style collision for a new active term', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('Holmes');
    const holmes = groupsOf(f)[0]!;
    expect(f.store.getState().addTerm({
      aliases: ['Watson'],
      style: holmes.style,
    })).toBeNull();
    expect(groupsOf(f).map(groupTitle)).toEqual(['Holmes']);
    expect(f.store.getState().notebookError)
      .toBe('Holmes already uses that color and line type');
  });

  it('commits exact-match alias edits explicitly and reissues matching work', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('Holmes');
    const term = groupsOf(f)[0]!;
    const issued = f.issued.length;
    expect(f.store.getState().saveTerm(term.id, {
      aliases: ['Holmes', 'Sherlock Holmes'],
      exactMatch: true,
      countOverlaps: false,
      style: term.style,
    })).toBe(true);
    const edited = groupsOf(f)[0]!;
    expect(edited.aliases).toEqual(['Holmes', 'Sherlock Holmes']);
    expect(edited.exactMatch).toBe(true);
    expect(coreGroupOf(edited).members.every((member) =>
      member.match.case === 'sensitive' && member.match.diacritics === 'sensitive')).toBe(true);
    expect(f.issued.length).toBeGreaterThan(issued);
  });

  it('refuses an edit that would duplicate another term matching identity', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('wolf, bear');
    const [wolf, bear] = groupsOf(f);
    const issued = f.issued.length;
    expect(f.store.getState().saveTerm(bear!.id, {
      aliases: ['wolf'],
      exactMatch: wolf!.exactMatch,
      countOverlaps: false,
      style: bear!.style,
    })).toBe(false);
    expect(groupsOf(f)[1]!.aliases).toEqual(['bear']);
    expect(f.store.getState().notebookError).toMatch(/already has/);
    expect(f.issued.length).toBe(issued);
  });

  it('allows identity-neutral style repair when a legacy notebook already contains duplicate terms', () => {
    const f = harness();
    f.store.getState().quickAdd('wolf');
    const original = groupsOf(f)[0]!;
    const duplicate = {
      ...original,
      id: 'legacy-duplicate',
      style: { color: 'orange' as const, line: 'dash' as const },
    };
    f.store.setState({
      notebook: {
        schema: 'texttrends/query-notebook/3',
        groups: [original, duplicate],
      },
    });
    f.store.getState().setGroupStyle(duplicate.id, { color: 'gold', line: 'fine-dot' });
    expect(groupsOf(f)[1]!.style).toEqual({ color: 'gold', line: 'fine-dot' });
    expect(f.store.getState().notebookError).toBeNull();
  });

  it('a member edit preserves the UUID, changes semantic identity, and reissues trend and matches', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    const g = groupsOf(f)[0]!;
    const trendsBefore = f.trends().length;
    const kwicsBefore = f.kwics().length;
    const original = coreGroupOf(g).members[0]!;
    f.store.getState().setGroupMembers(g.id, [
      original,
      { id: 'm-alias', kind: 'token', surface: 'sherlock', match: { case: 'folded', diacritics: 'folded' } },
    ], false);
    expect(groupsOf(f)[0]!.id).toBe(g.id); // UUID stable (invariant 3)
    expect(f.trends().length).toBeGreaterThan(trendsBefore);
    expect(f.kwics().length).toBeGreaterThan(kwicsBefore);
    // The EXACT authored spec reaches EVERY operation's wire request — the
    // COMPLETE group value (ids, kinds, match modes, countOverlaps), deep-equal
    // against the authored expectation on trend and matches.
    const authored = {
      id: g.id,
      members: [
        original,
        { id: 'a1', kind: 'token', surface: 'sherlock', match: { case: 'folded', diacritics: 'folded' } },
      ],
      countOverlaps: false,
    };
    const trendWire = (f.trends().filter((t) => !t.cancelled).at(-1)!.query as { group: unknown }).group;
    expect(trendWire).toEqual(authored);
    const kwicWire = (f.kwics().filter((t) => !t.cancelled).at(-1)!.query as { tracks: { seriesId: string; group: unknown }[] }).tracks;
    expect(kwicWire).toEqual([{ seriesId: g.id, group: authored }]);
  });

  it('an identity-NEUTRAL member apply (same semantics) reissues nothing', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes');
    const g = groupsOf(f)[0]!;
    const issued = f.issued.length;
    f.store.getState().setGroupMembers(g.id, [...coreGroupOf(g).members], g.countOverlaps);
    expect(f.issued.length).toBe(issued);
  });

  it('a SEMANTIC-ONLY stale settlement cannot commit — trend and KWIC (no epoch advance, leases still current)', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    const g = f.store.getState().notebook.groups[0]!;
    const trend = f.trends().filter((t) => !t.cancelled).at(-1)!;
    const kwic = f.kwics().filter((t) => !t.cancelled).at(-1)!;
    // Change the group's SEMANTICS without any action: no lane superseded, no
    // reissue, no epoch advance — only the issued-identity guard stands
    // between the old results and the store (review-B round-1 finding).
    f.store.setState({ notebook: { schema: 'texttrends/query-notebook/3', groups: [semanticEdit(g)] } });
    expect(trend.cancelled).toBe(false); // the lease is genuinely still alive
    expect(kwic.cancelled).toBe(false);
    trend.resolve({ op: 'trend', trend: fakeTrend(3) });
    kwic.resolve(fakeMatches(1)); // rows empty: adoption alone is the probe
    await flush();
    expect(f.store.getState().trends.get(g.id)!.status).toBe('pending'); // never adopted
    expect(f.store.getState().kwic!.state.status).toBe('pending');
  });

  it('rejects an invalid member set with one bounded notebookError and NO state change or reissue', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes');
    const g = groupsOf(f)[0]!;
    const issued = f.issued.length;
    f.store.getState().setGroupMembers(g.id, [
      { id: 'm-bad', kind: 'prefix', stem: '', match: { case: 'folded', diacritics: 'folded' } },
    ], false);
    expect(f.store.getState().notebookError).toMatch(/use one \*/);
    expect(groupsOf(f)[0]!.aliases).toEqual(g.aliases);
    expect(f.issued.length).toBe(issued);
    f.store.getState().clearNotebookError();
    expect(f.store.getState().notebookError).toBeNull();
  });
});

describe('query notebook — active set, solo, order, and style', () => {
  const groupsOf = (f: ReturnType<typeof harness>) => f.store.getState().notebook.groups;

  it('mute drops and restores the track globally while preserving its style slot', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    const styleBefore = f.store.getState().styles.get(moriarty!.id);
    f.store.getState().setGroupActive(moriarty!.id, false); // mute
    expect(f.store.getState().series.map((s) => s.id)).toEqual([holmes!.id]);
    const live = f.trends().filter((t) => !t.cancelled);
    expect(live.map((t) => t.groupId)).toEqual([holmes!.id]);
    let matches = f.kwics().filter((query) => !query.cancelled).at(-1)!.query as { tracks: { seriesId: string }[] };
    expect(matches.tracks.map((track) => track.seriesId)).toEqual([holmes!.id]);
    f.store.getState().setGroupActive(moriarty!.id, true); // unmute
    expect(f.store.getState().series.map((s) => s.id)).toEqual([holmes!.id, moriarty!.id]);
    matches = f.kwics().filter((query) => !query.cancelled).at(-1)!.query as { tracks: { seriesId: string }[] };
    expect(matches.tracks.map((track) => track.seriesId)).toEqual([holmes!.id, moriarty!.id]);
    expect(f.store.getState().styles.get(moriarty!.id)).toBe(styleBefore); // style identity survived
  });

  it('persists style-only edits without reissuing and protects active survivors on collision', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('a, b');
    const [a, b] = groupsOf(f);
    const issued = f.issued.length;
    f.store.getState().setGroupStyle(a!.id, { color: 'gold', line: 'dot' });
    expect(groupsOf(f)[0]!.style).toEqual({ color: 'gold', line: 'dot' });
    expect(f.issued.length).toBe(issued);

    f.store.getState().setGroupStyle(b!.id, { color: 'gold', line: 'dot' });
    expect(f.store.getState().notebookError).toMatch(/already uses/);
    expect(groupsOf(f)[1]!.style).not.toEqual(groupsOf(f)[0]!.style);

    f.store.getState().setGroupActive(b!.id, false);
    f.store.getState().setGroupStyle(b!.id, { color: 'gold', line: 'dot' });
    expect(groupsOf(f)[1]!.style).toEqual({ color: 'gold', line: 'dot' });
    f.store.getState().setGroupActive(b!.id, true);
    expect(groupsOf(f)[0]!.style).toEqual({ color: 'gold', line: 'dot' });
    expect(groupsOf(f)[1]!.style).not.toEqual(groupsOf(f)[0]!.style);
  });

  it('reassigns a returning automatic color that an active survivor already uses', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('a, b');
    const [a, b] = groupsOf(f);

    f.store.getState().setGroupActive(b!.id, false);
    f.store.getState().setGroupStyle(b!.id, { color: 'blue', line: 'dash' });
    expect(groupsOf(f)[1]!.style).toEqual({ color: 'blue', line: 'dash' });
    f.store.getState().setGroupActive(b!.id, true);

    expect(groupsOf(f)[0]!.style).toEqual(a!.style);
    expect(groupsOf(f)[1]!.style.color).not.toBe(a!.style.color);
    expect(new Set(f.store.getState().series.map((item) => item.style.color))).toHaveLength(2);
  });

  it('refuses one automatic color on two active terms even with different lines', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('a, b');
    const [a, b] = groupsOf(f);

    f.store.getState().setGroupStyle(a!.id, { color: 'gold', line: 'dot' });
    f.store.getState().setGroupStyle(b!.id, { color: 'gold', line: 'dash' });

    expect(f.store.getState().notebookError).toMatch(/already uses/);
    expect(groupsOf(f)[1]!.style.color).not.toBe('gold');
  });

  it('refuses only exact custom color/line collisions and allows nearby authored colors', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('a, b');
    const [a, b] = groupsOf(f);
    f.store.getState().setGroupStyle(a!.id, { color: '#a1b2c3', line: 'dash' });
    expect(groupsOf(f)[0]!.style).toEqual({ color: '#a1b2c3', line: 'dash' });

    f.store.getState().setGroupStyle(b!.id, { color: '#a1b2c3', line: 'dash' });
    expect(f.store.getState().notebookError).toMatch(/already uses/);
    expect(groupsOf(f)[1]!.style).not.toEqual(groupsOf(f)[0]!.style);

    f.store.getState().setGroupStyle(b!.id, { color: '#a1b2c4', line: 'dash' });
    expect(groupsOf(f)[1]!.style).toEqual({ color: '#a1b2c4', line: 'dash' });
  });

  it('uses five distinct colors before varying line type for new active terms', () => {
    const f = harness();
    for (let index = 0; index < 5; index++) {
      f.store.getState().addTerm({ aliases: [`term-${index}`] });
    }
    expect(new Set(groupsOf(f).map((group) => group.style.color)).size).toBe(5);
    expect(new Set(groupsOf(f).map((group) => group.style.line)).size).toBe(5);
  });

  it('the SIXTH activation and an over-room quick-add are refused explicitly — never silent truncation', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('a, b, c, d, e'); // 5 groups, all active
    expect(f.store.getState().activeGroupIds.size).toBe(5);
    // Quick-add with zero active room: atomic refusal via inputError.
    f.store.getState().quickAdd('f');
    expect(f.store.getState().inputError).toContain('room');
    expect(groupsOf(f)).toHaveLength(5);
    // Free a slot, add a sixth GROUP (fits: 4 active + f = 5 active, 6 groups).
    const ids = groupsOf(f).map((g) => g.id);
    f.store.getState().setGroupActive(ids[0]!, false);
    f.store.getState().quickAdd('f');
    expect(f.store.getState().inputError).toBeNull();
    expect(groupsOf(f)).toHaveLength(6);
    expect(f.store.getState().activeGroupIds.size).toBe(5);
    // NOW the sixth ACTIVATION is reachable — and refused loudly.
    f.store.getState().setGroupActive(ids[0]!, true);
    expect(f.store.getState().notebookError).toContain('deactivate one first');
    expect(f.store.getState().activeGroupIds.size).toBe(5); // nothing truncated
    expect(f.store.getState().activeGroupIds.has(ids[0]!)).toBe(false);
  });

  it('solo projects the comparison to ONE group and clearing restores the prior projection exactly', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty, watson');
    const before = f.store.getState().series.map((s) => s.id);
    const target = before[1]!;
    f.store.getState().setSolo(target);
    expect(f.store.getState().series.map((s) => s.id)).toEqual([target]);
    const live = f.trends().filter((t) => !t.cancelled);
    expect(live.map((t) => t.groupId)).toEqual([target]);
    f.store.getState().setSolo(null);
    expect(f.store.getState().series.map((s) => s.id)).toEqual(before); // exact restore
    expect(f.store.getState().activeGroupIds.size).toBe(3); // never mutated
  });

  it('solo is refused for a muted group and cleared when its group deactivates', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    f.store.getState().setGroupActive(moriarty!.id, false);
    f.store.getState().setSolo(moriarty!.id);
    expect(f.store.getState().notebookError).toMatch(/active/);
    expect(f.store.getState().soloGroupId).toBeNull();
    f.store.getState().setSolo(holmes!.id);
    expect(f.store.getState().soloGroupId).toBe(holmes!.id);
    f.store.getState().setGroupActive(holmes!.id, false);
    expect(f.store.getState().soloGroupId).toBeNull(); // normalized away
  });

  it('reorder is a refused-unless-total permutation, preserves UUIDs/slots, and reissues nothing', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    const styles = new Map(f.store.getState().styles);
    const issued = f.issued.length;
    f.store.getState().reorderGroups([moriarty!.id]); // not total → refused
    expect(f.store.getState().notebookError).toMatch(/every group/);
    f.store.getState().reorderGroups([moriarty!.id, holmes!.id]);
    expect(groupsOf(f).map((g) => g.id)).toEqual([moriarty!.id, holmes!.id]);
    expect(f.store.getState().series.map((s) => s.id)).toEqual([moriarty!.id, holmes!.id]);
    expect(f.store.getState().styles.get(holmes!.id)).toBe(styles.get(holmes!.id)); // styles pinned
    expect(f.store.getState().styles.get(moriarty!.id)).toBe(styles.get(moriarty!.id));
    expect(f.issued.length).toBe(issued); // invariant 2: no reissue
  });

  it('removal cleans results, effective Matches projection, solo, and style ownership', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    f.store.getState().setSolo(moriarty!.id);
    f.store.getState().removeGroup(moriarty!.id);
    const state = f.store.getState();
    expect(state.notebook.groups.map((g) => g.id)).toEqual([holmes!.id]);
    expect(state.soloGroupId).toBeNull();
    expect(state.styles.has(moriarty!.id)).toBe(false);
    expect(state.activeGroupIds.has(moriarty!.id)).toBe(false);
    expect(state.series.map((series) => series.id)).toEqual([holmes!.id]);
  });
});

describe('query notebook — effective-intent gating (review-C)', () => {
  it('mutations OUTSIDE the effective comparison reissue nothing: soloed mute, soloed-out semantic edit, soloed append', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes, moriarty');
    const [holmes, moriarty] = f.store.getState().notebook.groups;
    f.store.getState().setSolo(holmes!.id);
    // Settle solo's trend so we can prove READY evidence survives untouched.
    const soloTrend = f.trends().filter((t) => !t.cancelled).at(-1)!;
    soloTrend.resolve({ op: 'trend', trend: fakeTrend(4) });
    await flush();
    expect(f.store.getState().trends.get(holmes!.id)!.status).toBe('ready');
    const issued = f.issued.length;
    // 1. Mute the solo'd-out group: the projected series is unchanged.
    f.store.getState().setGroupActive(moriarty!.id, false);
    // 2. Semantically edit the muted group (identity changes, projection doesn't).
    f.store.getState().setGroupMembers(moriarty!.id, [
      { id: 'a0', kind: 'prefix', stem: 'mor', match: { case: 'folded', diacritics: 'folded' } },
    ], false);
    // 3. Append while soloed: the new group is active but not projected.
    f.store.getState().quickAdd('watson');
    expect(f.issued.length).toBe(issued); // NOT ONE query issued or cancelled
    expect(f.store.getState().trends.get(holmes!.id)!.status).toBe('ready'); // evidence intact
    expect(soloTrend.cancelled).toBe(false); // and its (settled) job was never cancelled
    // Clearing solo NOW restores the full comparison and reissues once.
    f.store.getState().setSolo(null);
    expect(f.issued.length).toBeGreaterThan(issued);
    // The restored comparison = the projected series (holmes + watson;
    // moriarty stays muted) — one live trend per projected group.
    const live = f.trends().filter((t) => !t.cancelled);
    expect(new Set(live.map((t) => t.groupId)))
      .toEqual(new Set(f.store.getState().series.map((s) => s.id)));
    expect(f.store.getState().series.map((s) => s.label)).toEqual(['holmes', 'watson']);
  });

  it('a rename or reorder inside the projection still reissues nothing (unchanged effective intent)', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const [holmes, moriarty] = f.store.getState().notebook.groups;
    const issued = f.issued.length;
    f.store.getState().renameGroup(holmes!.id, 'Detective');
    f.store.getState().reorderGroups([moriarty!.id, holmes!.id]);
    expect(f.issued.length).toBe(issued);
  });
});

/** Same UUID, different MATCHING semantics (module-level twin
 *  of the identity-discipline helper, for the dispersion lane suite). */
const semanticEditTop = (g: NotebookGroupV1): NotebookGroupV1 => ({
  ...g,
  aliases: ['holm*'],
});

describe('dispersion barcode lane (slice-2 commit D)', () => {
  it('rides the trend burst: pending with the series, ready on result, cleared when the comparison empties', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes');
    expect(f.store.getState().dispersion!.state.status).toBe('pending');
    const q = f.issued.filter((x) => x.op === 'dispersion' && !x.cancelled).at(-1)!;
    const wire = q.query as { tracks: { seriesId: string }[]; request: { method: string } };
    expect(wire.request.method).toBe('dispersion/1');
    expect(wire.tracks.map((t) => t.seriesId)).toEqual(f.store.getState().series.map((s) => s.id));
    q.resolve({ op: 'dispersion', dispersion: { method: 'dispersion/1', geometry: null, tracks: [] } });
    await flush();
    expect(f.store.getState().dispersion!.state.status).toBe('ready');
    f.store.getState().removeGroup(f.store.getState().series[0]!.id);
    expect(f.store.getState().dispersion).toBeNull(); // no comparison → no strip
  });

  it('a SEMANTIC-ONLY stale dispersion settlement cannot commit (identity guard, no epoch advance)', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes');
    const g = f.store.getState().notebook.groups[0]!;
    const q = f.issued.filter((x) => x.op === 'dispersion' && !x.cancelled).at(-1)!;
    f.store.setState({ notebook: { schema: 'texttrends/query-notebook/3', groups: [semanticEditTop(g)] } });
    expect(q.cancelled).toBe(false); // the lease is genuinely alive
    q.resolve({ op: 'dispersion', dispersion: { method: 'dispersion/1', geometry: null, tracks: [] } });
    await flush();
    expect(f.store.getState().dispersion!.state.status).toBe('pending'); // never adopted
  });

  it('exact activation preserves global activation and requests the effective Matches tracks', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes, moriarty');
    const sid = f.store.getState().series[0]!.id;
    const activeBefore = [...f.store.getState().activeGroupIds];
    f.store.getState().centerKwicAt(sid, 'a', 3);
    expect([...f.store.getState().activeGroupIds]).toEqual(activeBefore);
    const q = f.kwics().filter((x) => !x.cancelled).at(-1)!.query as { tracks: { seriesId: string }[] };
    expect(q.tracks.map((t) => t.seriesId))
      .toEqual(f.store.getState().series.map((series) => series.id));
    expect(f.store.getState().matchesReveal)
      .toMatchObject({ seriesId: sid, doc: 'a', token: 3 });
  });

  it('density activation publishes only a cursor while exact activation carries a reveal identity', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    const sid = f.store.getState().series[0]!.id;
    f.store.getState().centerKwicAt(sid, 'a', 42, { kind: 'bucket', count: 17 });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 42 });
    expect(f.store.getState().matchesReveal).toBeNull();
    f.store.getState().centerKwicAt(sid, 'a', 7); // occurrence: no origin marker
    expect(f.store.getState().matchesReveal).toMatchObject({ seriesId: sid, doc: 'a', token: 7 });
    f.store.getState().setGroupActive(sid, false);
    expect(f.store.getState().matchesReveal).toBeNull();
  });

  it('centerKwicAt requests immediately — no debounce, ready-doc gated', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    const sid = f.store.getState().series[0]!.id;
    const count = f.kwics().length;
    f.store.getState().centerKwicAt(sid, 'a', 42);
    expect(f.kwics().length).toBe(count + 1);
    const centered = f.kwics().at(-1)!.query as { request: { anchor: unknown } };
    expect(centered.request.anchor).toEqual({ kind: 'position', doc: 'a', token: 42 });
    f.store.getState().centerKwicAt(sid, 'zz', 1); // not a ready doc → refused
    expect(f.kwics().length).toBe(count + 1);
  });

  it('retains resident rows and reuses the sparse axis across neighboring windows', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    const first = f.kwics().at(-1)!;
    first.resolve(fakeMatches(20));
    await flush();
    const resident = f.store.getState().kwic!.resident;
    const axis = f.store.getState().kwic!.axis;
    expect(axis).not.toBeNull();

    f.store.getState().requestMatchesWindow({ kind: 'rank', rank: 10 });
    const second = f.kwics().at(-1)!;
    expect((second.query as { request: { includeAxis: boolean } }).request.includeAxis).toBe(false);
    expect(f.store.getState().kwic).toMatchObject({
      resident,
      axis,
      state: { status: 'pending' },
    });
    second.resolve(fakeMatches(20, [], false));
    await flush();
    expect(f.store.getState().kwic!.axis).toBe(axis);
  });

  it('does not refetch a fully resident result when viewport window geometry changes', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    const sid = f.store.getState().series[0]!.id;
    const groupId = f.store.getState().notebook.groups[0]!.id;
    f.kwics().at(-1)!.resolve(fakeMatches(1, [{
      seriesId: sid,
      groupId,
      doc: 'a',
      pos: 5,
      members: [0],
      node: { start: 10, end: 16 },
      left: 'left',
      leftMarks: [],
      leftMarksTruncated: false,
      nodeText: 'holmes',
      right: 'right',
      rightMarks: [],
      rightMarksTruncated: false,
    }]));
    await flush();
    const count = f.kwics().length;

    f.store.getState().requestMatchesWindow(
      { kind: 'position', doc: 'a', token: 9 },
      { before: 40, after: 40 },
    );

    expect(f.kwics()).toHaveLength(count);
    expect(f.store.getState().kwic).toMatchObject({
      request: {
        anchor: { kind: 'position', doc: 'a', token: 9 },
        before: 40,
        after: 40,
      },
      state: { status: 'ready' },
    });
  });

  it('refetches resident rows when the bounded context reserve grows', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    const first = f.kwics().at(-1)!;
    first.resolve(fakeMatches());
    await flush();
    const axis = f.store.getState().kwic!.axis;

    f.store.getState().requestMatchesWindow(
      { kind: 'rank', rank: 0 },
      { before: 24, after: 24, contextTokens: 128 },
    );

    const expanded = f.kwics().at(-1)!;
    expect(expanded).not.toBe(first);
    expect(expanded.query).toMatchObject({
      request: { contextTokens: 128, includeAxis: false },
    });
    expect(f.store.getState().kwic).toMatchObject({
      request: { contextTokens: 128 },
      resident: { contextTokens: 64 },
      state: { status: 'pending' },
    });

    expanded.resolve(fakeMatches(0, [], false));
    await flush();
    expect(f.store.getState().kwic).toMatchObject({
      axis,
      resident: { contextTokens: 128 },
      state: { status: 'ready' },
    });
  });

  it('serves cursor motion from resident rows and cancels an obsolete outside-window request on reversal', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    const sid = f.store.getState().series[0]!.id;
    const groupId = f.store.getState().notebook.groups[0]!.id;
    const row = (pos: number) => ({
      seriesId: sid,
      groupId,
      doc: 'a',
      pos,
      members: [0],
      node: { start: pos * 2, end: pos * 2 + 6 },
      left: 'left',
      leftMarks: [],
      leftMarksTruncated: false,
      nodeText: 'holmes',
      right: 'right',
      rightMarks: [],
      rightMarksTruncated: false,
    });
    f.kwics().at(-1)!.resolve({
      op: 'matches-window',
      window: {
        method: 'matches-window/1',
        total: 100,
        trackCount: 1,
        anchorRank: 11,
        firstRank: 10,
        preceding: null,
        rows: [row(100), row(150), row(200)],
        axis: { ranks: Uint32Array.of(0, 99), globalTokens: Uint32Array.of(0, 999) },
      },
    });
    await flush();
    const resident = f.store.getState().kwic!.resident;
    const count = f.kwics().length;

    for (let token = 110; token < 150; token++) {
      f.store.getState().requestMatchesWindow({ kind: 'position', doc: 'a', token });
    }
    f.store.getState().requestMatchesWindow({ kind: 'rank', rank: 11 });
    expect(f.kwics()).toHaveLength(count);
    expect(f.store.getState().kwic!.resident).toBe(resident);

    f.store.getState().requestMatchesWindow({ kind: 'position', doc: 'a', token: 250 });
    const outside = f.kwics().at(-1)!;
    expect(f.kwics()).toHaveLength(count + 1);
    expect(f.store.getState().kwic!.state.status).toBe('pending');
    f.store.getState().requestMatchesWindow({ kind: 'position', doc: 'a', token: 150 });
    expect(outside.cancelled).toBe(true);
    expect(f.kwics()).toHaveLength(count + 1);
    expect(f.store.getState().kwic).toMatchObject({
      resident,
      state: { status: 'ready' },
    });
  });

  it('uses exact provenance to disambiguate and consume a same-position reveal', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    const sid = f.store.getState().series[0]!.id;
    const groupId = f.store.getState().notebook.groups[0]!.id;
    f.store.getState().centerKwicAt(sid, 'a', 7, {
      kind: 'occurrence',
      groupId,
      members: [1],
    });
    const request = f.kwics().at(-1)!;
    request.resolve({
      op: 'matches-window',
      window: {
        method: 'matches-window/1',
        total: 20,
        trackCount: 1,
        anchorRank: 12,
        firstRank: 11,
        preceding: null,
        rows: [
          {
            seriesId: sid,
            groupId,
            doc: 'a',
            pos: 7,
            members: [0],
            node: { start: 14, end: 20 },
            left: 'left',
            leftMarks: [],
            leftMarksTruncated: false,
            nodeText: 'holmes',
            right: 'right',
            rightMarks: [],
            rightMarksTruncated: false,
          },
          {
            seriesId: sid,
            groupId,
            doc: 'a',
            pos: 7,
            members: [1],
            node: { start: 14, end: 20 },
            left: 'left',
            leftMarks: [],
            leftMarksTruncated: false,
            nodeText: 'holmes',
            right: 'right',
            rightMarks: [],
            rightMarksTruncated: false,
          },
        ],
        axis: { ranks: Uint32Array.of(0), globalTokens: Uint32Array.of(0) },
      },
    });
    await flush();
    expect(f.store.getState().matchesReveal).toBeNull();
    expect(f.store.getState().kwic!.resident?.revealRank).toBe(12);
  });
});

describe('Company and Reading Destinations overview lanes', () => {
  it('posts overview work after the primary burst and isolates sibling failures', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const start = f.issued.length;
    f.store.getState().quickAdd('holmes, moriarty');
    const burst = f.issued.slice(start);
    const lastTrend = burst.findLastIndex((entry) => entry.op === 'trend');
    const dispersion = burst.findIndex((entry) => entry.op === 'dispersion');
    const company = burst.findIndex((entry) => entry.op === 'company');
    const destinations = burst.findIndex((entry) => entry.op === 'destinations');
    expect(lastTrend).toBeGreaterThanOrEqual(0);
    expect(dispersion).toBeGreaterThan(lastTrend);
    expect(company).toBeGreaterThan(dispersion);
    expect(destinations).toBeGreaterThan(company);
    expect(f.store.getState().company?.state.status).toBe('pending');
    expect(f.store.getState().destinations?.state.status).toBe('pending');

    const companyQuery = f.companies().at(-1)!;
    const destinationsQuery = f.destinations().at(-1)!;
    companyQuery.reject(new Error('company failed independently'));
    destinationsQuery.resolve(fakeDestinationsResult(destinationsQuery));
    await flush();
    expect(f.store.getState().company?.state).toEqual({
      status: 'error',
      message: 'company failed independently',
    });
    expect(f.store.getState().destinations?.state.status).toBe('ready');
  });

  it('uses canonical semantic track order and reissues only Destinations for pair focus', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes, moriarty');
    const [first, second] = f.store.getState().series;
    const originalCompany = f.companies().at(-1)!;
    const originalDestinations = f.destinations().at(-1)!;
    const companyCount = f.companies().length;

    // Reorder presentation before focusing: the worker ordinals must still
    // come from canonical series-id order, not current notebook order.
    f.store.getState().reorderGroups([second!.id, first!.id]);
    f.store.getState().setDestinationFocus([second!.id, first!.id]);
    expect(originalDestinations.cancelled).toBe(true);
    expect(originalCompany.cancelled).toBe(false);
    expect(f.companies()).toHaveLength(companyCount);
    expect(f.destinations()).toHaveLength(2);
    const focused = f.destinations().at(-1)!;
    const focusedWire = focused.query as {
      tracks: readonly { readonly seriesId: string }[];
      request: { readonly focus: { readonly a: number; readonly b: number } | null };
    };
    expect(focusedWire.tracks.map((track) => track.seriesId)).toEqual(['u1', 'u2']);
    expect(focusedWire.request.focus).toEqual({ a: 0, b: 1 });
    expect(f.store.getState().destinationFocus).toEqual({ seriesIds: ['u1', 'u2'] });

    // A raced all-track result is fenced by the Destinations lease only.
    originalDestinations.resolve(fakeDestinationsResult(originalDestinations));
    await flush();
    expect(f.store.getState().destinations?.state.status).toBe('pending');
    focused.resolve(fakeDestinationsResult(focused));
    originalCompany.resolve(fakeCompanyResult(originalCompany));
    await flush();
    expect(f.store.getState().destinations?.state.status).toBe('ready');
    expect(f.store.getState().company?.state.status).toBe('ready');

    // Focus is part of the resident key: clearing a settled focus must issue
    // a fresh all-track ranking without touching Company.
    f.store.getState().setDestinationFocus(null);
    expect(f.companies()).toHaveLength(companyCount);
    expect(f.destinations()).toHaveLength(3);
    expect((f.destinations().at(-1)!.query as {
      request: { readonly focus: unknown };
    }).request.focus).toBeNull();

    const beforePresentationEdits = {
      company: f.companies().length,
      destinations: f.destinations().length,
    };
    f.store.getState().renameGroup(first!.id, 'Detective');
    f.store.getState().setGroupStyle(first!.id, { color: 'gold', line: 'dot' });
    f.store.getState().applyTrendSettings({
      bins: { mode: 'per-doc', count: 40 },
      measure: { kind: 'rate', denominator: 10_000, smoothing: 5, showRaw: true },
    });
    expect(f.companies()).toHaveLength(beforePresentationEdits.company);
    expect(f.destinations()).toHaveLength(beforePresentationEdits.destinations);
  });

  it('invalidates ready residents when a matching identity changes', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes, moriarty');
    const company = f.companies().at(-1)!;
    const destinations = f.destinations().at(-1)!;
    company.resolve(fakeCompanyResult(company));
    destinations.resolve(fakeDestinationsResult(destinations));
    await flush();
    const oldCompanyKey = f.store.getState().company!.trackKey;
    const oldDestinationsKey = f.store.getState().destinations!.resultKey;
    const group = f.store.getState().notebook.groups[0]!;
    const member = coreGroupOf(group).members[0]!;
    if (member.kind !== 'token') throw new Error('quick-add should create a token');

    f.store.getState().setGroupMembers(
      group.id,
      [{ ...member, surface: 'watson' }],
      false,
    );
    expect(f.companies()).toHaveLength(2);
    expect(f.destinations()).toHaveLength(2);
    expect(f.store.getState().company?.state.status).toBe('pending');
    expect(f.store.getState().destinations?.state.status).toBe('pending');
    expect(f.store.getState().company!.trackKey).not.toBe(oldCompanyKey);
    expect(f.store.getState().destinations!.resultKey).not.toBe(oldDestinationsKey);
  });

  it('ignores invalid focus identities before they can reach worker ordinals', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes, moriarty');
    const [first] = f.store.getState().series;
    const count = f.destinations().length;
    expect(() => f.store.getState().setDestinationFocus([first!.id, first!.id])).not.toThrow();
    expect(() => f.store.getState().setDestinationFocus([first!.id, 'unknown'])).not.toThrow();
    expect(f.destinations()).toHaveLength(count);
    expect(f.store.getState().destinationFocus).toBeNull();
  });

  it('refuses mismatched worker track/focus echoes and maps overview caps honestly', async () => {
    const mismatched = harness();
    mismatched.port.publishSnapshot('g1', 's1', ['a']);
    mismatched.store.getState().quickAdd('holmes, moriarty');
    const company = mismatched.companies().at(-1)!;
    const destinations = mismatched.destinations().at(-1)!;
    const companyData = fakeCompanyResult(company);
    if (companyData.op !== 'company') throw new Error('expected fake Company result');
    company.resolve({
      op: 'company',
      company: {
        ...companyData.company,
        tracks: companyData.company.tracks.map((track, index) =>
          index === 0 ? { ...track, seriesId: 'wrong-series' } : track),
      },
    });
    const destinationsData = fakeDestinationsResult(destinations);
    if (destinationsData.op !== 'destinations') throw new Error('expected fake Destinations result');
    destinations.resolve({
      op: 'destinations',
      destinations: {
        ...destinationsData.destinations,
        focus: { a: 0, b: 1 },
      },
    });
    await flush();
    expect(mismatched.store.getState().company?.state).toEqual({
      status: 'error',
      message: 'worker returned mismatched Company data',
    });
    expect(mismatched.store.getState().destinations?.state).toEqual({
      status: 'error',
      message: 'worker returned mismatched Reading Destinations data',
    });

    const capped = harness();
    capped.port.publishSnapshot('g1', 's1', ['a']);
    capped.store.getState().quickAdd('holmes, moriarty');
    capped.companies().at(-1)!.reject(
      new WorkerClientError('WORKER_ERROR', 'cap', 'CAP_EXCEEDED'),
    );
    await flush();
    expect(capped.store.getState().company?.state).toEqual({
      status: 'error',
      message: 'This overview is too large to analyse exactly — remove a tracked term or text.',
    });
  });

  it('cancels overview work for a linked range and reuses exact ready residents on clear', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes, moriarty');
    const companyQuery = f.companies().at(-1)!;
    const destinationsQuery = f.destinations().at(-1)!;
    companyQuery.resolve(fakeCompanyResult(companyQuery));
    destinationsQuery.resolve(fakeDestinationsResult(destinationsQuery));
    await flush();
    const companyResident = f.store.getState().company;
    const destinationsResident = f.store.getState().destinations;
    const counts = {
      company: f.companies().length,
      destinations: f.destinations().length,
    };

    f.store.getState().setLinkedSelection({
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 1, end: 3 } }],
    });
    expect(companyQuery.cancelled).toBe(true);
    expect(destinationsQuery.cancelled).toBe(true);
    expect(f.store.getState().company).toBe(companyResident);
    expect(f.store.getState().destinations).toBe(destinationsResident);

    f.store.getState().setLinkedSelection(null);
    expect(f.companies()).toHaveLength(counts.company);
    expect(f.destinations()).toHaveLength(counts.destinations);
    expect(f.store.getState().company).toBe(companyResident);
    expect(f.store.getState().destinations).toBe(destinationsResident);
  });

  it('clears cancelled pending states and reissues them on deselection', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes, moriarty');
    const pendingCompany = f.companies().at(-1)!;
    const pendingDestinations = f.destinations().at(-1)!;
    f.store.getState().setLinkedSelection({
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 1, end: 3 } }],
    });
    expect(pendingCompany.cancelled).toBe(true);
    expect(pendingDestinations.cancelled).toBe(true);
    expect(f.store.getState().company).toBeNull();
    expect(f.store.getState().destinations).toBeNull();

    f.store.getState().setLinkedSelection(null);
    expect(f.companies()).toHaveLength(2);
    expect(f.destinations()).toHaveLength(2);
    expect(f.store.getState().company?.state.status).toBe('pending');
    expect(f.store.getState().destinations?.state.status).toBe('pending');
  });

  it('shows Destinations but no Company for a single active term', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    expect(f.companies()).toHaveLength(0);
    expect(f.store.getState().company).toBeNull();
    expect(f.destinations()).toHaveLength(1);
    expect(f.store.getState().destinations?.state.status).toBe('pending');
  });
});

describe('linked token-range selection (slice-2 commit E)', () => {
  const range = (f: ReturnType<typeof harness>, start: number, end: number) => ({
    snapshot: f.store.getState().snapshot!.snapshot,
    ranges: [{ doc: 'a', tokens: { start, end } }],
  });

  it('committing a range leaves the full-corpus match set untouched and issues overlays on separate lanes', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.getState().quickAdd('holmes');
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

  it('clearing drops overlays without reissuing the full-corpus match set or resident baselines', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
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
  });

  it('scopes range-aware detail consumers, but never Matches, to every explicit range', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b', 'c']);
    f.store.getState().quickAdd('holmes');
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
    f.store.getState().quickAdd('holmes');
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
    f.store.getState().quickAdd('holmes');
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
    f.store.getState().quickAdd('holmes');
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
    f.store.getState().quickAdd('holmes');
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
    f.store.getState().quickAdd('holmes');
    f.store.getState().setLinkedSelection({ snapshot: 'sX', ranges: [{ doc: 'a', tokens: { start: 0, end: 2 } }] });
    expect(f.store.getState().linkedSelection).toBeNull();
    f.store.getState().setLinkedSelection({ snapshot: 's1', ranges: [{ doc: 'zz', tokens: { start: 0, end: 2 } }] });
    expect(f.store.getState().linkedSelection).toBeNull();
  });
});

describe('global footer passage intent', () => {
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const cursorToken = (entry: Issued) => (
    entry.query as { request: { cursor: { kind: string; token: number } } }
  ).request.cursor.token;

  it('issues immediately on its own reader lane and retains only the latest pending cursor', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');

    f.store.getState().setScrub({ doc: 'a', token: 10 });
    expect(f.readers()).toHaveLength(1);
    expect(cursorToken(f.readers()[0]!)).toBe(10);
    f.store.getState().setScrub({ doc: 'a', token: 30 });
    expect(f.readers()).toHaveLength(1);
    f.readers()[0]!.resolve(fakeReaderPage(0, 20, 1_000));
    await settle();

    expect(f.readers()).toHaveLength(2);
    expect(cursorToken(f.readers()[1]!)).toBe(30);
    expect(f.store.getState().footerPassage).toMatchObject({
      snapshot: 's1',
      doc: 'a',
      page: { tokens: { start: 0, end: 20 } },
      state: { status: 'pending' },
    });
    expect((f.readers()[1]!.query as { tracks: unknown[] }).tracks).toHaveLength(1);
    f.runtime.dispose();
    expect(f.readers()[1]!.cancelled).toBe(true);
  });

  it('keeps at most one request active and pumps only the newest pending cursor', async () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().quickAdd('holmes');
      f.store.getState().setScrub({ doc: 'a', token: 20 });
      const first = f.readers()[0]!;

      f.store.getState().setScrub({ doc: 'a', token: 500 });
      f.store.getState().setScrub({ doc: 'a', token: 700 });
      expect(f.readers()).toHaveLength(1);

      first.resolve(fakeReaderPage(0, 400, 1_000));
      await settle();
      expect(f.readers()).toHaveLength(2);
      expect(cursorToken(f.readers()[1]!)).toBe(700);
      expect(f.store.getState().footerPassage?.state.status).toBe('pending');
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps source reading available with zero query series', async () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().setScrub({ doc: 'a', token: 12 });

      expect(f.readers()).toHaveLength(1);
      expect((f.readers()[0]!.query as { tracks: unknown[] }).tracks).toEqual([]);
      f.readers()[0]!.resolve(fakeReaderPage(0, 100, 1_000));
      await settle();
      expect(f.store.getState().footerPassage?.state.status).toBe('ready');
      expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 12 });
      f.port.publishSnapshot('g2', 's2', ['a']);
      expect(f.store.getState().scrub).toBeNull();
      expect(f.store.getState().footerPassage).toBeNull();
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a source error and retries the current cursor without touching settled KWIC', async () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().quickAdd('holmes');
      const matches = f.kwics().at(-1)!;
      matches.resolve(fakeMatches(0));
      await settle();
      f.store.getState().setScrub({ doc: 'a', token: 25 });
      f.readers()[0]!.reject(new Error('source failed'));
      await settle();
      expect(f.store.getState().footerPassage?.state).toEqual({
        status: 'error',
        message: 'source failed',
      });
      const kwicCount = f.kwics().length;

      // An unchanged settled axis position retries only source residency.
      f.store.getState().setScrub({ doc: 'a', token: 25 });
      expect(f.kwics()).toHaveLength(kwicCount);
      expect(f.readers()).toHaveLength(2);
      f.store.getState().runFooterPassage();
      expect(f.readers()).toHaveLength(2); // same request remains active
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses a serving canonical page, then reissues immediately when track semantics change', async () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().quickAdd('holmes');
      f.store.getState().setScrub({ doc: 'a', token: 40 });
      f.readers()[0]!.resolve(fakeReaderPage(0, 100, 1_000));
      await settle();
      expect(f.store.getState().footerPassage?.state.status).toBe('ready');

      f.store.getState().setScrub({ doc: 'a', token: 80 });
      expect(f.readers()).toHaveLength(1);

      f.store.getState().quickAdd('watson');
      expect(f.readers()).toHaveLength(2);
      expect(cursorToken(f.readers()[1]!)).toBe(80);
      expect((f.readers()[1]!.query as { tracks: unknown[] }).tracks).toHaveLength(2);
      f.store.getState().clearScrub();
      expect(f.readers()[1]!.cancelled).toBe(true);
      expect(f.store.getState().footerPassage).toBeNull();
      f.readers()[1]!.resolve(fakeReaderPage(0, 100, 1_000));
      await settle();
      expect(f.store.getState().footerPassage).toBeNull();
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-centers before a measured row margin reaches a resident page edge', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setFooterPassageMargin(30);
    f.store.getState().setScrub({ doc: 'a', token: 200 });
    f.readers()[0]!.resolve(fakeReaderPage(0, 400, 1_000, 'a', 200));
    await settle();

    f.store.getState().setScrub({ doc: 'a', token: 210 });
    expect(f.readers()).toHaveLength(1);
    f.store.getState().setScrub({ doc: 'a', token: 380 });
    expect(f.readers()).toHaveLength(2);
    expect(cursorToken(f.readers()[1]!)).toBe(380);
    expect(f.store.getState().footerPassage).toMatchObject({
      page: { tokens: { start: 0, end: 400 } },
      state: { status: 'pending' },
    });
    f.runtime.dispose();
  });

  it('waives the row margin at document edges', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setFooterPassageMargin(30);
    f.store.getState().setScrub({ doc: 'a', token: 5 });
    f.readers()[0]!.resolve(fakeReaderPage(0, 400, 400, 'a', 5));
    await settle();

    f.store.getState().setScrub({ doc: 'a', token: 1 });
    f.store.getState().setScrub({ doc: 'a', token: 399 });
    expect(f.readers()).toHaveLength(1);
    f.runtime.dispose();
  });

  it('re-evaluates a larger measured margin once and terminates at the new anchor', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setScrub({ doc: 'a', token: 200 });
    f.readers()[0]!.resolve(fakeReaderPage(0, 400, 1_000, 'a', 200));
    await settle();
    f.store.getState().setScrub({ doc: 'a', token: 380 });
    expect(f.readers()).toHaveLength(1);

    f.store.getState().setFooterPassageMargin(30);
    expect(f.readers()).toHaveLength(2);
    f.store.getState().setFooterPassageMargin(30);
    expect(f.readers()).toHaveLength(2);
    f.readers()[1]!.resolve(fakeReaderPage(180, 580, 1_000, 'a', 380));
    await settle();
    expect(f.readers()).toHaveLength(2);
    f.runtime.dispose();
  });

  it('cancels an obsolete request when a reversal returns to the resident page', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setScrub({ doc: 'a', token: 40 });
    f.readers()[0]!.resolve(fakeReaderPage(0, 100, 1_000));
    await settle();

    f.store.getState().setScrub({ doc: 'a', token: 500 });
    const obsolete = f.readers()[1]!;
    expect(f.store.getState().footerPassage).toMatchObject({
      page: { tokens: { start: 0, end: 100 } },
      state: { status: 'pending' },
    });
    f.store.getState().setScrub({ doc: 'a', token: 50 });

    expect(obsolete.cancelled).toBe(true);
    expect(f.store.getState().footerPassage).toMatchObject({
      page: { tokens: { start: 0, end: 100 } },
      state: { status: 'ready' },
    });
    f.runtime.dispose();
  });

  it('retains authenticated source when the next passage request fails', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setScrub({ doc: 'a', token: 40 });
    f.readers()[0]!.resolve(fakeReaderPage(0, 100, 1_000));
    await settle();

    f.store.getState().setScrub({ doc: 'a', token: 500 });
    f.readers()[1]!.reject(new Error('source failed'));
    await settle();

    expect(f.store.getState().footerPassage).toMatchObject({
      page: { tokens: { start: 0, end: 100 } },
      state: { status: 'error', message: 'source failed' },
    });
    f.runtime.dispose();
  });

  it('clears a failed request when the resident page serves the returned cursor', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setScrub({ doc: 'a', token: 40 });
    f.readers()[0]!.resolve(fakeReaderPage(0, 100, 1_000, 'a', 40));
    await settle();

    f.store.getState().setScrub({ doc: 'a', token: 500 });
    f.readers()[1]!.reject(new Error('source failed'));
    await settle();
    f.store.getState().setScrub({ doc: 'a', token: 50 });

    expect(f.store.getState().footerPassage).toMatchObject({
      page: { tokens: { start: 0, end: 100 } },
      state: { status: 'ready' },
    });
    f.store.getState().runFooterPassage();
    expect(f.readers()).toHaveLength(2);
    f.runtime.dispose();
  });
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
    f.store.getState().quickAdd('holmes, watson');
    f.store.getState().setScrub({ doc: 'a', token: 10 });
    f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 10, from: 'footer' });
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
    f.store.getState().clearScrub();
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

  it('moves the truthful cursor, reanchors Matches, detects wrap, and does not open Reader', async () => {
    const f = setup(['a', 'b']);
    f.store.getState().quickAdd('holmes');
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
    f.store.getState().quickAdd('watson');
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
      snapshot: 's1', doc: 'a', token: 10, from: 'footer',
    });
    const readerCount = f.readers().length;

    pending.resolve(resultFor(pending, {
      doc: 'b', token: 5, spanTokens: 1, members: [0],
    }));
    await flush();

    expect(f.store.getState().readerPlace).toMatchObject({
      snapshot: 's1', doc: 'b', from: 'occurrence', cursor: { kind: 'around', token: 5 },
    });
    expect(f.store.getState().layers.filter((layer) => layer.kind === 'reader')).toHaveLength(1);
    expect(f.readers()).toHaveLength(readerCount + 1);
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
    f.store.getState().quickAdd('holmes, watson');
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
    f.store.getState().quickAdd('holmes');
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

  it('replaces an open Reader around the exact hit without stacking another layer', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.getState().quickAdd('holmes');
    f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 3, from: 'kwic' });
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
      doc: 'b', from: 'occurrence', cursor: { kind: 'around', token: 2 },
    });
    expect((f.readers().at(-1)!.query as { request: { doc: string; cursor: unknown } }).request)
      .toMatchObject({ doc: 'b', cursor: { kind: 'around', token: 2 } });
  });

  it('semantic edits cancel the lane and prevent a late hit from moving the reader', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    f.store.getState().setScrub({ doc: 'a', token: 2 });
    f.store.getState().stepOccurrence(1);
    const request = f.occurrenceSteps().at(-1)!;
    const group = f.store.getState().notebook.groups[0]!;
    const member = coreGroupOf(group).members[0]!;
    if (member.kind !== 'token') throw new Error('quick-add should create a token');
    f.store.getState().setGroupMembers(group.id, [{ ...member, surface: 'watson' }], false);
    expect(request.cancelled).toBe(true);
    expect(f.store.getState().occurrenceNavigation).toBeNull();
    request.resolve(resultFor(request, { doc: 'a', token: 8, spanTokens: 1, members: [0] }));
    await flush();
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 2 });
  });

  it('refuses mismatched worker identity and malformed hit provenance', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
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

describe('RSVP interaction ownership', () => {
  const stepResultFor = (
    entry: Issued,
    hit: {
      readonly doc: string;
      readonly token: number;
      readonly spanTokens: number;
      readonly members: readonly number[];
    } | null,
  ): QueryResultDataV4 => {
    const track = (entry.query as {
      tracks: readonly { seriesId: string; group: { id: string } }[];
    }).tracks[0]!;
    return {
      op: 'occurrence-step',
      seriesId: track.seriesId,
      groupId: track.group.id,
      step: { method: 'occurrence-step/1', hit, atEdge: hit === null },
    };
  };

  function latestReaderSource(f: ReturnType<typeof harness>): Issued {
    const request = f.readers().filter((entry) => (
      entry.query as { request: { maxTokens: number } }
    ).request.maxTokens === 4_096).at(-1);
    if (request === undefined) throw new Error('expected a full Reader source request');
    return request;
  }

  async function readyReader(
    f: ReturnType<typeof harness>,
    anchorToken = 4,
  ): Promise<void> {
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: anchorToken, from: 'occurrence',
    });
    latestReaderSource(f).resolve(fakeReaderPage(2, 8, 12, 'a', anchorToken));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 3, end: 7 }, geometry: '800x600:fit',
    });
  }

  it('enters only from a ready source at the published anchor and remembers accepted pace', async () => {
    const f = harness(undefined, {
      rsvpPacing: {
        wpm: 375,
        wordsPerFrame: 2,
        frameCharLimit: 24,
        sentencePauseMs: 250,
        paragraphPauseMs: 800,
        lengthEmphasis: 50,
      },
    });
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 4, from: 'occurrence',
    });
    f.store.getState().enterRsvp(true);
    expect(f.store.getState().interaction).toEqual({ kind: 'none' });

    latestReaderSource(f).resolve(fakeReaderPage(2, 8, 12, 'a', 4));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 3, end: 7 }, geometry: '800x600:fit',
    });
    f.store.getState().enterRsvp(true);
    expect(f.store.getState().interaction).toEqual({
      kind: 'rsvp',
      rsvp: {
        snapshot: 's1', doc: 'a', docTokenCount: 12, startToken: 4,
        wpm: 375, wordsPerFrame: 2, frameCharLimit: 24, sentencePauseMs: 250,
        paragraphPauseMs: 800, lengthEmphasis: 50, playing: true,
      },
      suspended: { kind: 'none' },
    });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 4 });

    f.store.getState().setRsvpPacing({
      wpm: 425,
      wordsPerFrame: 9,
      frameCharLimit: 100,
      sentencePauseMs: 750,
      paragraphPauseMs: 100,
      lengthEmphasis: -10,
    });
    f.store.getState().setRsvpPlaying(false);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp',
      rsvp: {
        wpm: 425,
        wordsPerFrame: 3,
        frameCharLimit: 40,
        sentencePauseMs: 750,
        paragraphPauseMs: 750,
        lengthEmphasis: 0,
        playing: false,
      },
    });
    f.store.getState().exitRsvp(5);
    latestReaderSource(f).resolve(fakeReaderPage(5, 12, 12));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 5, end: 9 }, geometry: '800x600:fit',
    });
    f.store.getState().enterRsvp(false);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp',
      rsvp: {
        startToken: 5,
        wpm: 425,
        wordsPerFrame: 3,
        frameCharLimit: 40,
        sentencePauseMs: 750,
        paragraphPauseMs: 750,
        lengthEmphasis: 0,
        playing: false,
      },
    });
    f.store.getState().closeReader();
    expect(f.store.getState().interaction).toEqual({ kind: 'none' });
    expect(f.store.getState().readerPlace).toBeNull();
    f.runtime.dispose();
  });

  it('preserves frame preferences when applying a rhythm preset or reset', async () => {
    const f = harness(undefined, {
      rsvpPacing: {
        wpm: 425,
        wordsPerFrame: 3,
        frameCharLimit: 24,
        sentencePauseMs: 250,
        paragraphPauseMs: 800,
        lengthEmphasis: 50,
      },
    });
    await readyReader(f);
    f.store.getState().enterRsvp(false);

    f.store.getState().setRsvpPacing(RSVP_RHYTHM_PRESETS.study);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp',
      rsvp: {
        wpm: 425,
        wordsPerFrame: 3,
        frameCharLimit: 24,
        sentencePauseMs: 500,
        paragraphPauseMs: 900,
        lengthEmphasis: 100,
      },
    });

    f.store.getState().setRsvpPacing(RSVP_RHYTHM_RESET);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp',
      rsvp: {
        wpm: 300,
        wordsPerFrame: 3,
        frameCharLimit: 24,
        sentencePauseMs: 350,
        paragraphPauseMs: 700,
        lengthEmphasis: 100,
      },
    });
    f.runtime.dispose();
  });

  it('refuses an unfitted backward source and drops RSVP only when navigation lands', async () => {
    const f = harness();
    await readyReader(f);
    const previous = f.store.getState().readerNavigation?.previous;
    if (previous === null || previous === undefined) throw new Error('expected a previous page');
    f.store.getState().navigateReader(previous);
    latestReaderSource(f).resolve(fakeReaderPage(0, 3, 12));
    await flush();
    expect(f.store.getState().readerPlace?.cursor).toEqual({ kind: 'before', token: 3 });
    expect(f.store.getState().readerPage?.state.status).toBe('ready');
    expect(f.store.getState().readerVisibleRange).toBeNull();

    f.store.getState().enterRsvp(true);
    expect(f.store.getState().interaction).toEqual({ kind: 'none' });
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 1, end: 3 }, geometry: '800x600:back',
    });
    f.store.getState().enterRsvp(true);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp', rsvp: { startToken: 1 },
    });

    expect(f.store.getState().popLayer()).toBe(true);
    expect(f.store.getState().readerPlace).toBeNull();
    expect(f.store.getState().interaction).toEqual({ kind: 'none' });
    f.runtime.dispose();
  });

  it('publishes without touching fitted navigation and exits exactly during a seek', async () => {
    const f = harness();
    await readyReader(f);
    const navigation = f.store.getState().readerNavigation;
    const issued = f.issued.length;
    f.store.getState().enterRsvp(true);
    const interaction = f.store.getState().interaction;
    const place = f.store.getState().readerPlace;
    f.store.getState().publishRsvpPosition(-1);
    f.store.getState().rsvpSeek(12);
    f.store.getState().exitRsvp(1.5);
    expect(f.store.getState().interaction).toBe(interaction);
    expect(f.store.getState().readerPlace).toBe(place);
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 4 });
    f.store.getState().publishRsvpPosition(5);
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 5 });
    f.store.getState().setScrub({ doc: 'a', token: 9 });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 5 });
    expect(f.store.getState().readerNavigation).toBe(navigation);
    expect(f.issued).toHaveLength(issued);

    f.store.getState().rsvpSeek(5);
    expect(f.store.getState().readerPlace?.cursor).toEqual({ kind: 'from', token: 5 });
    expect(f.store.getState().readerPage?.state.status).toBe('pending');
    f.store.getState().publishRsvpPosition(6);
    f.store.getState().exitRsvp(6);
    expect(f.store.getState().interaction).toEqual({ kind: 'none' });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 6 });
    expect(f.store.getState().readerPlace?.cursor).toEqual({ kind: 'from', token: 6 });
    expect(f.store.getState().readerNavigation).toBe(navigation);
    f.runtime.dispose();
  });

  it('cancels an ordinary occurrence result already in flight before suspension', async () => {
    const f = harness();
    await readyReader(f);
    f.store.getState().quickAdd('holmes');
    latestReaderSource(f).resolve(fakeReaderPage(2, 8, 12, 'a', 4));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 3, end: 7 }, geometry: '800x600:term',
    });
    f.store.getState().stepOccurrence(1);
    const pending = f.occurrenceSteps().at(-1)!;
    f.store.getState().enterRsvp(true);
    expect(pending.cancelled).toBe(true);
    expect(f.store.getState().occurrenceNavigation).toBeNull();

    pending.resolve(stepResultFor(pending, {
      doc: 'a', token: 10, spanTokens: 1, members: [0],
    }));
    await flush();
    expect(f.store.getState().interaction.kind).toBe('rsvp');
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 4 });
    expect(f.store.getState().readerPlace).toMatchObject({
      doc: 'a', cursor: { kind: 'around', token: 4 },
    });
    f.runtime.dispose();
  });

  it('settles a pending Find before suspension and restores its exact query', async () => {
    const f = harness();
    await readyReader(f);
    expect(f.store.getState().submitFind('moriarty')).toBe(true);
    const pendingFind = f.occurrenceSteps().at(-1)!;
    latestReaderSource(f).resolve(fakeReaderPage(2, 8, 12, 'a', 4));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 3, end: 7 }, geometry: '800x600:find',
    });
    const findTrendCount = f.trends().filter((entry) => entry.term === 'moriarty').length;
    const pendingTrend = f.trends().filter((entry) => entry.term === 'moriarty').at(-1)!;
    expect(f.store.getState().readerPage?.state.status).toBe('ready');
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find', find: { state: { status: 'pending' } },
    });
    f.store.getState().enterRsvp(true);
    expect(pendingFind.cancelled).toBe(true);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp',
      suspended: {
        kind: 'find',
        find: { query: { raw: 'moriarty' }, state: { status: 'idle' } },
      },
    });
    expect(f.store.getState().readerPage?.tracks).toMatchObject([
      { label: 'moriarty' },
    ]);
    pendingTrend.resolve({ op: 'trend', trend: fakeTrend(7) });
    await flush();
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp',
      suspended: { kind: 'find', find: { trend: { status: 'ready' } } },
    });

    pendingFind.resolve(stepResultFor(pendingFind, {
      doc: 'a', token: 10, spanTokens: 1, members: [0],
    }));
    await flush();
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 4 });
    f.store.getState().exitRsvp(4);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find', find: { query: { raw: 'moriarty' }, state: { status: 'idle' } },
    });
    expect(f.trends().filter((entry) => entry.term === 'moriarty').length)
      .toBe(findTrendCount);
    f.runtime.dispose();
  });
});

describe('latest-wins full reader intent (slice-2 H)', () => {
  const setup = () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    return f;
  };

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
    runtime.useApp.getState().quickAdd('holmes');
    runtime.useApp.getState().openReader({
      snapshot: 's1',
      doc: 'a',
      token: 1,
      from: 'kwic',
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
      { snapshot: 's1', doc: 'a', token: 1, from: 'kwic' },
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
      { snapshot: 's1', doc: 'a', token: 2, from: 'barcode' },
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
    f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 40, from: 'barcode' });
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

  it('rolls fitted page navigation across nonempty texts in declared corpus order', async () => {
    const project: ProjectView = {
      ...BUILTIN_PROJECT,
      data: { ...BUILTIN_PROJECT.data, order: ['a', 'empty', 'b'] },
    };
    const f = harness(sessionState(snap('g1', 's1', ['b', 'empty', 'a']), { project }));
    f.store.setState({
      corpusTokenCounts: new Map([['a', 4], ['empty', 0], ['b', 6]]),
    });
    f.store.getState().quickAdd('holmes');
    f.store.getState().openReader({ snapshot: 's1', doc: 'b', token: 2, from: 'barcode' });
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

  it('can refill a saturated fitted page only from its authenticated visible start', async () => {
    const f = setup();
    f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 40, from: 'barcode' });
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
    f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 5, from: 'barcode' });
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
    f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 5, from: 'barcode' });
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
    f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 1, from: 'kwic' });
    const first = f.readers().at(-1)!;
    const count = f.readers().length;

    f.store.getState().renameGroup(group.id, 'Detective');
    expect(f.readers()).toHaveLength(count);
    expect(first.cancelled).toBe(false);

    const member = coreGroupOf(group).members[0]!;
    if (member.kind !== 'token') throw new Error('quick-add must create a token member');
    f.store.getState().setGroupMembers(group.id, [{
      ...member,
      surface: 'watson',
    }], false);
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
    f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 1, from: 'barcode' });
    const closed = f.readers().at(-1)!;
    f.store.getState().closeReader();
    expect(closed.cancelled).toBe(true);
    closed.resolve(fakeReaderPage(0, 4));
    await flush();
    expect(f.store.getState().readerPlace).toBeNull();
    expect(f.store.getState().readerPage).toBeNull();

    f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 2, from: 'kwic' });
    const replaced = f.readers().at(-1)!;
    f.port.publishSnapshot('g1', 's2', ['a']);
    expect(replaced.cancelled).toBe(true);
    expect(f.store.getState().readerPlace).toBeNull();

    f.store.getState().openReader({ snapshot: 's2', doc: 'a', token: 2, from: 'kwic' });
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
    f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 1, from: 'kwic' });
    f.readers().at(-1)!.resolve(fakeReaderPage(0, 4, 10, 'wrong'));
    await flush();
    expect(f.store.getState().readerPage?.state).toEqual({
      status: 'error',
      message: 'reader returned the wrong document',
    });
  });
});

describe('corpus dashboard query intent (slice-3)', () => {
  const rangeFor = (
    f: ReturnType<typeof harness>,
    start: number,
    end: number,
  ) => ({
    snapshot: f.store.getState().snapshot!.snapshot,
    ranges: [{ doc: 'a', tokens: { start, end } }],
  });

  it('issues inventory and frequency on each snapshot identity', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    expect(f.inventories()).toHaveLength(1);
    expect(f.frequencies()).toHaveLength(1);
    expect((f.inventories()[0]!.query as { selection: { docs: string[] } }).selection.docs)
      .toEqual(['a', 'b']);
    f.port.publishSnapshot('g1', 's2', ['a', 'b']);
    expect(f.inventories()).toHaveLength(2);
    expect(f.frequencies()).toHaveLength(2);
  });

  it('a linked brush reissues inventory and frequency', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.getState().setLinkedSelection(rangeFor(f, 10, 20));
    expect(f.inventories()).toHaveLength(2);
    expect(f.frequencies()).toHaveLength(2);
    for (const request of [f.inventories().at(-1)!, f.frequencies().at(-1)!]) {
      expect((request.query as {
        selection: { docs: string[]; ranges: { doc: string; tokens: { start: number; end: number } }[] };
      }).selection).toEqual({
        docs: ['a'],
        ranges: [{ doc: 'a', tokens: { start: 10, end: 20 } }],
      });
    }
  });

  it('notebook rename and member edits never reissue vocabulary-wide work', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    const group = f.store.getState().notebook.groups[0]!;
    const inventoryCount = f.inventories().length;
    const frequencyCount = f.frequencies().length;
    const trendCount = f.trends().length;

    f.store.getState().renameGroup(group.id, 'Detective');
    const member = coreGroupOf(group).members[0]!;
    if (member.kind !== 'token') throw new Error('quick-add must create a token member');
    f.store.getState().setGroupMembers(group.id, [{ ...member, surface: 'watson' }], false);

    expect(f.inventories()).toHaveLength(inventoryCount);
    expect(f.frequencies()).toHaveLength(frequencyCount);
    expect(f.trends().length).toBeGreaterThan(trendCount);
  });

  it('guards selection, sort, and page replacements against late results', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    const initialFrequency = f.frequencies().at(-1)!;
    f.store.getState().setFrequencySort('key');
    const sortedFrequency = f.frequencies().at(-1)!;
    expect(initialFrequency.cancelled).toBe(true);
    initialFrequency.resolve(fakeFrequencyResult(41));
    await flush();
    expect(f.store.getState().frequency?.state.status).toBe('pending');

    f.store.getState().setFrequencyPage(100);
    expect(sortedFrequency.cancelled).toBe(true);
    sortedFrequency.resolve(fakeFrequencyResult(42));
    await flush();
    expect(f.store.getState().frequency?.state.status).toBe('pending');

    f.store.getState().setLinkedSelection(rangeFor(f, 0, 5));
    const inventoryA = f.inventories().at(-1)!;
    const frequencyA = f.frequencies().at(-1)!;
    f.store.getState().setLinkedSelection(rangeFor(f, 10, 15));
    expect(inventoryA.cancelled).toBe(true);
    expect(frequencyA.cancelled).toBe(true);
    inventoryA.resolve(fakeInventoryResult(43));
    frequencyA.resolve(fakeFrequencyResult(43));
    await flush();
    expect(f.store.getState().inventory?.state.status).toBe('pending');
    expect(f.store.getState().frequency?.state.status).toBe('pending');
  });

  it('retains resident vocabulary rows while appending the next chunk', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    const first = f.frequencies().at(-1)!;
    first.resolve(fakeFrequencyPage('selection-a', 3, [
      { key: 'alpha', typeId: 1 },
      { key: 'beta', typeId: 2 },
    ]));
    await flush();

    expect(f.store.getState().frequency?.resident?.rows.map((row) => row.key))
      .toEqual(['alpha', 'beta']);
    const before = f.frequencies().length;
    f.store.getState().loadMoreFrequency();
    expect(f.frequencies()).toHaveLength(before + 1);
    expect(f.store.getState().frequency).toMatchObject({
      resident: { rows: [{ key: 'alpha' }, { key: 'beta' }] },
      state: { status: 'pending' },
    });
    expect((f.frequencies().at(-1)!.query as {
      request: { page: { offset: number; limit: number } };
    }).request.page).toEqual({ offset: 2, limit: 1 });

    f.store.getState().loadMoreFrequency();
    expect(f.frequencies()).toHaveLength(before + 1);
    f.frequencies().at(-1)!.resolve(fakeFrequencyPage('selection-a', 3, [
      { key: 'gamma', typeId: 3 },
    ]));
    await flush();
    expect(f.store.getState().frequency).toMatchObject({
      resident: { rows: [{ key: 'alpha' }, { key: 'beta' }, { key: 'gamma' }] },
      state: { status: 'ready' },
    });
  });

  it('add-exact admits sensitive matching', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);

    f.store.getState().addFrequencyTerm('Holmes');
    const group = f.store.getState().notebook.groups.at(-1)!;
    expect(groupTitle(group)).toBe('Holmes');
    expect(coreGroupOf(group).members).toEqual([
      expect.objectContaining({
        kind: 'token',
        surface: 'Holmes',
        match: { case: 'sensitive', diacritics: 'sensitive' },
      }),
    ]);
    expect(f.store.getState().activeGroupIds.has(group.id)).toBe(true);
  });

  it('the frequency matches action adds and globally reactivates the exact group', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().showFrequencyTermInKwic('Holmes');
    const group = f.store.getState().notebook.groups.at(-1)!;
    expect(coreGroupOf(group).members).toEqual([
      expect.objectContaining({
        surface: 'Holmes',
        match: { case: 'sensitive', diacritics: 'sensitive' },
      }),
    ]);
    expect(f.store.getState().activeGroupIds.has(group.id)).toBe(true);
    expect(f.store.getState().series.map((series) => series.id)).toContain(group.id);
    let query = f.kwics().filter((item) => !item.cancelled).at(-1)!.query as { tracks: { seriesId: string }[] };
    expect(query.tracks.map((track) => track.seriesId)).toContain(group.id);
    expect(f.store.getState().place).toBe('matches');

    f.store.getState().setGroupActive(group.id, false);
    expect(f.store.getState().series.map((series) => series.id)).not.toContain(group.id);
    f.store.getState().showFrequencyTermInKwic('Holmes');
    expect(f.store.getState().notebook.groups).toHaveLength(1);
    expect(f.store.getState().activeGroupIds.has(group.id)).toBe(true);
    expect(f.store.getState().series.map((series) => series.id)).toContain(group.id);
    query = f.kwics().filter((item) => !item.cancelled).at(-1)!.query as { tracks: { seriesId: string }[] };
    expect(query.tracks.map((track) => track.seriesId)).toContain(group.id);
    expect(f.store.getState().place).toBe('matches');
  });

  it('refuses duplicate exact terms but persists additions beyond the five active slots', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().addFrequencyTerm('Holmes');
    const count = f.store.getState().notebook.groups.length;
    f.store.getState().addFrequencyTerm('Holmes');
    expect(f.store.getState().notebook.groups).toHaveLength(count);
    expect(f.store.getState().notebookError).toMatch(/already/);

    for (let index = 0; index < MAX_SERIES - 1; index++) {
      f.store.getState().addFrequencyTerm(`term-${index}`);
    }
    const atCap = f.store.getState().notebook.groups.length;
    f.store.getState().addFrequencyTerm('one-too-many');
    expect(f.store.getState().notebook.groups).toHaveLength(atCap + 1);
    const hidden = f.store.getState().notebook.groups.at(-1)!;
    expect(f.store.getState().activeGroupIds.has(hidden.id)).toBe(false);
    expect(f.store.getState().notebookError).toBeNull();

    f.store.getState().setPlace('vocabulary');
    f.store.getState().showFrequencyTermInKwic('still-one-too-many');
    expect(f.store.getState().place).toBe('vocabulary');
    expect(f.store.getState().notebook.groups).toHaveLength(atCap + 2);
    expect(f.store.getState().notebookError).toMatch(/term added.*deactivate/);
  });

  it('applies atomic frequency text filters live and resets the progressive offset', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    const before = f.frequencies().length;
    f.store.getState().setFrequencyFilter({
      mode: 'literal',
      query: 'e\u0301',
    });
    expect(f.frequencies()).toHaveLength(before + 1);
    expect((f.frequencies().at(-1)!.query as {
      request: {
        filter: {
          minCount: number;
          minDocFreq: number;
          text: { mode: string; query: string };
          classes: string[];
        };
        sort: { by: string; dir: number };
        page: { offset: number; limit: number };
      };
    }).request).toEqual(expect.objectContaining({
      filter: expect.objectContaining({
        minCount: 1,
        minDocFreq: 1,
        text: { mode: 'literal', query: 'é' },
        classes: ['lexical'],
      }),
      sort: { by: 'count', dir: -1 },
      page: { offset: 0, limit: 100 },
    }));

    expect(f.store.getState().frequencyView.page).toEqual({ offset: 0, limit: 100 });
    f.store.getState().setFrequencyFilter({ mode: 'regex', query: 'é' });
    expect(f.store.getState().frequencyView.filter).toEqual({ mode: 'regex', query: 'é' });
    const valid = f.frequencies().length;
    f.store.getState().setFrequencyFilter({ mode: 'regex', query: '[' });
    expect(f.frequencies()).toHaveLength(valid);
    expect(f.store.getState().frequencyView.filter).toEqual({ mode: 'regex', query: 'é' });

    const issued = f.frequencies().length;
    f.store.getState().setFrequencyPage(5_000);
    expect(f.frequencies()).toHaveLength(issued + 1);
    expect(f.store.getState().frequencyView.page).toEqual({ offset: 5_000, limit: 100 });
    expect((f.frequencies().at(-1)!.query as {
      request: { page: { offset: number; limit: number } };
    }).request.page).toEqual({ offset: 5_000, limit: 100 });

    f.store.getState().setFrequencyFilter(null);
    expect(f.store.getState().frequencyView.filter).toBeUndefined();
    expect((f.frequencies().at(-1)!.query as {
      request: { filter: Record<string, unknown> };
    }).request.filter).not.toHaveProperty('text');
  });

  it('applies common-word depth live, resets paging, and omits the disabled filter', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setFrequencyPage(5_000);
    const before = f.frequencies().length;
    f.store.getState().setFrequencyStoplistTopN(500);
    expect(f.frequencies()).toHaveLength(before + 1);
    expect(f.store.getState().frequencyView).toMatchObject({
      stoplistTopN: 500,
      page: { offset: 0, limit: 100 },
    });
    const enabled = (f.frequencies().at(-1)!.query as {
      request: { filter: Record<string, unknown> };
    }).request.filter;
    expect(enabled.stoplist).toEqual({
      id: STOPLIST_EN_ID,
      version: STOPLIST_EN_VERSION,
      topN: 500,
    });

    f.store.getState().setFrequencyStoplistTopN(0);
    const disabled = (f.frequencies().at(-1)!.query as {
      request: { filter: Record<string, unknown> };
    }).request.filter;
    expect(disabled).not.toHaveProperty('stoplist');
  });

  it('restores a legacy literal frequency prefix as an anchored regex', () => {
    const f = harness();
    const workspace = workspaceState(BUILTIN_SHERLOCK_ID);
    f.store.getState().restoreWorkspace({
      ...workspace,
      views: {
        ...workspace.views,
        frequency: {
          ...workspace.views.frequency,
          prefixNfc: 'a.b[',
        },
      },
    });
    expect(f.store.getState().frequencyView.filter).toEqual({
      mode: 'regex',
      query: '^a\\.b\\[',
    });
  });

  it('restores stored expressions in regex mode and writes only the current filter shape', () => {
    const f = harness();
    const workspace = workspaceState(BUILTIN_SHERLOCK_ID);
    f.store.getState().restoreWorkspace({
      ...workspace,
      views: {
        ...workspace.views,
        frequency: {
          ...workspace.views.frequency,
          regex: '^Holmes$',
        },
      },
    });
    expect(f.store.getState().frequencyView.filter).toEqual({
      mode: 'regex',
      query: '^Holmes$',
    });
    const saved = workspaceFromApp(f.store.getState());
    expect(saved?.views.frequency.filter).toEqual({ mode: 'regex', query: '^Holmes$' });
    expect(saved?.views.frequency).not.toHaveProperty('regex');
    expect(saved?.views.frequency).not.toHaveProperty('prefixNfc');
  });
});

describe('dueling keyness query intent (slice-4)', () => {
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
      kind: 'library' as const,
      id: 'library',
      data: { ...BUILTIN_PROJECT.data, id: 'library', order },
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

  it('is independent of the linked trend brush', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const keynessCount = f.keynesses().length;
    const inventoryCount = f.keynessInventories().length;
    f.store.getState().setLinkedSelection({
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 1, end: 4 } }],
    });
    expect(f.keynesses()).toHaveLength(keynessCount);
    expect(f.keynessInventories()).toHaveLength(inventoryCount);
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
    expect(initialA.cancelled).toBe(true);
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
      project: { data: { ...BUILTIN_PROJECT.data, order: ['a', 'b'] } },
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
    f.store.getState().restoreWorkspace(workspace);
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
