/** Injected history, session, persistence and query boundaries for owning runtime suites. */
import type { AppState } from '../../src/lib/app-state.ts';

import {
  createAppRuntime,

} from '../../src/lib/store.ts';

import type { MetaPatch, QueryClient, SessionPort, WorkspaceStorePort } from '../../src/lib/app-state.ts';
import type { HistoryPort } from '../../src/lib/history-port.ts';
import type { QueryResultDataV4 } from '../../src/worker/protocol-v4.ts';
import type {
  AnalysisPhase,
  ProjectView,
  SessionState,
} from '../../src/lib/project-session.ts';
import { SessionCommandError } from '../../src/lib/project-session.ts';

import type { SnapshotInfo } from '../../src/lib/client.ts';
import { DEFAULT_INDEX_RECIPE, type NumericTrend, type WorkspaceV1 } from '@texttrends/core';

import type { LocalLibraryFile } from '../../src/lib/local-library.ts';
import { type NotebookGroupV1 } from '../../src/lib/notebook.ts';

import { type RsvpPacing } from '@texttrends/rsvp';

export interface Issued {
  snapshot: string;
  term: string;
  groupId: string;
  memberId: string;
  op: string;
  query: unknown;
  resolve: (r: QueryResultDataV4) => void;
  reject: (e: Error) => void;
  cancelled: boolean;
  lane: string | undefined;
}

export function fakeQueryClient() {
  const issued: Issued[] = [];
  const client: QueryClient = {
    query: (snapshot, query, context) => {
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
        lane: context?.lane,
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
  const isKeynessInventory = (entry: Issued) => entry.lane === 'compare-inventory-a' || entry.lane === 'compare-inventory-b';
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

export class FakeHistoryPort implements HistoryPort {
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

export function layerIds() {
  let next = 0;
  return () =>
    `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
}

export const LIBRARY_PROJECT: ProjectView = {
  id: 'library',
  data: { id: 'library', order: [], docs: [], indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: 'idx' },
};

export function snap(generation: string, snapshot: string, readyDocs: readonly string[] = ['a']): SnapshotInfo {
  return { generation, snapshot, readyDocs, missingDocs: [] };
}

export function sessionState(
  snapshot: SnapshotInfo | null,
  opts: { analysis?: AnalysisPhase; project?: Partial<ProjectView> } = {},
): SessionState {
  return {
    project: { ...LIBRARY_PROJECT, ...opts.project },
    analysis: opts.analysis ?? (snapshot ? { phase: 'ready' } : { phase: 'loading', detail: null }),
    snapshot,
    imports: [],
    sources: {},
    extractionDiagnostics: {},
  };
}

export interface Call {
  method: string;
  args: readonly unknown[];
}

export class FakeSessionPort implements SessionPort {
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
  appendFiles(files: readonly LocalLibraryFile[]): void { this.record('appendFiles', [files]); }
  replaceFiles(files: readonly LocalLibraryFile[]): void { this.record('replaceFiles', [files]); }
  removeImport(doc: string): void { this.record('removeImport', [doc]); }
  removeDocument(doc: string): void { this.record('removeDocument', [doc]); }
  removeDocuments(docs: readonly string[]): void { this.record('removeDocuments', [docs]); }
  editMeta(doc: string, patch: MetaPatch): void { this.record('editMeta', [doc, patch]); }
  setLanguage(doc: string, language: string): void { this.record('setLanguage', [doc, language]); }
  reorder(order: readonly string[]): void { this.record('reorder', [order]); }
}

export class FakeWorkspaceStore implements WorkspaceStorePort {
  readonly saves: WorkspaceV1[] = [];
  error: Error | null = null;

  async saveWorkspace(workspace: WorkspaceV1): Promise<void> {
    this.saves.push(workspace);
    if (this.error !== null) throw this.error;
  }
}

export function fakeTrend(marker: number): NumericTrend {
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

export function fakeCompanyResult(entry: Issued): QueryResultDataV4 {
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

export function fakeDestinationsResult(entry: Issued): QueryResultDataV4 {
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

export function fakeMatches(
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

export function fakeReaderPage(
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

export function fakeInventoryResult(
  marker: number,
  extents: readonly { readonly doc: string; readonly fullTokens: number }[] = [],
): QueryResultDataV4 {
  return {
    op: 'inventory',
    inventory: {
      method: 'inventory/2',
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

export function fakeFrequencyResult(marker: number): QueryResultDataV4 {
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

export function fakeFrequencyPage(
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

export function fakeKeynessPage(
  total: number,
  typeIds: readonly number[],
): QueryResultDataV4 {
  return {
    op: 'keyness',
    keyness: {
      method: 'keyness-g2-2x2/2',
      effect: 'log-ratio-proportional/1',
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

export function harness(initial?: SessionState, opts?: {
  seed?: boolean;
  saved?: WorkspaceV1;
  workspace?: FakeWorkspaceStore;
  rsvpPacing?: RsvpPacing;
  history?: HistoryPort;
}) {
  const q = fakeQueryClient();
  // Deterministic injected UUIDs: u1, u2, … (creation order).
  let n = 0;
  const runtime = createAppRuntime(q.client, {
    newId: () => `u${++n}`,
    ...(opts?.workspace === undefined ? {} : { workspace: opts.workspace }),
    ...(opts?.rsvpPacing === undefined ? {} : { rsvpPacing: opts.rsvpPacing }),
    ...(opts?.history === undefined ? {} : { history: opts.history }),
  });
  const port = new FakeSessionPort(initial);
  runtime.attachSession(port, opts?.saved);
  // The store starts EMPTY (the composition root seeds the demo comparison
  // in production — store-instance.ts). Bridge tests that need series present
  // BEFORE a publication opt in with seed:true.
  if (opts?.seed === true) runtime.useApp.getState().mergeStarterTerms('Holmes, Moriarty');
  return { ...q, runtime, store: runtime.useApp, port };
}

export function restoreFixture(f: ReturnType<typeof harness>, saved: WorkspaceV1) {
  const initial = f.port.getState();
  f.runtime.dispose();
  Object.assign(f, harness(initial, { saved }));
}

export function editTerm(state: AppState, id: string, patch: Partial<Parameters<AppState['saveTerm']>[1]>) {
  const group = state.notebook.groups.find((item) => item.id === id)!;
  return state.saveTerm(id, { ...group, ...patch });
}

export const flush = () => new Promise((r) => setTimeout(r, 0));

export const semanticEditTop = (g: NotebookGroupV1): NotebookGroupV1 => ({
  ...g,
  aliases: ['holm*'],
});
