/**
 * UI state — zustand, per synthesis §8. Only handles, metadata, and bounded
 * results live here; corpus arrays and texts stay worker-side.
 *
 * Commit 7c (the atomic listener cutover, per the recorded 7c integration
 * ruling `claude_7c_consult`): this store is the SOLE React-facing projection.
 * It NO LONGER owns the generation event lane — the one `ProjectSession` owns
 * `onSnapshot`/`onProgress`/`onIngestError`/`onSourceReady`/`onRestart`/
 * `openGeneration`/`ingest`, and its type here (`QueryClient`) cannot even
 * express those listeners. The store SUBSCRIBES to the session's immutable
 * `SessionState` (stored whole in `projectSession`), mirrors `snapshot` +
 * analysis loading/error for the query flow, and exposes thin command wrappers
 * so components talk only to the store. Query/KWIC/passage stay here: they are
 * request/response operations, not competing listeners.
 *
 * Multi-series intent (owner feedback round 5, Codex-consulted design):
 * the input is a comma-separated comparison of up to MAX_SERIES terms. Each
 * becomes a SeriesIntent with a SEMANTIC id (the folded query surface under
 * the group's match mode) — never the raw display spelling — so 'Holmes' and
 * 'hólmes' are one series. Trend results key off SeriesIntent.id in an
 * immutably-replaced map; a missing entry is impossible to confuse with
 * pending or failed because every issued series is seeded 'pending'.
 *
 * Intent discipline (UI review round 1, extended): trend intent and KWIC
 * intent carry SEPARATE epochs. Changing the compared terms or the snapshot
 * cancels and reissues both; changing only the focused series cancels and
 * reissues ONLY the KWIC query — the trend lines are still correct and must
 * not flicker. A result is written only if its epoch AND its (generation,
 * snapshot) identity both still match, so a slow stale query can never
 * relabel itself.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  DEFAULT_INDEX_RECIPE,
  foldKey,
  PASSAGE_MAX_TOKENS,
  tokenKey,
  type DocumentMetaV1,
  type NumericTrend,
  type PassageResult,
  type TermGroupSpec,
} from '@texttrends/core';
import type { SnapshotInfo } from './client.ts';
import type { QueryOpV4, QueryResultDataV4, StructureQueryResultV1 } from '../worker/protocol-v4.ts';
import { BUILTIN_SHERLOCK_ID, buildBuiltinProjectData, type ProjectDataV1 } from './project.ts';
import {
  SessionCommandError,
  type AnalysisPhase,
  type FileLike,
  type SessionState,
} from './project-session.ts';

/** Manifest with the exact staged LF byte lengths and FULL content hashes —
 *  a 200-with-HTML-shell response must never be indexed as a book, and a
 *  fixture compares every entry against the shipped assets (round 2: the
 *  first manifest carried pre-normalization CRLF sizes and rejected all six).
 *
 *  `sourceHash` (SHA-256 of the exact bytes) and `textHash` (hashText of the
 *  decoded text) are DISTINCT identities (§12.4): for these UTF-8 files with no
 *  ill-formed sequences the two values coincide, and the fixture asserts each
 *  independently plus the coincidence — but the two fields carry different
 *  meanings so a future BOM/1252/transform file can diverge without a data-model
 *  change, and a TextHash can never be routed into a source/extraction key. The
 *  hashes are the authoritative warm-reopen identities the worker rehydrates
 *  against; a mutable doc-label → hash cache must never outrank this manifest. */
export const SHERLOCK: readonly { doc: string; bytes: number; textLengthUtf16: number; sourceHash: string; textHash: string }[] = [
  { doc: '1 - A Study in Scarlet - Arthur Conan Doyle', bytes: 244251, textLengthUtf16: 239435, sourceHash: 'dfee04ef99ffe3d02e5fa014180cdd37a73ae993d7f07fe097692e4d3637837d', textHash: 'dfee04ef99ffe3d02e5fa014180cdd37a73ae993d7f07fe097692e4d3637837d' },
  { doc: '2 - The Sign of the Four - Arthur Conan Doyle', bytes: 236849, textLengthUtf16: 232130, sourceHash: '81c87d8455b08a0e2e9bb9eadb98bda3789431045d307d831d0e74fd978bcf5d', textHash: '81c87d8455b08a0e2e9bb9eadb98bda3789431045d307d831d0e74fd978bcf5d' },
  { doc: '3 - The Adventures of Sherlock Holmes - Arthur Conan Doyle', bytes: 575804, textLengthUtf16: 562213, sourceHash: '3552d466d95a92fb58e96bbfabbfc02370d359ac95933b5feafe4ebaf3f243b3', textHash: '3552d466d95a92fb58e96bbfabbfc02370d359ac95933b5feafe4ebaf3f243b3' },
  { doc: '4 - The Memoirs of Sherlock Holmes - Arthur Conan Doyle', bytes: 581689, textLengthUtf16: 569564, sourceHash: '9ee3b066f7d761abc5e012510cb1d4e636254976c655494a721537d695647b1d', textHash: '9ee3b066f7d761abc5e012510cb1d4e636254976c655494a721537d695647b1d' },
  { doc: '5 - The Hound of the Baskervilles - Arthur Conan Doyle', bytes: 360865, textLengthUtf16: 354130, sourceHash: '6f2bd20772b2958e7b6683f3e790f12d58f5c6506cbf38743dfd36318ef8262e', textHash: '6f2bd20772b2958e7b6683f3e790f12d58f5c6506cbf38743dfd36318ef8262e' },
  { doc: '6 - The Return of Sherlock Holmes - Arthur Conan Doyle', bytes: 686382, textLengthUtf16: 673685, sourceHash: '190bdeb3e25d6553c3b6d6a3ec7fb677919ba336a1feb7dd0affb06b1c9a4c57', textHash: '190bdeb3e25d6553c3b6d6a3ec7fb677919ba336a1feb7dd0affb06b1c9a4c57' },
];

/** The bundled corpus as the built-in `ProjectDataV1`, built ONCE (the recipe
 *  and empty-candidate hashes are corpus-wide constants). One project
 *  abstraction drives every origin; Sherlock is simply the read-only built-in.
 *  The composition root (`store-instance.ts`) awaits this to construct the
 *  session's initial `CurrentProject`. */
let sherlockData: Promise<ProjectDataV1> | null = null;
export function sherlockProjectData(): Promise<ProjectDataV1> {
  sherlockData ??= buildBuiltinProjectData(
    BUILTIN_SHERLOCK_ID,
    SHERLOCK.map(({ doc, bytes, textLengthUtf16, sourceHash, textHash }) => ({ doc, title: doc, bytes, textLengthUtf16, sourceHash, textHash })),
  );
  return sherlockData;
}

export interface KwicRowView {
  readonly doc: string;
  readonly pos: number;
  readonly left: string;
  readonly nodeText: string;
  readonly right: string;
}

/** The narrow request/response surface the store consumes — the store can hold
 *  a `WorkerClient` only through this seam, so it can NEVER reclaim a last-wins
 *  generation-lane listener the session exclusively owns. Injectable as a fake
 *  for query-intent fixtures. */
export interface QueryClient {
  query(
    snapshot: string,
    query: QueryOpV4,
  ): { result: Promise<QueryResultDataV4>; cancel: () => void };
}

export const MAX_SERIES = 5;
export const BINS = 40;

const MATCH = { case: 'folded' as const, diacritics: 'folded' as const };
const LOCALE = 'en';

/** (generation, snapshot) identity — a query result is written only if the live
 *  snapshot still matches this. Snapshot ids are unique per publication; the
 *  extra generation fence is cheap and matches the session contract. */
const snapKey = (s: SnapshotInfo | null): string | null =>
  s ? JSON.stringify([s.generation, s.snapshot]) : null;

export interface SeriesIntent {
  /** Semantic identity: the folded query surface — not the display spelling. */
  readonly id: string;
  /** The first-seen user spelling, preserved for display. */
  readonly label: string;
  /** Fixed visual slot (color + dash) — stable for the life of the intent. */
  readonly styleSlot: number;
}

export type SeriesTrendState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly trend: NumericTrend }
  | { readonly status: 'error'; readonly message: string };

export interface KwicState {
  readonly seriesId: string;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly total: number; readonly rows: readonly KwicRowView[] }
    | { readonly status: 'error'; readonly message: string };
}

/** The focused document's chapter outline (commit 8a, read-only preview). A
 *  request/response query like KWIC — epoch- and (generation,snapshot,doc)-
 *  guarded — but issued INDEPENDENTLY of the term series so the outline works
 *  with an empty term input. `doc` names the request so a component never
 *  pairs rows with a different focus. A doc with no chapters resolves 'ready'
 *  with only the root row; a real query failure is 'error'. */
export interface StructureState {
  readonly doc: string;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly result: StructureQueryResultV1 }
    | { readonly status: 'error'; readonly message: string };
}

export type TrendView = 'series' | 'by-book';

/** The scrubbed reading position — document-local, view-independent. */
export interface ScrubTarget {
  readonly doc: string;
  readonly token: number;
}

/** Tokens of headroom the loaded block must keep around the target before a
 *  refetch is scheduled — inside the band, scrubbing is purely local. */
export const SCRUB_GUARD_TOKENS = 28;

/** Bootstrap lifecycle, distinct from analysis state: the store is exported
 *  synchronously but the session needs the async-built built-in project, so
 *  there is a window before the one-shot attachment where no session exists.
 *  A construction/hashing failure here is NOT an analysis-generation failure. */
export type BootstrapState =
  | { readonly phase: 'initializing' }
  | { readonly phase: 'attached' }
  | { readonly phase: 'error'; readonly message: string };

/** Descriptive metadata a component may patch (title/author/year/tags). */
export type MetaPatch = Partial<Pick<DocumentMetaV1, 'title' | 'author' | 'year' | 'tags'>>;

/** The exact public session surface the store drives — the seam the composition
 *  root attaches and a fixture fakes. The concrete `ProjectSession` satisfies it
 *  structurally; keeping it an interface lets the store tests drive a spyable
 *  state emitter without the real generation lifecycle (whose races are covered
 *  in the session's own suite). */
export interface SessionPort {
  getState(): SessionState;
  subscribe(listener: (state: SessionState) => void): () => void;
  dispose(): void;
  start(): void;
  createUserProject(files: readonly FileLike[], opts?: { persist?: boolean }): void;
  appendFiles(files: readonly FileLike[], opts?: { persist?: boolean }): void;
  removeImport(doc: string): void;
  editMeta(doc: string, patch: MetaPatch): void;
  setLanguage(doc: string, language: string): void;
  reorder(order: readonly string[]): void;
  save(): void;
  setPersistIntent(doc: string, intent: boolean): void;
  reattach(doc: string, file: FileLike): void;
  loadUserProject(): void;
}

/** Comma-separated comparison → ordered semantic series (first spelling wins).
 *  More than MAX_SERIES distinct series is an explicit refusal, not a silent
 *  truncation. Exported for fixtures. */
export function parseSeries(input: string):
  | { readonly series: readonly SeriesIntent[]; readonly error: null }
  | { readonly series: null; readonly error: string } {
  const series: SeriesIntent[] = [];
  for (const raw of input.split(',')) {
    const label = raw.trim();
    if (label === '') continue;
    // Same normalization chain the worker's resolver applies — the semantic
    // id must equal what the query will actually match on.
    const id = foldKey(tokenKey(label, DEFAULT_INDEX_RECIPE), MATCH, LOCALE);
    if (series.some((s) => s.id === id)) continue;
    series.push({ id, label, styleSlot: series.length });
  }
  if (series.length > MAX_SERIES) {
    return { series: null, error: `Compare up to ${MAX_SERIES} terms` };
  }
  return { series, error: null };
}

export interface AppState {
  /** Composition-root lifecycle before/after the one-shot session attach. */
  bootstrap: BootstrapState;
  /** The whole immutable session view (File-free, serializable). Components
   *  select narrow nested values so unrelated publications don't redraw all. */
  projectSession: SessionState | null;
  snapshot: SnapshotInfo | null;
  loadingPhase: string | null;
  loadError: string | null;
  /** One bounded UI error from a synchronous `SessionCommandError` (an illegal
   *  command the UI should have prevented). Async policy failures stay in
   *  `projectSession` (save/sources/reattach). */
  commandError: string | null;
  /** Raw committed input (the draft lives in the form component). */
  input: string;
  series: readonly SeriesIntent[];
  inputError: string | null;
  focusedSeries: string | null;
  /** Seeded 'pending' per issued series — panels must not show stale arrays. */
  trends: ReadonlyMap<string, SeriesTrendState>;
  kwic: KwicState | null;
  trendView: TrendView;
  /** The document whose chapter outline is previewed and whose top-level
   *  boundaries the chart may mark. A real presentation intent (NOT the scrub
   *  doc or focused series): defaults to the first ready doc in declared
   *  project order and is preserved while it stays ready. */
  focusedDoc: string | null;
  /** The focused doc's outline query result (independent of the term series). */
  structure: StructureState | null;
  /** Opt-in: draw the focused doc's top-level chapter boundaries on the chart. */
  sectionMarks: boolean;
  scrub: ScrubTarget | null;
  /** The loaded passage block — may lag the scrub target while a fetch is in
   *  flight; the panel renders the block that CONTAINS the target only. */
  passage: PassageResult | null;

  // ── Query/presentation intent (owned here). ──
  setInput(input: string): void;
  setFocus(seriesId: string): void;
  setTrendView(view: TrendView): void;
  setFocusedDoc(doc: string): void;
  setSectionMarks(on: boolean): void;
  setScrub(target: ScrubTarget): void;
  clearScrub(): void;
  runQueries(): void;
  /** (Re)issue the focused doc's outline query. Called on snapshot change and
   *  when the focused doc changes; independent of the term-series flow. */
  runStructure(): void;

  // ── Session command wrappers (forward to the one attached session). ──
  /** Import files: create a user project from the built-in origin, or append
   *  to the current user project. */
  importFiles(files: readonly FileLike[], opts?: { persist?: boolean }): void;
  removeImport(doc: string): void;
  editMeta(doc: string, patch: MetaPatch): void;
  setLanguage(doc: string, language: string): void;
  reorder(order: readonly string[]): void;
  setPersistIntent(doc: string, intent: boolean): void;
  saveProject(): void;
  loadSavedProject(): void;
  reattach(doc: string, file: FileLike): void;
  /** Reopen analysis on the SAME lifetime session (post-error retry). */
  retryAnalysis(): void;
  clearCommandError(): void;
}

/** The synchronously-constructed runtime: the React-facing store plus the
 *  private one-shot session bridge the composition root drives. Components
 *  receive only `useApp`; `attachSession`/`failBootstrap`/`dispose` are for
 *  `store-instance.ts` and tests, never for React. */
export interface AppRuntime {
  useApp: UseBoundStore<StoreApi<AppState>>;
  /** Subscribe the store to the session and seed current state, exactly once.
   *  A second (different) attachment is a programming error and throws. Call
   *  BEFORE `session.start()` so the first publication is observed. */
  attachSession(session: SessionPort): void;
  /** Report an async bootstrap (built-in construction/hashing) failure. */
  failBootstrap(error: unknown): void;
  /** Fence the bridge and dispose the session. */
  dispose(): void;
}

/** Loading detail for the header while analysis runs; null otherwise (an error
 *  surfaces through `loadError`, readiness through the snapshot). */
function describeAnalysis(analysis: AnalysisPhase): string | null {
  return analysis.phase === 'loading' ? analysis.detail : null;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The focused doc for the incoming session state: preserve the current focus
 *  while it remains a ready member of the snapshot, otherwise pick the first
 *  ready doc in DECLARED project order (never analysis-completion order). Null
 *  when there is no snapshot. */
function resolveFocusedDoc(prev: string | null, next: SessionState): string | null {
  const snapshot = next.snapshot;
  if (!snapshot) return null;
  const ready = new Set(snapshot.readyDocs);
  if (prev !== null && ready.has(prev)) return prev;
  for (const doc of next.project.data.order) if (ready.has(doc)) return doc;
  return snapshot.readyDocs[0] ?? null;
}

export function createAppRuntime(client: QueryClient): AppRuntime {
  let trendEpoch = 0;
  let kwicEpoch = 0;
  let trendCancels: (() => void)[] = [];
  let kwicCancel: (() => void) | null = null;
  // Scrub scheduling: ONE active passage request plus ONE replaceable pending
  // target — pointer motion never queues and never cancel-storms the worker.
  let scrubEpoch = 0;
  let passageActiveCancel: (() => void) | null = null;
  let passagePending: ScrubTarget | null = null;
  // Outline query intent — a separate epoch/cancel from the term series so the
  // preview survives an empty term input and a focus change reissues only it.
  let structureEpoch = 0;
  let structureCancel: (() => void) | null = null;

  // The one attached session (retained in the closure, never in Zustand state —
  // it holds Files, promises, and cancel handles). Null until the composition
  // root attaches it.
  let session: SessionPort | null = null;
  let unsubscribe: (() => void) | null = null;
  let attached = false;

  const store = create<AppState>((set, get) => {
    /** Group/member ids derive from the series' semantic id — evidence
     *  provenance must distinguish the compared groups. */
    const groupFor = (s: SeriesIntent): TermGroupSpec => ({
      id: `g:${s.id}`,
      members: [{ id: `m:${s.id}`, kind: 'token', surface: s.label, match: MATCH }],
      countOverlaps: false,
    });

    /** The doc's token extent, if any ready trend result carries it. */
    const docTokenCountOf = (doc: string): number | null => {
      for (const [, state] of get().trends) {
        if (state.status !== 'ready') continue;
        const d = state.trend.order.indexOf(doc);
        if (d >= 0) return state.trend.docTokenCount[d] ?? null;
      }
      return null;
    };

    /** Would a fetch centered at `token` produce the block we already hold? */
    const blockServes = (passage: PassageResult, target: ScrubTarget): boolean => {
      if (passage.doc !== target.doc) return false;
      const { start, end } = passage.tokens;
      if (target.token < start || target.token >= end) return false;
      const tc = docTokenCountOf(target.doc);
      if (tc !== null && !passage.truncatedByCharCap) {
        // Exact: the block a refetch would serve (same construction as the
        // kernel) — identical block means the fetch is pure waste.
        const es = Math.max(0, Math.min(target.token - (PASSAGE_MAX_TOKENS >> 1), tc - PASSAGE_MAX_TOKENS));
        const ee = Math.min(tc, es + PASSAGE_MAX_TOKENS);
        if (es === start && ee === end) return true;
      }
      // Guard band: local navigation until the target nears a block edge.
      const lo = start === 0 ? start : start + SCRUB_GUARD_TOKENS;
      const hi = end - SCRUB_GUARD_TOKENS;
      return target.token >= lo && target.token < hi;
    };

    const pumpPassage = () => {
      if (passageActiveCancel !== null) return; // active request finishes first
      const target = passagePending;
      if (!target) return;
      passagePending = null;
      const { snapshot, series } = get();
      if (!snapshot || series.length === 0) return;
      const issuedEpoch = scrubEpoch;
      const issuedKey = snapKey(snapshot);
      const handle = client.query(snapshot.snapshot, {
        op: 'passage',
        request: {
          doc: target.doc,
          centerToken: target.token,
          maxTokens: PASSAGE_MAX_TOKENS,
          tracks: series.map((s) => ({ seriesId: s.id, group: groupFor(s) })),
        },
      });
      passageActiveCancel = handle.cancel;
      const current = () =>
        scrubEpoch === issuedEpoch && snapKey(get().snapshot) === issuedKey;
      /** Only the CURRENT owner of the active slot may clear it and pump —
       *  a structurally superseded request's late settlement must not free
       *  the slot out from under its replacement. */
      const settleOwnership = () => {
        if (passageActiveCancel !== handle.cancel) return false;
        passageActiveCancel = null;
        return true;
      };
      void handle.result
        .then((data) => {
          if (!settleOwnership()) return;
          if (data.op === 'passage' && current()) set({ passage: data.passage });
          pumpPassage(); // a newer target may be parked in the pending slot
        })
        .catch((e: unknown) => {
          if (!settleOwnership()) return;
          const message = e instanceof Error ? e.message : String(e);
          if (message !== 'cancelled' && current()) {
            // A rejected center (stale geometry) or failed read: drop the
            // scrub rather than display a block that does not match it.
            set({ passage: null, scrub: null });
            passagePending = null;
            return;
          }
          pumpPassage();
        });
    };

    const runKwic = () => {
      kwicCancel?.();
      kwicCancel = null;
      const myEpoch = ++kwicEpoch;
      const { snapshot, series, focusedSeries } = get();
      // focusedSeries is canonical: setInput/setFocus maintain the invariant
      // that it names a live series whenever any series exist.
      const focused = series.find((s) => s.id === focusedSeries);
      if (!snapshot || !focused) {
        set({ kwic: null });
        return;
      }
      const issuedKey = snapKey(snapshot);
      set({ kwic: { seriesId: focused.id, state: { status: 'pending' } } });
      const handle = client.query(snapshot.snapshot, {
        op: 'kwic',
        selection: { docs: [...snapshot.readyDocs] },
        group: groupFor(focused),
        request: {
          contextTokens: 6,
          sort: [{ at: 'doc', dir: 1 }, { at: 'pos', dir: 1 }],
          page: { offset: 0, limit: 50 },
        },
      });
      kwicCancel = handle.cancel;
      const current = () =>
        kwicEpoch === myEpoch && snapKey(get().snapshot) === issuedKey;
      void handle.result
        .then((data) => {
          if (data.op === 'kwic' && current()) {
            set({
              kwic: {
                seriesId: focused.id,
                state: { status: 'ready', total: data.total, rows: data.rows },
              },
            });
          }
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          if (message === 'cancelled' || !current()) return; // superseded — the newer epoch owns the panel
          set({ kwic: { seriesId: focused.id, state: { status: 'error', message } } });
        });
    };

    /** Guard a synchronous session command: forward to the attached session,
     *  translating an illegal-command `SessionCommandError` into one bounded UI
     *  error. Async policy failures live in the session state, not here. */
    const command = (run: (s: SessionPort) => void) => {
      if (!session) {
        set({ commandError: 'the project is still initializing' });
        return;
      }
      try {
        run(session);
      } catch (e) {
        if (e instanceof SessionCommandError) {
          set({ commandError: e.message });
          return;
        }
        throw e;
      }
    };

    const initialSeries = parseSeries('Holmes, Moriarty').series ?? [];
    return {
      bootstrap: { phase: 'initializing' },
      projectSession: null,
      snapshot: null,
      loadingPhase: null,
      loadError: null,
      commandError: null,
      input: 'Holmes, Moriarty',
      series: initialSeries,
      inputError: null,
      // Canonical from the start: the store, not the panels, decides the
      // default focus (review round 5 — a derived fallback left the pressed
      // chip and the recorded focus disagreeing).
      focusedSeries: initialSeries[0]?.id ?? null,
      trends: new Map(),
      kwic: null,
      trendView: 'series',
      focusedDoc: null,
      structure: null,
      sectionMarks: false,
      scrub: null,
      passage: null,

      setInput(input) {
        const parsed = parseSeries(input);
        if (parsed.error !== null) {
          // Refused intent still supersedes the old one: cancel and clear so
          // stale lines are never displayed beside the error.
          set({ input, inputError: parsed.error, series: [], focusedSeries: null });
        } else {
          const { focusedSeries } = get();
          const stillFocused = parsed.series.some((s) => s.id === focusedSeries);
          set({
            input,
            inputError: null,
            series: parsed.series,
            // Surviving focus is preserved even if its position changed;
            // otherwise the first series becomes the actual (not implied) focus.
            focusedSeries: stillFocused ? focusedSeries : parsed.series[0]?.id ?? null,
          });
        }
        get().runQueries();
      },

      setFocus(seriesId) {
        if (get().focusedSeries === seriesId) return;
        if (!get().series.some((s) => s.id === seriesId)) return;
        set({ focusedSeries: seriesId });
        runKwic(); // KWIC intent only — trend lines are still correct
      },

      setTrendView(view) {
        set({ trendView: view }); // presentation-only: no query is reissued
      },

      setFocusedDoc(doc) {
        if (get().focusedDoc === doc) return;
        if (!get().snapshot?.readyDocs.includes(doc)) return; // only a ready doc
        set({ focusedDoc: doc });
        get().runStructure(); // outline intent only — trend lines are unaffected
      },

      setSectionMarks(on) {
        set({ sectionMarks: on }); // presentation-only
      },

      setScrub(target) {
        const prev = get().scrub;
        if (prev && prev.doc === target.doc && prev.token === target.token) return;
        set({ scrub: target });
        const { passage } = get();
        if (passage && blockServes(passage, target)) return; // purely local move
        passagePending = target; // replaceable slot — motion never queues
        pumpPassage();
      },

      clearScrub() {
        // Presentational hide only — the loaded block stays as a warm cache
        // for the next scrub; pending work is dropped.
        passagePending = null;
        set({ scrub: null });
      },

      runQueries() {
        const { snapshot, series } = get();
        // Trend intent changed: ALWAYS cancel superseded work, clear to
        // pending, and invalidate the epoch — even when the new intent runs
        // no query (round 2: a blank input must not relabel old evidence).
        for (const cancel of trendCancels) cancel();
        trendCancels = [];
        const myEpoch = ++trendEpoch;
        // The loaded passage block and any in-flight/pending fetch belong to
        // the OLD series set / snapshot — marks would be stale evidence. The
        // scrub POSITION is kept; a fresh block is fetched below if possible.
        scrubEpoch++;
        passageActiveCancel?.();
        passageActiveCancel = null;
        passagePending = null;
        set({ passage: null });
        if (!snapshot || series.length === 0) {
          set({ trends: new Map(), scrub: null });
          runKwic(); // clears or re-targets the evidence panel consistently
          return;
        }
        const scrub = get().scrub;
        if (scrub) {
          passagePending = scrub;
          pumpPassage();
        }

        const issuedSnapshot = snapshot.snapshot;
        const issuedKey = snapKey(snapshot);
        set({
          trends: new Map(series.map((s) => [s.id, { status: 'pending' } as const])),
        });
        const current = () =>
          trendEpoch === myEpoch && snapKey(get().snapshot) === issuedKey;

        for (const s of series) {
          const handle = client.query(issuedSnapshot, {
            op: 'trend',
            selection: { docs: [...snapshot.readyDocs] },
            group: groupFor(s),
            request: { coordinate: 'declared-sequence', binsPerDoc: BINS },
          });
          trendCancels.push(handle.cancel);
          const write = (state: SeriesTrendState) =>
            set((prev) => {
              const next = new Map(prev.trends); // NEVER mutate the resident map
              next.set(s.id, state);
              return { trends: next };
            });
          void handle.result
            .then((data) => {
              if (data.op === 'trend' && current()) write({ status: 'ready', trend: data.trend });
            })
            .catch((e: unknown) => {
              const message = e instanceof Error ? e.message : String(e);
              if (message === 'cancelled' || !current()) return;
              // A genuine failure must mark ITS series, not silently vanish
              // — and must not erase successful peers.
              write({ status: 'error', message });
            });
        }

        runKwic();
      },

      runStructure() {
        structureCancel?.();
        structureCancel = null;
        const myEpoch = ++structureEpoch;
        const { snapshot, focusedDoc } = get();
        if (!snapshot || !focusedDoc || !snapshot.readyDocs.includes(focusedDoc)) {
          set({ structure: null });
          return;
        }
        const issuedKey = snapKey(snapshot);
        const issuedDoc = focusedDoc;
        set({ structure: { doc: focusedDoc, state: { status: 'pending' } } });
        const handle = client.query(snapshot.snapshot, { op: 'structure', request: { doc: focusedDoc } });
        structureCancel = handle.cancel;
        // (generation, snapshot, doc): a slow result for a superseded focus or
        // snapshot must never relabel the current outline.
        const current = () =>
          structureEpoch === myEpoch &&
          snapKey(get().snapshot) === issuedKey &&
          get().focusedDoc === issuedDoc;
        void handle.result
          .then((data) => {
            if (data.op === 'structure' && current()) {
              set({ structure: { doc: issuedDoc, state: { status: 'ready', result: data.structure } } });
            }
          })
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            if (message === 'cancelled' || !current()) return;
            set({ structure: { doc: issuedDoc, state: { status: 'error', message } } });
          });
      },

      // ── Session command wrappers ──────────────────────────────────────────
      importFiles(files, opts) {
        command((s) => {
          if (s.getState().project.kind === 'builtin') s.createUserProject(files, opts);
          else s.appendFiles(files, opts);
        });
      },
      removeImport(doc) {
        command((s) => s.removeImport(doc));
      },
      editMeta(doc, patch) {
        command((s) => s.editMeta(doc, patch));
      },
      setLanguage(doc, language) {
        command((s) => s.setLanguage(doc, language));
      },
      reorder(order) {
        command((s) => s.reorder(order));
      },
      setPersistIntent(doc, intent) {
        command((s) => s.setPersistIntent(doc, intent));
      },
      saveProject() {
        command((s) => s.save());
      },
      loadSavedProject() {
        command((s) => s.loadUserProject());
      },
      reattach(doc, file) {
        command((s) => s.reattach(doc, file));
      },
      retryAnalysis() {
        command((s) => s.start());
      },
      clearCommandError() {
        set({ commandError: null });
      },
    };
  });

  /** One-way bridge: mirror the session view for the query flow and reissue
   *  queries ONLY when the (generation, snapshot) identity changes (including a
   *  transition to null). It must never issue a session command in response to
   *  a publication — commands originate from bootstrap or UI actions. */
  const acceptSessionState = (next: SessionState) => {
    const prevKey = snapKey(store.getState().snapshot);
    const nextKey = snapKey(next.snapshot);
    // Resolve the focused doc against the incoming snapshot: keep the current
    // one while it stays ready, else the first ready doc in declared order.
    // Snapshot ids are unique per publication, so an unchanged key means the
    // ready set (and thus the focus) is stable — the outline never churns on an
    // unrelated (sources/save) publication.
    const focusedDoc = resolveFocusedDoc(store.getState().focusedDoc, next);
    store.setState({
      bootstrap: { phase: 'attached' },
      projectSession: next,
      snapshot: next.snapshot,
      loadingPhase: describeAnalysis(next.analysis),
      loadError: next.analysis.phase === 'error' ? next.analysis.message : null,
      focusedDoc,
    });
    if (prevKey !== nextKey) {
      store.getState().runQueries();
      store.getState().runStructure();
    }
  };

  return {
    useApp: store,
    attachSession(next: SessionPort) {
      if (attached) {
        if (next === session) return;
        throw new Error('a session is already attached; one session lives per app lifetime');
      }
      attached = true;
      session = next;
      // Subscribe first, then seed from the current state (subscribe does not
      // replay). Ordering matches the ruling: subscribe → seed → start (start
      // is the caller's, after this returns).
      unsubscribe = next.subscribe(acceptSessionState);
      acceptSessionState(next.getState());
    },
    failBootstrap(error: unknown) {
      store.setState({ bootstrap: { phase: 'error', message: msg(error) } });
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
      session?.dispose();
      session = null;
    },
  };
}
