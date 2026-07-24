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
 * becomes a SeriesIntent with a stable PRESENTATION id — the NFC-normalized
 * display label, deduped only against exact repeats. It is deliberately
 * locale-INDEPENDENT: whether two surfaces match identically is a per-document
 * property (folding is resolved under each shard's locale in the worker), so
 * the store must not guess a corpus locale to collapse them — a fixed `en`
 * fold wrongly unified `I`/`İ`, which resolve differently in Turkish. Matching
 * stays document-local; series identity is purely for labelling/colour/dedup.
 * Trend results key off SeriesIntent.id in an immutably-replaced map; a missing
 * entry is impossible to confuse with pending or failed because every issued
 * series is seeded 'pending'.
 *
 * Intent discipline (UI review round 1, extended): trend intent and KWIC
 * intent are SEPARATE latest-wins lanes (operation leases over one runtime
 * scope). Changing the compared terms or the snapshot cancels and reissues
 * both. The concordance is a MERGED multi-term view (kwic/2, concordance
 * amendment): it is INDEPENDENT of `focusedSeries` (which only emphasizes
 * trend lines), and is reissued by a per-term toggle, by a settled scrub
 * re-centre (debounced), and by a term/snapshot change. A result is written
 * only while its lease holds — latest in its lane, scope alive, AND the
 * captured (generation, snapshot) identity guard — so a slow stale query can
 * never relabel itself, even after disposal.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  MAX_KWIC_TRACKS,
  PASSAGE_MAX_TOKENS,
  type DocumentMetaV1,
  type NumericTrend,
  type PassageResult,
  type StructureOverrideV1,
  type TermGroupSpec,
} from '@texttrends/core';
import { isCancelled } from './client.ts';
import type { SnapshotInfo } from './client.ts';
import { LatestOperation, OperationScope, type OperationLease } from './operation-lease.ts';
import type {
  LineExcerptResultV1,
  QueryOpV4,
  QueryResultDataV4,
  StructureEditContextV1,
  StructureQueryResultV1,
} from '../worker/protocol-v4.ts';
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
export const SHERLOCK: readonly { doc: string; title: string; bytes: number; textLengthUtf16: number; sourceHash: string; textHash: string }[] = [
  { doc: '1 - A Study in Scarlet - Arthur Conan Doyle', title: 'A Study in Scarlet', bytes: 244251, textLengthUtf16: 239435, sourceHash: 'dfee04ef99ffe3d02e5fa014180cdd37a73ae993d7f07fe097692e4d3637837d', textHash: 'dfee04ef99ffe3d02e5fa014180cdd37a73ae993d7f07fe097692e4d3637837d' },
  { doc: '2 - The Sign of the Four - Arthur Conan Doyle', title: 'The Sign of the Four', bytes: 236849, textLengthUtf16: 232130, sourceHash: '81c87d8455b08a0e2e9bb9eadb98bda3789431045d307d831d0e74fd978bcf5d', textHash: '81c87d8455b08a0e2e9bb9eadb98bda3789431045d307d831d0e74fd978bcf5d' },
  { doc: '3 - The Adventures of Sherlock Holmes - Arthur Conan Doyle', title: 'The Adventures of Sherlock Holmes', bytes: 575804, textLengthUtf16: 562213, sourceHash: '3552d466d95a92fb58e96bbfabbfc02370d359ac95933b5feafe4ebaf3f243b3', textHash: '3552d466d95a92fb58e96bbfabbfc02370d359ac95933b5feafe4ebaf3f243b3' },
  { doc: '4 - The Memoirs of Sherlock Holmes - Arthur Conan Doyle', title: 'The Memoirs of Sherlock Holmes', bytes: 581689, textLengthUtf16: 569564, sourceHash: '9ee3b066f7d761abc5e012510cb1d4e636254976c655494a721537d695647b1d', textHash: '9ee3b066f7d761abc5e012510cb1d4e636254976c655494a721537d695647b1d' },
  { doc: '5 - The Hound of the Baskervilles - Arthur Conan Doyle', title: 'The Hound of the Baskervilles', bytes: 360865, textLengthUtf16: 354130, sourceHash: '6f2bd20772b2958e7b6683f3e790f12d58f5c6506cbf38743dfd36318ef8262e', textHash: '6f2bd20772b2958e7b6683f3e790f12d58f5c6506cbf38743dfd36318ef8262e' },
  { doc: '6 - The Return of Sherlock Holmes - Arthur Conan Doyle', title: 'The Return of Sherlock Holmes', bytes: 686382, textLengthUtf16: 673685, sourceHash: '190bdeb3e25d6553c3b6d6a3ec7fb677919ba336a1feb7dd0affb06b1c9a4c57', textHash: '190bdeb3e25d6553c3b6d6a3ec7fb677919ba336a1feb7dd0affb06b1c9a4c57' },
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
    SHERLOCK.map(({ doc, title, bytes, textLengthUtf16, sourceHash, textHash }) => ({ doc, title, bytes, textLengthUtf16, sourceHash, textHash })),
  );
  return sherlockData;
}

export interface KwicRowView {
  /** The series (track) that produced this row — the merged concordance tags
   *  each occurrence so the panel can colour and label it. */
  readonly seriesId: string;
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

/** The max compared/concordance terms — one authority, shared with the kwic
 *  track cap so a series set can always be sent as concordance tracks. */
export const MAX_SERIES = MAX_KWIC_TRACKS;
export const BINS = 40;

const MATCH = { case: 'folded' as const, diacritics: 'folded' as const };

/** (generation, snapshot) identity — a query result is written only if the live
 *  snapshot still matches this. Snapshot ids are unique per publication; the
 *  extra generation fence is cheap and matches the session contract. */
const snapKey = (s: SnapshotInfo | null): string | null =>
  s ? JSON.stringify([s.generation, s.snapshot]) : null;

export interface SeriesIntent {
  /** Stable PRESENTATION identity: the NFC-normalized label (no locale/case/
   *  diacritic fold) — a display/colour/dedup key, NOT a semantic match key. */
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

/** The merged concordance for the ENABLED terms, ordered by proximity to the
 *  served `center` (null = reading order). The center is carried so the panel's
 *  caption describes the result that actually landed, not the live cursor. */
export interface KwicState {
  readonly center: ScrubTarget | null;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly total: number; readonly rows: readonly KwicRowView[] }
    | { readonly status: 'error'; readonly message: string }
    | { readonly status: 'no-terms' }; // no concordance terms enabled
}

/** How long the axis position must settle before the concordance re-centers,
 *  so pointer motion never issues a query per frame (fake-clock tested). */
export const KWIC_CENTER_DEBOUNCE_MS = 150;

/** The focused document's chapter outline (commit 8a, read-only preview). A
 *  request/response query like KWIC — lease-guarded on (generation,snapshot,
 *  doc) — but issued INDEPENDENTLY of the term series so the outline works
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

/** On-demand authoring context for a doc (commit 8b): the DETECTED baseline +
 *  base identities the correction editor (8c) diffs against. Fetched when the
 *  editor opens, lease-guarded on (generation,snapshot,doc), cleared on a
 *  snapshot change. */
export interface EditContextState {
  readonly doc: string;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly context: StructureEditContextV1 }
    | { readonly status: 'error'; readonly message: string };
}

/** On-demand bounded source line around a section anchor (commit 8b). Keyed by
 *  doc + anchor so a stale result for a prior anchor cannot relabel. */
export interface LineExcerptState {
  readonly doc: string;
  readonly anchor: number;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly excerpt: LineExcerptResultV1 }
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
  setStructureOverride(doc: string, override: StructureOverrideV1 | null): void;
  reorder(order: readonly string[]): void;
  save(): void;
  setPersistIntent(doc: string, intent: boolean): void;
  reattach(doc: string, file: FileLike): void;
  loadUserProject(): void;
}

/** Comma-separated comparison → ordered PRESENTATION series (first spelling of
 *  an NFC-equivalent repeat wins). Identity is the NFC-normalized label — a
 *  stable, locale-independent presentation id, NOT a semantic match key — so
 *  distinct spellings stay distinct tracks (matching equivalence is resolved
 *  per-document in the worker). More than MAX_SERIES distinct series is an
 *  explicit refusal, not a silent truncation. Exported for fixtures. */
export function parseSeries(input: string):
  | { readonly series: readonly SeriesIntent[]; readonly error: null }
  | { readonly series: null; readonly error: string } {
  const series: SeriesIntent[] = [];
  for (const raw of input.split(',')) {
    const label = raw.trim();
    if (label === '') continue;
    // Stable, locale-independent PRESENTATION id: the NFC-normalized label,
    // deduped only against exact-after-NFC repeats (canonically equivalent raw
    // spellings share an id). Whether two DISTINCT spellings match identically
    // is per-document (folded under each shard's locale in the worker), so the
    // store never guesses a locale to collapse them.
    const id = label.normalize('NFC');
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
  /** Which series appear in the merged concordance — ALL on by default, toggled
   *  per term, INDEPENDENT of `focusedSeries`. Preserved across an input edit for
   *  surviving series (by presentation id). */
  kwicEnabledSeries: ReadonlySet<string>;
  trendView: TrendView;
  /** The document whose chapter outline is previewed and whose top-level
   *  boundaries the chart may mark. A real presentation intent (NOT the scrub
   *  doc or focused series): defaults to the first ready doc in declared
   *  project order and is preserved while it stays ready. */
  focusedDoc: string | null;
  /** The focused doc's outline query result (independent of the term series). */
  structure: StructureState | null;
  /** On-demand authoring context (the correction editor's detected baseline). */
  editContext: EditContextState | null;
  /** On-demand bounded source line around the section anchor under inspection. */
  lineExcerpt: LineExcerptState | null;
  /** Opt-in: draw the focused doc's top-level chapter boundaries on the chart. */
  sectionMarks: boolean;
  scrub: ScrubTarget | null;
  /** The loaded passage block — may lag the scrub target while a fetch is in
   *  flight; the panel renders the block that CONTAINS the target only. */
  passage: PassageResult | null;

  // ── Query/presentation intent (owned here). ──
  setInput(input: string): void;
  setFocus(seriesId: string): void;
  /** Toggle a term in/out of the merged concordance; reissues ONLY the KWIC
   *  query, immediately, against the latest axis position. */
  toggleKwicSeries(seriesId: string): void;
  setTrendView(view: TrendView): void;
  setFocusedDoc(doc: string): void;
  setSectionMarks(on: boolean): void;
  setScrub(target: ScrubTarget): void;
  clearScrub(): void;
  runQueries(): void;
  /** (Re)issue the focused doc's outline query. Called on snapshot change and
   *  when the focused doc changes; independent of the term-series flow. */
  runStructure(): void;
  /** Fetch the authoring context (detected baseline) for a doc — on demand,
   *  when the correction editor opens. */
  requestEditContext(doc: string): void;
  /** Fetch the bounded source line around a char anchor — on demand. */
  requestLineExcerpt(doc: string, anchor: number, maxChars: number): void;

  // ── Session command wrappers (forward to the one attached session). ──
  /** Import files: create a user project from the built-in origin, or append
   *  to the current user project. */
  importFiles(files: readonly FileLike[], opts?: { persist?: boolean }): void;
  removeImport(doc: string): void;
  editMeta(doc: string, patch: MetaPatch): void;
  setLanguage(doc: string, language: string): void;
  /** Author (`override`) or discard (`null`) a doc's chapter-structure
   *  correction. The editor computes the declarative override from its draft. */
  setStructureOverride(doc: string, override: StructureOverrideV1 | null): void;
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

/** One query-intent lane: latest-wins ownership plus the in-flight transport
 *  cancels it may best-effort clean up. Superseding is ONE operation, so no
 *  call site can cancel without invalidating or invalidate without cancelling. */
class QueryLane {
  private cancels: (() => void)[] = [];
  readonly ops: LatestOperation;
  constructor(scope: OperationScope) {
    this.ops = new LatestOperation(scope);
  }
  /** Cancel + drop every tracked request and supersede outstanding leases.
   *  Cancellation is best-effort by contract — one throwing cancel must not
   *  abort the supersession (or teardown) of its peers. */
  supersede(): void {
    for (const c of this.cancels) {
      try {
        c();
      } catch {
        // The request either settles normally or its lease is already dead.
      }
    }
    this.cancels = [];
    this.ops.invalidate();
  }
  track(cancel: () => void): void {
    this.cancels.push(cancel);
  }
}

export function createAppRuntime(client: QueryClient): AppRuntime {
  // Ownership: ONE scope for the runtime lifetime (closed on dispose) and one
  // lane per query intent. A lease carries the fences the old hand-rolled
  // epochs + captured keys expressed.
  const scope = new OperationScope();
  const trendLane = new QueryLane(scope);
  const kwicLane = new QueryLane(scope);
  // Outline query intent — a separate lane from the term series so the preview
  // survives an empty term input and a focus change reissues only it.
  const structureLane = new QueryLane(scope);
  // On-demand authoring intents (edit-context + line-excerpt), each its own
  // lane; superseded on a snapshot change.
  const editContextLane = new QueryLane(scope);
  const lineExcerptLane = new QueryLane(scope);
  // The scrub lane fences the passage pump's RESULTS; the pump's one-active +
  // one-pending slot machinery below stays bespoke (it is a scheduler, not a
  // latest-wins request), so it is a bare lane without tracked cancels.
  const scrubOps = new LatestOperation(scope);
  // The SETTLED axis position the concordance centres on (null = reading order),
  // and the trailing-edge debounce timer from raw scrub motion to that center.
  let kwicCenter: ScrubTarget | null = null;
  let kwicCenterTimer: ReturnType<typeof setTimeout> | null = null;
  // Scrub scheduling: ONE active passage request plus ONE replaceable pending
  // target — pointer motion never queues and never cancel-storms the worker.
  let passageActiveCancel: (() => void) | null = null;
  let passagePending: ScrubTarget | null = null;

  // The one attached session (retained in the closure, never in Zustand state —
  // it holds Files, promises, and cancel handles). Null until the composition
  // root attaches it.
  let session: SessionPort | null = null;
  let unsubscribe: (() => void) | null = null;
  let attached = false;
  let disposed = false;

  const store = create<AppState>((set, get) => {
    /** Issue ONE guarded query on a lane: track its cancel, deliver only while
     *  the lease holds, swallow typed cancellation, surface real failures. The
     *  caller's onReady narrows the op discriminant and writes its own state. */
    const issueOn = (
      lane: QueryLane,
      snapshotId: string,
      op: QueryOpV4,
      lease: OperationLease,
      onReady: (data: QueryResultDataV4) => void,
      onError: (message: string) => void,
    ): void => {
      const handle = client.query(snapshotId, op);
      lane.track(handle.cancel);
      void handle.result
        .then((data) => {
          if (lease.isCurrent()) onReady(data);
        })
        .catch((e: unknown) => {
          if (isCancelled(e) || !lease.isCurrent()) return;
          onError(e instanceof Error ? e.message : String(e));
        });
    };

    /** Group/member ids derive from the series' presentation id — pure evidence
     *  provenance (the worker keys occurrences on `termGroupIdentity`, not this).
     *  The actual matched surface is `s.label` under the folded `MATCH` mode,
     *  resolved per document-locale in the worker. */
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
      const issuedKey = snapKey(snapshot);
      const lease = scrubOps.begin(() => snapKey(get().snapshot) === issuedKey);
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
      const current = () => lease.isCurrent();
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
          if (!isCancelled(e) && current()) {
            // A rejected center (stale geometry) or failed read: drop the
            // scrub rather than display a block that does not match it. The
            // concordance center goes with it so it cannot resurrect.
            set({ passage: null, scrub: null });
            passagePending = null;
            resetKwicCenter();
            runKwic();
            return;
          }
          pumpPassage();
        });
    };

    /** Issue the merged concordance for the ENABLED terms, centred on the
     *  SETTLED axis position (`kwicCenter`). Independent of `focusedSeries`. */
    const runKwic = () => {
      kwicLane.supersede(); // even a no-query outcome supersedes in-flight work
      const { snapshot, series, kwicEnabledSeries } = get();
      // No snapshot, or no terms at all (blank input) → no panel (kwic null),
      // distinct from "terms exist but all toggled off" (the no-terms state).
      if (!snapshot || series.length === 0) {
        set({ kwic: null });
        return;
      }
      // The center must name a ready doc at issue time; a stale center (its doc
      // departed on a new snapshot) degrades to reading order, never a clamp.
      const center = kwicCenter && snapshot.readyDocs.includes(kwicCenter.doc) ? kwicCenter : null;
      const enabled = series.filter((s) => kwicEnabledSeries.has(s.id));
      if (enabled.length === 0) {
        // Zero enabled terms: clear rows, issue no query, keep the panel + chips.
        set({ kwic: { center, state: { status: 'no-terms' } } });
        return;
      }
      const issuedKey = snapKey(snapshot);
      const lease = kwicLane.ops.begin(() => snapKey(get().snapshot) === issuedKey);
      set({ kwic: { center, state: { status: 'pending' } } });
      issueOn(
        kwicLane,
        snapshot.snapshot,
        {
          op: 'kwic',
          selection: { docs: [...snapshot.readyDocs] },
          tracks: enabled.map((s) => ({ seriesId: s.id, group: groupFor(s) })),
          request: {
            contextTokens: 6,
            ...(center ? { center: { doc: center.doc, token: center.token } } : {}),
            sort: [{ at: 'doc', dir: 1 }, { at: 'pos', dir: 1 }],
            page: { offset: 0, limit: 50 },
          },
        },
        lease,
        (data) => {
          if (data.op === 'kwic') set({ kwic: { center, state: { status: 'ready', total: data.total, rows: data.rows } } });
        },
        (message) => set({ kwic: { center, state: { status: 'error', message } } }),
      );
    };

    /** Forget the settled axis position — used wherever the public scrub is
     *  cleared, so an invisible center can never resurrect under a later query. */
    const resetKwicCenter = () => {
      if (kwicCenterTimer !== null) { clearTimeout(kwicCenterTimer); kwicCenterTimer = null; }
      kwicCenter = null;
    };

    /** Trailing-edge debounce from raw scrub motion to the KWIC center. Each
     *  scrub INVALIDATES the prior result immediately (a late result must never
     *  land under a newer axis) but only replaces the one pending center. */
    const scheduleKwicCenter = (target: ScrubTarget) => {
      // With every term toggled off the panel MUST keep its explicit no-terms
      // state — scrubbing must not flip it to "finding examples…". The next
      // toggle adopts the live scrub, so nothing is lost.
      const { series, kwicEnabledSeries } = get();
      if (!series.some((s) => kwicEnabledSeries.has(s.id))) return;
      kwicLane.supersede(); // any in-flight KWIC result was under the old center — drop it
      const held = get().kwic;
      if (held && held.state.status !== 'pending') set({ kwic: { center: held.center, state: { status: 'pending' } } });
      if (kwicCenterTimer !== null) clearTimeout(kwicCenterTimer);
      kwicCenterTimer = setTimeout(() => {
        kwicCenterTimer = null;
        kwicCenter = target;
        runKwic();
      }, KWIC_CENTER_DEBOUNCE_MS);
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
      // Every term appears in the concordance by default.
      kwicEnabledSeries: new Set(initialSeries.map((s) => s.id)),
      trendView: 'series',
      focusedDoc: null,
      structure: null,
      editContext: null,
      lineExcerpt: null,
      sectionMarks: false,
      scrub: null,
      passage: null,

      setInput(input) {
        const parsed = parseSeries(input);
        if (parsed.error !== null) {
          // Refused intent still supersedes the old one: cancel and clear so
          // stale lines are never displayed beside the error.
          set({ input, inputError: parsed.error, series: [], focusedSeries: null, kwicEnabledSeries: new Set() });
        } else {
          const { focusedSeries, series: oldSeries, kwicEnabledSeries: oldEnabled } = get();
          const stillFocused = parsed.series.some((s) => s.id === focusedSeries);
          // Preserve on/off for surviving ids; a newly introduced id is enabled.
          const oldIds = new Set(oldSeries.map((s) => s.id));
          const nextEnabled = new Set<string>();
          for (const s of parsed.series) if (!oldIds.has(s.id) || oldEnabled.has(s.id)) nextEnabled.add(s.id);
          set({
            input,
            inputError: null,
            series: parsed.series,
            // Surviving focus is preserved even if its position changed;
            // otherwise the first series becomes the actual (not implied) focus.
            focusedSeries: stillFocused ? focusedSeries : parsed.series[0]?.id ?? null,
            kwicEnabledSeries: nextEnabled,
          });
        }
        get().runQueries();
      },

      setFocus(seriesId) {
        if (get().focusedSeries === seriesId) return;
        if (!get().series.some((s) => s.id === seriesId)) return;
        // Focus drives ONLY the trend-line emphasis; the concordance is a merged
        // multi-term view independent of focus, so no KWIC reissue here.
        set({ focusedSeries: seriesId });
      },

      toggleKwicSeries(seriesId) {
        if (!get().series.some((s) => s.id === seriesId)) return;
        const next = new Set(get().kwicEnabledSeries);
        if (next.has(seriesId)) next.delete(seriesId);
        else next.add(seriesId);
        set({ kwicEnabledSeries: next });
        // Reissue ONLY the concordance, immediately, against the latest axis:
        // adopt the current scrub (superseding any pending debounce) as the center.
        if (kwicCenterTimer !== null) { clearTimeout(kwicCenterTimer); kwicCenterTimer = null; }
        const scrub = get().scrub;
        if (scrub && get().snapshot?.readyDocs.includes(scrub.doc)) kwicCenter = scrub;
        runKwic();
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
        scheduleKwicCenter(target); // debounced concordance re-centre on the axis
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
        // The concordance falls back to reading order immediately.
        resetKwicCenter();
        runKwic();
      },

      runQueries() {
        const { snapshot, series } = get();
        // Trend intent changed: ALWAYS cancel superseded work, clear to
        // pending, and invalidate the epoch — even when the new intent runs
        // no query (round 2: a blank input must not relabel old evidence).
        trendLane.supersede(); // even a no-query outcome supersedes in-flight work
        // The loaded passage block and any in-flight/pending fetch belong to
        // the OLD series set / snapshot — marks would be stale evidence. The
        // scrub POSITION is kept; a fresh block is fetched below if possible.
        scrubOps.invalidate();
        passageActiveCancel?.();
        passageActiveCancel = null;
        passagePending = null;
        // A pending scrub-settle belongs to the old series/snapshot; drop it so
        // it cannot fire a stale center after this reissue. runKwic below uses
        // the last settled center (degrading to reading order if its doc departed).
        if (kwicCenterTimer !== null) { clearTimeout(kwicCenterTimer); kwicCenterTimer = null; }
        set({ passage: null });
        if (!snapshot || series.length === 0) {
          set({ trends: new Map(), scrub: null });
          resetKwicCenter(); // the axis is gone — no stale center may resurrect
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
        // ONE lease for the whole series burst — the burst is a single intent.
        const lease = trendLane.ops.begin(() => snapKey(get().snapshot) === issuedKey);

        for (const s of series) {
          const write = (state: SeriesTrendState) =>
            set((prev) => {
              const next = new Map(prev.trends); // NEVER mutate the resident map
              next.set(s.id, state);
              return { trends: next };
            });
          issueOn(
            trendLane,
            issuedSnapshot,
            {
              op: 'trend',
              selection: { docs: [...snapshot.readyDocs] },
              group: groupFor(s),
              request: { coordinate: 'declared-sequence', binsPerDoc: BINS },
            },
            lease,
            (data) => {
              if (data.op === 'trend') write({ status: 'ready', trend: data.trend });
            },
            // A genuine failure must mark ITS series, not silently vanish —
            // and must not erase successful peers.
            (message) => write({ status: 'error', message }),
          );
        }

        runKwic();
      },

      runStructure() {
        structureLane.supersede();
        const { snapshot, focusedDoc } = get();
        if (!snapshot || !focusedDoc || !snapshot.readyDocs.includes(focusedDoc)) {
          set({ structure: null });
          return;
        }
        const issuedKey = snapKey(snapshot);
        const issuedDoc = focusedDoc;
        // (generation, snapshot, doc): a slow result for a superseded focus or
        // snapshot must never relabel the current outline.
        const lease = structureLane.ops.begin(
          () => snapKey(get().snapshot) === issuedKey,
          () => get().focusedDoc === issuedDoc,
        );
        set({ structure: { doc: focusedDoc, state: { status: 'pending' } } });
        issueOn(
          structureLane,
          snapshot.snapshot,
          { op: 'structure', request: { doc: focusedDoc } },
          lease,
          (data) => {
            if (data.op === 'structure') set({ structure: { doc: issuedDoc, state: { status: 'ready', result: data.structure } } });
          },
          (message) => set({ structure: { doc: issuedDoc, state: { status: 'error', message } } }),
        );
      },

      requestEditContext(doc) {
        editContextLane.supersede();
        const { snapshot } = get();
        if (!snapshot || !snapshot.readyDocs.includes(doc)) {
          set({ editContext: null });
          return;
        }
        const issuedKey = snapKey(snapshot);
        const lease = editContextLane.ops.begin(() => snapKey(get().snapshot) === issuedKey);
        set({ editContext: { doc, state: { status: 'pending' } } });
        issueOn(
          editContextLane,
          snapshot.snapshot,
          { op: 'structure-edit-context', request: { doc } },
          lease,
          (data) => {
            if (data.op === 'structure-edit-context') set({ editContext: { doc, state: { status: 'ready', context: data.context } } });
          },
          (message) => set({ editContext: { doc, state: { status: 'error', message } } }),
        );
      },

      requestLineExcerpt(doc, anchor, maxChars) {
        lineExcerptLane.supersede();
        const { snapshot } = get();
        if (!snapshot || !snapshot.readyDocs.includes(doc)) {
          set({ lineExcerpt: null });
          return;
        }
        const issuedKey = snapKey(snapshot);
        const lease = lineExcerptLane.ops.begin(() => snapKey(get().snapshot) === issuedKey);
        set({ lineExcerpt: { doc, anchor, state: { status: 'pending' } } });
        issueOn(
          lineExcerptLane,
          snapshot.snapshot,
          { op: 'line-excerpt', request: { doc, anchor, maxChars } },
          lease,
          (data) => {
            if (data.op === 'line-excerpt') set({ lineExcerpt: { doc, anchor, state: { status: 'ready', excerpt: data.excerpt } } });
          },
          (message) => set({ lineExcerpt: { doc, anchor, state: { status: 'error', message } } }),
        );
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
      setStructureOverride(doc, override) {
        command((s) => s.setStructureOverride(doc, override));
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
      // The on-demand authoring intents are bound to the old snapshot's
      // artifacts — cancel and clear them before the outline reissues.
      editContextLane.supersede();
      lineExcerptLane.supersede();
      if (store.getState().editContext !== null || store.getState().lineExcerpt !== null) {
        store.setState({ editContext: null, lineExcerpt: null });
      }
      store.getState().runQueries();
      store.getState().runStructure();
    }
  };

  return {
    useApp: store,
    attachSession(next: SessionPort) {
      if (disposed) {
        // A late attachment (async bootstrap racing teardown) must not bridge
        // into a disposed runtime — the runtime owns its session, so dispose it.
        next.dispose();
        return;
      }
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
      if (disposed) return; // a torn-down runtime reports nothing
      store.setState({ bootstrap: { phase: 'error', message: msg(error) } });
    },
    dispose() {
      disposed = true;
      // Close the ownership scope FIRST: every outstanding lease goes dead, so
      // a late settlement (even one whose cancel is never acknowledged) can no
      // longer write to the store. Then best-effort transport cleanup: cancel
      // every in-flight query, drop the pending passage slot, and stop the
      // debounce timer so it cannot mint a query after disposal.
      scope.close();
      trendLane.supersede();
      kwicLane.supersede();
      structureLane.supersede();
      editContextLane.supersede();
      lineExcerptLane.supersede();
      passageActiveCancel?.();
      passageActiveCancel = null;
      passagePending = null;
      if (kwicCenterTimer !== null) {
        clearTimeout(kwicCenterTimer);
        kwicCenterTimer = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      session?.dispose();
      session = null;
    },
  };
}
