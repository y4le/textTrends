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
 * The generation lifecycle (loadSherlock/fetch/restart/import/CAS/reattach)
 * moved WHOLESALE to `ProjectSession` and is covered in project-session.test.ts;
 * those store-owned tests are deleted here. One composition test proves the real
 * `ProjectSession` satisfies `SessionPort` and drives the bridge end to end.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createAppRuntime,
  KWIC_CENTER_DEBOUNCE_MS,
  type MetaPatch,
  type QueryClient,
  type SessionPort,
} from '../src/lib/store.ts';
import type { QueryResultDataV4 } from '../src/worker/protocol-v4.ts';
import type {
  AnalysisPhase,
  ProjectView,
  SessionState,
} from '../src/lib/project-session.ts';
import { SessionCommandError } from '../src/lib/project-session.ts';
import { SHERLOCK } from '../src/lib/project.ts';
import { WorkerClientError } from '../src/lib/client.ts';
import type { SnapshotInfo } from '../src/lib/client.ts';
import {
  DEFAULT_INDEX_RECIPE,
  TERM_GROUP_LIMITS_V1,
  type NumericTrend,
  type PassageResult,
} from '@texttrends/core';

// ── A fake QueryClient that records issued trend/KWIC/passage queries. ──
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
      const q = query as {
        op: string;
        group?: { id: string; members: { id: string; surface: string }[] };
        tracks?: { seriesId: string; group: { id: string; members: { id: string; surface: string }[] } }[];
        request?: { doc: string; centerToken: number; tracks: { seriesId: string }[] };
      };
      // trend carries `group`; kwic/2 carries `tracks` (first track's group here).
      const primaryGroup = q.group ?? q.tracks?.[0]?.group;
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
  return {
    client,
    issued,
    trends: () => issued.filter((q) => q.op === 'trend'),
    kwics: () => issued.filter((q) => q.op === 'kwic'),
    passages: () => issued.filter((q) => q.op === 'passage'),
    structures: () => issued.filter((q) => q.op === 'structure'),
    editContexts: () => issued.filter((q) => q.op === 'structure-edit-context'),
    lineExcerpts: () => issued.filter((q) => q.op === 'line-excerpt'),
  };
}

/** A structure query result echoing the two artifact identities (§12.7). */
function fakeStructure(doc: string, tops: readonly number[]): QueryResultDataV4 {
  const rows = [
    { section: { id: `${doc}:root`, doc, origin: 'fixed' as const, level: 0, chars: { start: 0, end: 1000 } }, tokens: { start: 0, end: 100 } },
    ...tops.map((t, i) => ({
      section: { id: `${doc}:c${i}`, doc, origin: 'heuristic' as const, parent: `${doc}:root`, level: 1, title: `Chapter ${i + 1}`, chars: { start: t, end: t + 1 } },
      tokens: { start: t, end: t + 10 },
    })),
  ];
  return { op: 'structure', structure: { doc, structure: `str-${doc}`, index: `idx-${doc}`, rows } };
}

function fakeEditContext(doc: string): QueryResultDataV4 {
  return {
    op: 'structure-edit-context',
    context: {
      doc,
      structure: `str-${doc}`,
      index: `idx-${doc}`,
      base: { text: `t-${doc}`, candidates: `c-${doc}`, baseRecipe: `r-${doc}` },
      override: `o-${doc}`,
      detected: [{ key: 'root', origin: 'fixed', level: 0, chars: { start: 0, end: 100 } }],
      current: [{ key: 'root', section: { id: `${doc}:root`, doc, origin: 'fixed', level: 0, chars: { start: 0, end: 100 } }, tokens: { start: 0, end: 50 } }],
    },
  };
}

function fakeLineExcerpt(doc: string, anchor: number): QueryResultDataV4 {
  return {
    op: 'line-excerpt',
    excerpt: { doc, chars: { start: anchor, end: anchor + 5 }, text: 'hello', truncatedStart: false, truncatedEnd: false },
  };
}

// ── A fake SessionPort: a spyable immutable-state emitter. ──
const BUILTIN_PROJECT: ProjectView = {
  kind: 'builtin',
  id: 'builtin/sherlock',
  data: { id: 'builtin/sherlock', order: [], docs: [], indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: 'idx' },
  baseRevision: null,
  dirty: false,
  save: { phase: 'idle' },
  saveable: false,
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
    reattach: {},
    sourceEvidence: {},
    corrections: {},
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
  createUserProject(files: readonly unknown[], opts?: unknown): void { this.record('createUserProject', [files, opts]); }
  appendFiles(files: readonly unknown[], opts?: unknown): void { this.record('appendFiles', [files, opts]); }
  removeImport(doc: string): void { this.record('removeImport', [doc]); }
  editMeta(doc: string, patch: MetaPatch): void { this.record('editMeta', [doc, patch]); }
  setLanguage(doc: string, language: string): void { this.record('setLanguage', [doc, language]); }
  setStructureOverride(doc: string, override: unknown): void { this.record('setStructureOverride', [doc, override]); }
  reorder(order: readonly string[]): void { this.record('reorder', [order]); }
  save(): void { this.record('save', []); }
  setPersistIntent(doc: string, intent: boolean): void { this.record('setPersistIntent', [doc, intent]); }
  reattach(doc: string, file: unknown): void { this.record('reattach', [doc, file]); }
  loadUserProject(): void { this.record('loadUserProject', []); }
}

function fakeTrend(marker: number): NumericTrend {
  return {
    coordinate: 'declared-sequence',
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

function fakePassage(start: number, end: number, center: number, doc = 'a'): PassageResult {
  const count = end - start;
  return {
    doc,
    centerToken: center,
    tokens: { start, end },
    docCharsUtf16: { start: 0, end: count },
    text: ' '.repeat(count),
    tokenStartsUtf16: Array.from({ length: count }, (_, i) => i),
    tokenEndsUtf16: Array.from({ length: count }, (_, i) => i + 1),
    centerCharsUtf16: { start: center - start, end: center - start + 1 },
    marks: [],
    truncatedByCharCap: false,
  };
}

/** A runtime with a fresh fake QueryClient + an attached fake SessionPort. */
function harness(initial?: SessionState, opts?: { seed?: boolean }) {
  const q = fakeQueryClient();
  // Deterministic injected UUIDs: u1, u2, … (creation order).
  let n = 0;
  const runtime = createAppRuntime(q.client, { newId: () => `u${++n}` });
  const port = new FakeSessionPort(initial);
  runtime.attachSession(port);
  // The store starts EMPTY (the composition root seeds the demo comparison
  // in production — store-instance.ts). Bridge tests that need series present
  // BEFORE a publication opt in with seed:true.
  if (opts?.seed === true) runtime.useApp.getState().quickAdd('Holmes, Moriarty');
  return { ...q, runtime, store: runtime.useApp, port };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the session bridge', () => {
  it('seeds the current session state on attach, before any publication', () => {
    const q = fakeQueryClient();
    const runtime = createAppRuntime(q.client);
    const userState = sessionState(null, { project: { kind: 'user', id: 'user/default', baseRevision: 1, dirty: true, save: { phase: 'idle' }, saveable: true } });
    runtime.attachSession(new FakeSessionPort(userState));
    const s = runtime.useApp.getState();
    expect(s.bootstrap.phase).toBe('attached');
    expect(s.projectSession).toBe(userState);
    expect(s.projectSession!.project.kind).toBe('user');
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
    // Same snapshot identity, different unrelated state (imports/save/sources).
    port.emit(sessionState(snap('g1', 's1'), { project: { dirty: true } }));
    expect(store.getState().projectSession!.project.dirty).toBe(true);
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

  it('the built-in projection is not saveable and the save wrapper cannot bypass the session', () => {
    const { store, port } = harness();
    expect(store.getState().projectSession!.project.saveable).toBe(false);
    store.getState().saveProject();
    // The wrapper delegates to the session; it never fabricates a save.
    expect(port.calls.filter((c) => c.method === 'save').length).toBe(1);
  });

  it('each command wrapper dispatches to the attached session', () => {
    const { store, port } = harness();
    const s = store.getState();
    s.removeImport('d');
    s.editMeta('d', { title: 't' });
    s.setLanguage('d', 'fr');
    s.setStructureOverride('d', null);
    s.reorder(['d']);
    s.setPersistIntent('d', true);
    s.saveProject();
    s.loadSavedProject();
    s.reattach('d', { name: 'f.txt', size: 1, arrayBuffer: async () => new ArrayBuffer(1) });
    s.retryAnalysis();
    expect(port.calls.map((c) => c.method)).toEqual([
      'removeImport', 'editMeta', 'setLanguage', 'setStructureOverride', 'reorder', 'setPersistIntent', 'save', 'loadUserProject', 'reattach', 'start',
    ]);
  });

  it('importFiles dispatches createUserProject on the built-in, appendFiles on a user project', () => {
    const { store, port } = harness();
    const files = [{ name: 'a.txt', size: 3, arrayBuffer: async () => new ArrayBuffer(3) }];
    store.getState().importFiles(files);
    expect(port.calls.at(-1)!.method).toBe('createUserProject');
    port.emit(sessionState(snap('g1', 's1'), { project: { kind: 'user', id: 'user/default', baseRevision: 0, dirty: true, save: { phase: 'idle' }, saveable: false } }));
    store.getState().importFiles(files);
    expect(port.calls.at(-1)!.method).toBe('appendFiles');
  });

  it('a synchronous SessionCommandError becomes one bounded UI command error', () => {
    const { store, port } = harness();
    port.errors.save = new SessionCommandError('save called when not saveable');
    store.getState().saveProject();
    expect(store.getState().commandError).toContain('not saveable');
    store.getState().clearCommandError();
    expect(store.getState().commandError).toBeNull();
  });

  it('a command before any session is attached surfaces a bounded error, not a throw', () => {
    const q = fakeQueryClient();
    const runtime = createAppRuntime(q.client); // no attachSession
    expect(() => runtime.useApp.getState().saveProject()).not.toThrow();
    expect(runtime.useApp.getState().commandError).toContain('initializing');
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

  it('dispose clears the queued KWIC debounce — no query can fire after teardown', () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().quickAdd('holmes');
      f.store.getState().setScrub({ doc: 'a', token: 100 }); // arms the debounce timer
      const count = f.kwics().length;
      f.runtime.dispose();
      vi.advanceTimersByTime(KWIC_CENTER_DEBOUNCE_MS * 3);
      expect(f.kwics().length).toBe(count); // the queued center never issued
    } finally {
      vi.useRealTimers();
    }
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
    expect(liveKwic.length).toBe(1); // ONE merged concordance, not one per series
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

  it('a focus change does NOT reissue or cancel the concordance (focus independence)', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const kwicBefore = f.kwics().filter((q) => !q.cancelled).at(-1)!;
    const kwicCount = f.kwics().length;
    f.store.getState().setFocus(f.store.getState().series[1]!.id);
    expect(f.store.getState().focusedSeries).toBe(f.store.getState().series[1]!.id);
    expect(kwicBefore.cancelled).toBe(false); // the merged concordance is untouched by focus
    expect(f.kwics().length).toBe(kwicCount); // no reissue
  });

  it('toggling a term off reissues the concordance without that track; on re-adds it', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const [holmes, moriarty] = f.store.getState().series;
    const tracksOf = () => (f.kwics().filter((q) => !q.cancelled).at(-1)!.query as { tracks: { seriesId: string }[] }).tracks.map((t) => t.seriesId);
    f.store.getState().toggleKwicSeries(moriarty!.id);
    expect(f.store.getState().kwicEnabledSeries.has(moriarty!.id)).toBe(false);
    expect(tracksOf()).toEqual([holmes!.id]);
    f.store.getState().toggleKwicSeries(moriarty!.id);
    expect(tracksOf()).toEqual([holmes!.id, moriarty!.id]);
  });

  it('toggling ALL terms off shows the no-terms state and issues no query', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const before = f.kwics().length; // the initial merged query
    for (const s of f.store.getState().series) f.store.getState().toggleKwicSeries(s.id);
    expect(f.store.getState().kwicEnabledSeries.size).toBe(0);
    expect(f.store.getState().kwic!.state.status).toBe('no-terms');
    expect(f.kwics().length).toBe(before + 1); // only the first toggle queried; the emptying toggle did not
  });

  it('preserves enabled on/off across an input edit; adds new terms enabled, drops departed', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    f.store.getState().toggleKwicSeries(f.store.getState().series[1]!.id); // moriarty OFF
    f.store.getState().quickAdd('holmes, watson, moriarty'); // add watson, keep the others
    const series = f.store.getState().series;
    const enabled = f.store.getState().kwicEnabledSeries;
    const id = (label: string) => series.find((s) => s.label === label)!.id;
    expect(enabled.has(id('holmes'))).toBe(true); // surviving, was on
    expect(enabled.has(id('moriarty'))).toBe(false); // surviving, was off — preserved
    expect(enabled.has(id('watson'))).toBe(true); // newly introduced → enabled
  });

  it('a settled scrub re-centres the concordance (debounced); a raw scrub invalidates the prior result at once', () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().quickAdd('holmes');
      const kwicBefore = f.kwics().filter((q) => !q.cancelled).at(-1)!;
      const countBefore = f.kwics().length;
      f.store.getState().setScrub({ doc: 'a', token: 100 });
      // Immediate: the prior result is invalidated; no query yet (debouncing).
      expect(kwicBefore.cancelled).toBe(true);
      expect(f.store.getState().kwic!.state.status).toBe('pending');
      expect(f.kwics().length).toBe(countBefore);
      // A second raw scrub only replaces the pending center — still no query.
      f.store.getState().setScrub({ doc: 'a', token: 250 });
      expect(f.kwics().length).toBe(countBefore);
      vi.advanceTimersByTime(KWIC_CENTER_DEBOUNCE_MS);
      // Trailing edge: exactly one query, centred on the LATEST scrub.
      expect(f.kwics().length).toBe(countBefore + 1);
      const centered = f.kwics().at(-1)!;
      expect((centered.query as { request: { center?: { doc: string; token: number } } }).request.center).toEqual({ doc: 'a', token: 250 });
      expect(f.store.getState().kwic!.center).toEqual({ doc: 'a', token: 250 });
      // clearScrub falls back to reading order immediately (no center).
      f.store.getState().clearScrub();
      const reading = f.kwics().at(-1)!;
      expect((reading.query as { request: { center?: unknown } }).request.center).toBeUndefined();
      expect(f.store.getState().kwic!.center).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearing the scrub (blank input, snapshot-null) resets the center — no invisible axis resurrects', () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().quickAdd('holmes');
      f.store.getState().setScrub({ doc: 'a', token: 100 });
      vi.advanceTimersByTime(KWIC_CENTER_DEBOUNCE_MS);
      expect(f.store.getState().kwic!.center).toEqual({ doc: 'a', token: 100 });
      // Emptying the comparison clears the chart position; a later term must
      // NOT re-center. (Blank quick-add is a no-op — removal empties.)
      f.store.getState().removeGroup(f.store.getState().series[0]!.id);
      f.store.getState().quickAdd('holmes');
      const afterBlank = f.kwics().filter((q) => !q.cancelled).at(-1)!;
      expect((afterBlank.query as { request: { center?: unknown } }).request.center).toBeUndefined();
      expect(f.store.getState().kwic!.center).toBeNull();
      // Re-center, then a snapshot-null transition + a new snapshot with the SAME doc.
      f.store.getState().setScrub({ doc: 'a', token: 100 });
      vi.advanceTimersByTime(KWIC_CENTER_DEBOUNCE_MS);
      expect(f.store.getState().kwic!.center).not.toBeNull();
      f.port.emit(sessionState(null)); // mid-generation: no snapshot
      f.port.publishSnapshot('g2', 's2', ['a']); // same doc ready again
      const afterNull = f.kwics().filter((q) => !q.cancelled).at(-1)!;
      expect((afterNull.query as { request: { center?: unknown } }).request.center).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('scrubbing with EVERY term disabled keeps the explicit no-terms state and issues no query', () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().quickAdd('holmes, moriarty');
      for (const s of f.store.getState().series) f.store.getState().toggleKwicSeries(s.id);
      expect(f.store.getState().kwic!.state.status).toBe('no-terms');
      const count = f.kwics().length;
      f.store.getState().setScrub({ doc: 'a', token: 50 });
      expect(f.store.getState().kwic!.state.status).toBe('no-terms'); // NOT flipped to pending
      vi.advanceTimersByTime(KWIC_CENTER_DEBOUNCE_MS);
      expect(f.kwics().length).toBe(count); // no query issued
      expect(f.store.getState().kwic!.state.status).toBe('no-terms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late KWIC result from a superseded intent cannot land', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const oldKwic = f.kwics().filter((q) => !q.cancelled).at(-1)!;
    f.store.getState().toggleKwicSeries(f.store.getState().series[1]!.id); // reissues, supersedes oldKwic
    oldKwic.resolve({ op: 'kwic', total: 9, rows: [] }); // raced past cancel
    await flush();
    expect(f.store.getState().kwic!.state.status).toBe('pending'); // the stale result did not land
  });

  it('view toggle is presentation-only: no query is issued', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    const count = f.issued.length;
    f.store.getState().setTrendView('by-book');
    f.store.getState().setTrendView('series');
    expect(f.issued.length).toBe(count);
    expect(f.store.getState().trendView).toBe('series');
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

  it('scrub: first target fetches a passage block with one track per series', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    f.store.getState().setScrub({ doc: 'a', token: 500 });
    const issued = f.passages();
    expect(issued.length).toBe(1);
    const q = issued[0]!.query as { request: { doc: string; centerToken: number; tracks: { seriesId: string }[] } };
    expect(q.request.doc).toBe('a');
    expect(q.request.centerToken).toBe(500);
    expect(q.request.tracks.map((t) => t.seriesId)).toEqual(
      f.store.getState().series.map((s) => s.id),
    );
  });

  it('scrub: moves inside the guard band are purely local; edge moves refetch', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes');
    f.store.getState().setScrub({ doc: 'a', token: 500 });
    f.passages()[0]!.resolve({ op: 'passage', passage: fakePassage(400, 600, 500) });
    await flush();
    expect(f.store.getState().passage).not.toBeNull();
    f.store.getState().setScrub({ doc: 'a', token: 510 });
    f.store.getState().setScrub({ doc: 'a', token: 450 });
    expect(f.passages().length).toBe(1); // both inside [428, 572) — no fetch
    f.store.getState().setScrub({ doc: 'a', token: 590 }); // within block, past the guard
    expect(f.passages().length).toBe(2);
  });

  it('scrub: one active request plus one replaceable pending — motion never queues', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes');
    f.store.getState().setScrub({ doc: 'a', token: 500 });
    expect(f.passages().length).toBe(1);
    f.store.getState().setScrub({ doc: 'a', token: 900 });
    f.store.getState().setScrub({ doc: 'a', token: 1200 });
    f.store.getState().setScrub({ doc: 'a', token: 1500 });
    expect(f.passages().length).toBe(1);
    f.passages()[0]!.resolve({ op: 'passage', passage: fakePassage(400, 600, 500) });
    await flush();
    expect(f.passages().length).toBe(2);
    const q = f.passages()[1]!.query as { request: { centerToken: number } };
    expect(q.request.centerToken).toBe(1500);
  });

  it('scrub: an input change invalidates the block, refetches for the kept position, and a stale in-flight block cannot land', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes');
    f.store.getState().setScrub({ doc: 'a', token: 500 });
    const first = f.passages()[0]!; // left IN FLIGHT across the input change
    f.store.getState().quickAdd('holmes, watson'); // marks are stale — new tracks needed
    expect(first.cancelled).toBe(true);
    expect(f.store.getState().passage).toBeNull();
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 500 }); // position kept
    const refetch = f.passages().at(-1)!;
    expect(refetch).not.toBe(first);
    const q = refetch.query as { request: { tracks: { seriesId: string }[] } };
    expect(q.request.tracks.length).toBe(2);
    first.resolve({ op: 'passage', passage: fakePassage(0, 200, 100) });
    await flush();
    expect(f.store.getState().passage).toBeNull();
    refetch.resolve({ op: 'passage', passage: fakePassage(400, 600, 500) });
    await flush();
    expect(f.store.getState().passage).not.toBeNull();
  });

  it('scrub: a rejected center clears the scrub instead of showing a mismatched block', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes');
    f.store.getState().setScrub({ doc: 'a', token: 99999 });
    f.passages()[0]!.reject(new Error('REQUEST_INVALID: centerToken 99999 outside [0, 5000)'));
    await flush();
    expect(f.store.getState().scrub).toBeNull();
    expect(f.store.getState().passage).toBeNull();
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

// ── The chapter-outline (structure) query intent (commit 8a). Independent of
// the term series, lease-guarded on (generation,snapshot,doc). ──
describe('the outline (structure) intent', () => {
  /** A session state whose project declares `order` (docs left empty — the
   *  store's focus resolution reads only the order). */
  function withOrder(snapshot: SnapshotInfo | null, order: readonly string[]): SessionState {
    return sessionState(snapshot, {
      project: { data: { id: 'builtin/sherlock', order: [...order], docs: [], indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: 'idx' } },
    });
  }

  it('defaults the focus to the first READY doc in declared order and queries it', () => {
    const { store, port, structures, trends } = harness(undefined, { seed: true });
    // Declared order [a,b,c]; only b and c ready, published completion-first.
    port.emit(withOrder(snap('g1', 's1', ['c', 'b']), ['a', 'b', 'c']));
    expect(store.getState().focusedDoc).toBe('b'); // declared order, not 'c'
    const s = structures();
    expect(s.length).toBe(1);
    expect((s[0]!.query as { request: { doc: string } }).request.doc).toBe('b');
    // The term series still queried independently.
    expect(trends().length).toBeGreaterThan(0);
  });

  it('issues the outline even with an EMPTY term input', () => {
    const { store, port, structures } = harness();
    // The store starts with an EMPTY notebook — no series without a quickAdd.
    port.emit(withOrder(snap('g1', 's1', ['a']), ['a']));
    expect(store.getState().series.length).toBe(0);
    expect(structures().length).toBe(1); // outline is not gated on the series
  });

  it('writes a ready result and ignores one for a superseded focus', async () => {
    const { store, port, structures } = harness();
    port.emit(withOrder(snap('g1', 's1', ['a', 'b']), ['a', 'b']));
    const first = structures()[0]!;
    // Focus moves to b before a's result arrives.
    store.getState().setFocusedDoc('b');
    first.resolve(fakeStructure('a', [400])); // stale focus
    await flush();
    expect(store.getState().structure?.doc).toBe('b');
    expect(store.getState().structure?.state.status).toBe('pending');
    // b resolves and is written.
    structures().find((q) => (q.query as { request: { doc: string } }).request.doc === 'b')!.resolve(fakeStructure('b', [500]));
    await flush();
    const st = store.getState().structure;
    expect(st?.doc).toBe('b');
    expect(st?.state.status).toBe('ready');
  });

  it('setFocusedDoc reissues ONLY the outline, and rejects a non-ready doc', () => {
    const { store, port, structures, trends } = harness();
    port.emit(withOrder(snap('g1', 's1', ['a', 'b']), ['a', 'b']));
    const trendsBefore = trends().filter((q) => !q.cancelled).length;
    const structuresBefore = structures().length;
    store.getState().setFocusedDoc('b');
    expect(store.getState().focusedDoc).toBe('b');
    expect(structures().length).toBe(structuresBefore + 1); // one more outline query
    expect(trends().filter((q) => !q.cancelled).length).toBe(trendsBefore); // trends untouched
    // A doc that is not ready is refused.
    store.getState().setFocusedDoc('zzz');
    expect(store.getState().focusedDoc).toBe('b');
    expect(structures().length).toBe(structuresBefore + 1);
  });

  it('preserves the focus across an unrelated publication; resets when it leaves the ready set', () => {
    const { store, port, structures } = harness();
    port.emit(withOrder(snap('g1', 's1', ['a', 'b']), ['a', 'b']));
    store.getState().setFocusedDoc('b');
    const countAfterFocus = structures().length;
    // Same snapshot identity, unrelated state → focus and outline unchanged.
    port.emit(withOrder(snap('g1', 's1', ['a', 'b']), ['a', 'b']));
    expect(store.getState().focusedDoc).toBe('b');
    expect(structures().length).toBe(countAfterFocus);
    // A NEW snapshot where b is gone → focus falls back to the first ready doc.
    port.emit(withOrder(snap('g2', 's2', ['a']), ['a', 'b']));
    expect(store.getState().focusedDoc).toBe('a');
  });

  it('clears the outline when a null snapshot supersedes it', () => {
    const { store, port } = harness();
    port.emit(withOrder(snap('g1', 's1', ['a']), ['a']));
    expect(store.getState().focusedDoc).toBe('a');
    port.emit(withOrder(null, ['a']));
    expect(store.getState().focusedDoc).toBeNull();
    expect(store.getState().structure).toBeNull();
  });
});

// ── On-demand authoring intents (commit 8b): edit-context + line-excerpt, each
// with its own lease lane and (generation,snapshot,doc) guard, cleared on a snapshot
// change. The correction editor (8c) drives these. ──
describe('authoring intents (edit-context + line-excerpt)', () => {
  it('requestEditContext issues for a ready doc and writes the ready result', async () => {
    const { store, port, editContexts } = harness();
    port.publishSnapshot('g1', 's1', ['a']);
    store.getState().requestEditContext('a');
    const q = editContexts();
    expect(q.length).toBe(1);
    expect((q[0]!.query as { request: { doc: string } }).request.doc).toBe('a');
    expect(store.getState().editContext?.state.status).toBe('pending');
    q[0]!.resolve(fakeEditContext('a'));
    await flush();
    const ec = store.getState().editContext;
    expect(ec?.doc).toBe('a');
    expect(ec?.state.status).toBe('ready');
    if (ec?.state.status === 'ready') expect(ec.state.context.detected[0]!.key).toBe('root');
  });

  it('requestEditContext refuses a non-ready doc', () => {
    const { store, port, editContexts } = harness();
    port.publishSnapshot('g1', 's1', ['a']);
    store.getState().requestEditContext('zzz');
    expect(editContexts().length).toBe(0);
    expect(store.getState().editContext).toBeNull();
  });

  it('a superseded edit-context result cannot write', async () => {
    const { store, port, editContexts } = harness();
    port.publishSnapshot('g1', 's1', ['a']);
    store.getState().requestEditContext('a');
    const stale = editContexts()[0]!;
    port.publishSnapshot('g2', 's2', ['a']); // new snapshot supersedes
    stale.resolve(fakeEditContext('a'));
    await flush();
    // Cleared by the snapshot change; the stale result did not resurrect it.
    expect(store.getState().editContext).toBeNull();
  });

  it('requestLineExcerpt writes a result keyed by doc + anchor', async () => {
    const { store, port, lineExcerpts } = harness();
    port.publishSnapshot('g1', 's1', ['a']);
    store.getState().requestLineExcerpt('a', 42, 200);
    const q = lineExcerpts();
    expect(q.length).toBe(1);
    const req = (q[0]!.query as { request: { doc: string; anchor: number; maxChars: number } }).request;
    expect(req).toEqual({ doc: 'a', anchor: 42, maxChars: 200 });
    q[0]!.resolve(fakeLineExcerpt('a', 42));
    await flush();
    expect(store.getState().lineExcerpt?.anchor).toBe(42);
    expect(store.getState().lineExcerpt?.state.status).toBe('ready');
  });

  it('a snapshot change clears and cancels both authoring intents', () => {
    const { store, port, editContexts, lineExcerpts } = harness();
    port.publishSnapshot('g1', 's1', ['a']);
    store.getState().requestEditContext('a');
    store.getState().requestLineExcerpt('a', 10, 100);
    expect(store.getState().editContext).not.toBeNull();
    expect(store.getState().lineExcerpt).not.toBeNull();
    port.publishSnapshot('g2', 's2', ['a']);
    expect(store.getState().editContext).toBeNull();
    expect(store.getState().lineExcerpt).toBeNull();
    expect(editContexts()[0]!.cancelled).toBe(true);
    expect(lineExcerpts()[0]!.cancelled).toBe(true);
  });
});

// ── Composition: the real ProjectSession satisfies SessionPort and drives the
// bridge. The generation-lifecycle races are covered in project-session.test.ts;
// this only proves the two interfaces compose end to end. ──
describe('real ProjectSession composes with the store bridge', () => {
  beforeAll(async () => {
    // Warm the shared memoized canonical hashes so startGeneration settles fast.
    const { canonicalRecipeHashes } = await import('./support/spec-fixtures.ts');
    await canonicalRecipeHashes();
  });

  it('attaching a real session mirrors its analysis + snapshot into the store', async () => {
    const { ProjectSession } = await import('../src/lib/project-session.ts');
    const { builtinProject } = await import('../src/lib/project.ts');
    const { DEFAULT_STRUCTURE_RECIPE, hashStructureCandidates } = await import('@texttrends/core');
    const { canonicalRecipeHashes } = await import('./support/spec-fixtures.ts');
    const canon = await canonicalRecipeHashes();
    const { txt } = canon.recipes;
    const [erh, srh, irh] = [canon.txtRecipeHash, canon.structureRecipeHash, canon.indexRecipeHash];
    const cand = await hashStructureCandidates([]);
    const doc = {
      doc: 'd1',
      sourceName: 'd1',
      meta: { title: 'D1', language: 'en', tags: [] as string[] },
      source: { kind: 'text' as const, hash: 'srchash', byteLength: 10, format: 'txt' as const, encoding: { detected: 'utf-8' as const, hadReplacementChars: false } },
      sourceAvailability: 'bundled' as const,
      extraction: { recipe: txt, recipeHash: erh, text: 'txthash', textLengthUtf16: 8, candidates: cand },
      structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: srh, override: { status: 'none' as const } },
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
        result: Promise.resolve({ generation, snapshot: `${generation}#snap`, readyDocs: ['d1'], missing: [] }),
        cancel: () => undefined,
      }),
      ingest: () => ({ job: 1 }),
      projectLoad: () => ({ result: Promise.resolve({ kind: 'missing' as const }), cancel: () => undefined }),
      projectSave: () => ({ result: Promise.resolve({ revision: 1 }), cancel: () => undefined }),
      sourcePersist: () => ({ result: Promise.resolve(), cancel: () => undefined }),
    };
    const session = new ProjectSession(builtinProject(data), {
      client,
      bundledBytes: { get: async () => new ArrayBuffer(10) },
      newDocId: () => 'id',
      hashBytes: async () => 'srchash',
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

// ── Slice-1 commit B: the query-notebook state machine (recorded ruling,
//    docs/design/term-groups-plan.md). UI lands in later commits; these prove
//    the model invariants through the store actions alone. ──
describe('query notebook — identity discipline', () => {
  const groupsOf = (f: ReturnType<typeof harness>) => f.store.getState().notebook.groups;

  /** Same UUID and member id, different MATCHING semantics. */
  const semanticEdit = (g: { id: string; name: string; members: readonly { id: string }[]; countOverlaps: boolean }) => ({
    ...g,
    members: [{ id: g.members[0]!.id, kind: 'prefix' as const, stem: 'holm', match: { case: 'folded' as const, diacritics: 'folded' as const } }],
  });

  it('quickAdd is APPEND-ONLY: a duplicate matching identity is skipped (UUID, member ids, focus, and concordance selection untouched)', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    f.store.getState().setFocus(moriarty!.id);
    f.store.getState().toggleKwicSeries(holmes!.id); // holmes OFF
    f.store.getState().quickAdd('holmes, watson'); // holmes skipped, watson appended
    const after = groupsOf(f);
    expect(after.map((g) => g.name)).toEqual(['holmes', 'moriarty', 'watson']);
    expect(after[0]!.id).toBe(holmes!.id); // the duplicate touched nothing
    expect(after[0]!.members[0]!.id).toBe(holmes!.members[0]!.id);
    expect(after[1]!.id).toBe(moriarty!.id); // append-only: nothing replaced
    expect(f.store.getState().kwicEnabledSeries.has(holmes!.id)).toBe(false); // toggle survives
    expect(f.store.getState().kwicEnabledSeries.has(after[2]!.id)).toBe(true); // new group enabled
    expect(f.store.getState().focusedSeries).toBe(moriarty!.id); // focus survives
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

  it('a member edit preserves the UUID, changes semantic identity, and reissues trend+KWIC+passage', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    const g = groupsOf(f)[0]!;
    f.store.getState().setScrub({ doc: 'a', token: 5 }); // arm a passage intent
    await flush();
    const trendsBefore = f.trends().length;
    const kwicsBefore = f.kwics().length;
    const passagesBefore = f.passages().length;
    f.store.getState().setGroupMembers(g.id, [
      { id: g.members[0]!.id, kind: 'token', surface: 'holmes', match: { case: 'folded', diacritics: 'folded' } },
      { id: 'm-alias', kind: 'token', surface: 'sherlock', match: { case: 'folded', diacritics: 'folded' } },
    ], false);
    expect(groupsOf(f)[0]!.id).toBe(g.id); // UUID stable (invariant 3)
    expect(f.trends().length).toBeGreaterThan(trendsBefore);
    expect(f.kwics().length).toBeGreaterThan(kwicsBefore);
    expect(f.passages().length).toBeGreaterThan(passagesBefore);
    // The EXACT authored spec reaches EVERY operation's wire request — the
    // COMPLETE group value (ids, kinds, match modes, countOverlaps), deep-equal
    // against the authored expectation, on trend AND kwic AND passage. A
    // trackSpecs reconstruction/defaulting regression fails all three.
    const authored = {
      id: g.id,
      members: [
        { id: g.members[0]!.id, kind: 'token', surface: 'holmes', match: { case: 'folded', diacritics: 'folded' } },
        { id: 'm-alias', kind: 'token', surface: 'sherlock', match: { case: 'folded', diacritics: 'folded' } },
      ],
      countOverlaps: false,
    };
    const trendWire = (f.trends().filter((t) => !t.cancelled).at(-1)!.query as { group: unknown }).group;
    expect(trendWire).toEqual(authored);
    const kwicWire = (f.kwics().filter((t) => !t.cancelled).at(-1)!.query as { tracks: { seriesId: string; group: unknown }[] }).tracks;
    expect(kwicWire).toEqual([{ seriesId: g.id, group: authored }]);
    const passWire = (f.passages().filter((t) => !t.cancelled).at(-1)!.query as { request: { tracks: { seriesId: string; group: unknown }[] } }).request.tracks;
    expect(passWire).toEqual([{ seriesId: g.id, group: authored }]);
  });

  it('an identity-NEUTRAL member apply (same semantics) reissues nothing', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes');
    const g = groupsOf(f)[0]!;
    const issued = f.issued.length;
    f.store.getState().setGroupMembers(g.id, [...g.members], g.countOverlaps);
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
    f.store.setState({ notebook: { schema: 'texttrends/query-notebook/1', groups: [semanticEdit(g)] } });
    expect(trend.cancelled).toBe(false); // the lease is genuinely still alive
    expect(kwic.cancelled).toBe(false);
    trend.resolve({ op: 'trend', trend: fakeTrend(3) });
    kwic.resolve({ op: 'kwic', total: 1, rows: [] }); // rows empty: adoption alone is the probe
    await flush();
    expect(f.store.getState().trends.get(g.id)!.status).toBe('pending'); // never adopted
    expect(f.store.getState().kwic!.state.status).toBe('pending');
  });

  it('a SEMANTIC-ONLY stale settlement cannot commit — passage', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().quickAdd('holmes');
    const g = f.store.getState().notebook.groups[0]!;
    f.store.getState().setScrub({ doc: 'a', token: 5 });
    await flush();
    const passage = f.passages().filter((t) => !t.cancelled).at(-1)!;
    f.store.setState({ notebook: { schema: 'texttrends/query-notebook/1', groups: [semanticEdit(g)] } });
    expect(passage.cancelled).toBe(false);
    passage.resolve({ op: 'passage', passage: fakePassage(0, 10, 5) });
    await flush();
    expect(f.store.getState().passage).toBeNull(); // never adopted
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
    expect(f.store.getState().notebookError).toMatch(/code units/);
    expect(groupsOf(f)[0]!.members).toEqual(g.members);
    expect(f.issued.length).toBe(issued);
    f.store.getState().clearNotebookError();
    expect(f.store.getState().notebookError).toBeNull();
  });
});

describe('query notebook — active set, solo, order, and style', () => {
  const groupsOf = (f: ReturnType<typeof harness>) => f.store.getState().notebook.groups;

  it('mute drops the track globally (trend reissue without it) but PRESERVES the concordance toggle and style slot', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    const slotBefore = f.store.getState().styleSlots.get(moriarty!.id);
    f.store.getState().toggleKwicSeries(moriarty!.id); // concordance OFF
    f.store.getState().setGroupActive(moriarty!.id, false); // mute
    expect(f.store.getState().series.map((s) => s.id)).toEqual([holmes!.id]);
    const live = f.trends().filter((t) => !t.cancelled);
    expect(live.map((t) => t.groupId)).toEqual([holmes!.id]);
    f.store.getState().setGroupActive(moriarty!.id, true); // unmute
    expect(f.store.getState().kwicEnabledSeries.has(moriarty!.id)).toBe(false); // toggle survived the mute
    expect(f.store.getState().styleSlots.get(moriarty!.id)).toBe(slotBefore); // style identity survived
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

  it('reorder is a refused-unless-total permutation, preserves UUIDs/slots/focus, and reissues nothing', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    const slots = new Map(f.store.getState().styleSlots);
    const issued = f.issued.length;
    f.store.getState().reorderGroups([moriarty!.id]); // not total → refused
    expect(f.store.getState().notebookError).toMatch(/every group/);
    f.store.getState().reorderGroups([moriarty!.id, holmes!.id]);
    expect(groupsOf(f).map((g) => g.id)).toEqual([moriarty!.id, holmes!.id]);
    expect(f.store.getState().series.map((s) => s.id)).toEqual([moriarty!.id, holmes!.id]);
    expect(f.store.getState().styleSlots.get(holmes!.id)).toBe(slots.get(holmes!.id)); // slots pinned
    expect(f.store.getState().styleSlots.get(moriarty!.id)).toBe(slots.get(moriarty!.id));
    expect(f.issued.length).toBe(issued); // invariant 2: no reissue
  });

  it('removal cleans results, focus, concordance selection, solo, and style ownership', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().quickAdd('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    f.store.getState().setFocus(moriarty!.id);
    f.store.getState().setSolo(moriarty!.id);
    f.store.getState().removeGroup(moriarty!.id);
    const state = f.store.getState();
    expect(state.notebook.groups.map((g) => g.id)).toEqual([holmes!.id]);
    expect(state.focusedSeries).toBe(holmes!.id);
    expect(state.soloGroupId).toBeNull();
    expect(state.styleSlots.has(moriarty!.id)).toBe(false);
    expect(state.kwicEnabledSeries.has(moriarty!.id)).toBe(false);
    expect(state.activeGroupIds.has(moriarty!.id)).toBe(false);
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
      { id: moriarty!.members[0]!.id, kind: 'prefix', stem: 'mor', match: { case: 'folded', diacritics: 'folded' } },
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
