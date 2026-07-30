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
 * Query-notebook intent (slice-1 ruling, docs/design/term-groups-plan.md):
 * the authoritative query model is an ordered notebook of term GROUPS, each
 * a stable UUID + display name + authored core members. The comparison is
 * the ≤MAX_SERIES ACTIVE groups (solo temporarily narrows to one); `series`
 * is the stored projection the panels consume. TWO identities, never
 * conflated: the UUID is presentation/selection identity (focus, style,
 * concordance membership, result keys); `termGroupIdentity` is matching
 * identity (worker caches, stale-result admission). The comma input is the
 * APPEND-ONLY quick-add surface (`parseQuickAdd`): each term becomes a
 * single-token folded group, a term already present (same matching identity)
 * is skipped, and an over-room batch refuses atomically. Dedup is NFC only,
 * deliberately locale-INDEPENDENT (whether two surfaces match identically is
 * per-document, resolved under each shard's locale in the worker; a fixed
 * `en` fold once wrongly unified `I`/`İ`). Trend results key off group id in
 * an immutably-replaced map; a missing entry is impossible to confuse with
 * pending or failed because every issued series is seeded 'pending', and a
 * result commits only while BOTH its lease and its issued matching identity
 * hold.
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
  DISPERSION_BUCKET_BUDGET,
  DISPERSION_EXACT_MAX,
  FREQUENCY_PAGE_MAX,
  FREQUENCY_PREFIX_MAX_UNITS,
  FREQUENCY_WINDOW_MAX,
  MAX_KWIC_TRACKS,
  PASSAGE_MAX_TOKENS,
  READER_MAX_TOKENS,
  termGroupIdentity,
  type DocumentMetaV1,
  type GroupMember,
  type NumericTrend,
  type StructureOverrideV1,
  type TermGroupSpec,
} from '@texttrends/core';
import { detailSelection, isValidSelection, type TokenRangeSelectionV1 } from './selection.ts';
import {
  MAX_PINNED_SNIPPETS,
  canReusePassage,
  evidenceFrom,
  samePinAnchor,
  type CapturedTrack,
  type PassageBlockState,
  type PinAnchor,
  type PinnedSnippet,
} from './pins.ts';
import {
  readerPlaceFor,
  sameReaderCursor,
  sameReaderPlace,
  type ReaderOpenIntent,
  type ReaderPlace,
} from './reader-intent.ts';
import {
  coreGroupOf,
  groupIdentity,
  NOTEBOOK_LIMITS_V1,
  parseQuickAdd,
  reconcileStyleSlots,
  validateNotebookGroup,
  type QueryNotebookV1,
} from './notebook.ts';
import { isCancelled } from './client.ts';
import type { SnapshotInfo } from './client.ts';
import {
  KeyedLatestOperation,
  LatestOperation,
  OperationScope,
  type OperationLease,
} from './operation-lease.ts';
import type {
  DispersionResultV1,
  LineExcerptResultV1,
  QueryOpV4,
  QueryResultDataV4,
  ReaderPageResultV1,
  StructureEditContextV1,
  StructureQueryResultV1,
  InventoryResultV1,
  FrequencyListResultV1,
  FrequencySortFieldV1,
  FrequencyTokenClassV1,
  TfidfSectionsResultV1,
} from '../shared/analysis-contract.ts';
import {
  SessionCommandError,
  type AnalysisPhase,
  type FileLike,
  type SessionState,
} from './project-session.ts';


export interface KwicRowView {
  /** The series (track) that produced this row — the merged concordance tags
   *  each occurrence so the panel can colour and label it. */
  readonly seriesId: string;
  /** Wire provenance retained for EVIDENCE IDENTITY (commit D): under
   *  countOverlaps two rows can share (series, doc, pos) and differ only in
   *  span/members — the panel key must include them (kwicRowKey). */
  readonly groupId: string;
  readonly members: readonly number[];
  readonly node: { readonly start: number; readonly end: number };
  readonly doc: string;
  readonly pos: number;
  readonly left: string;
  readonly nodeText: string;
  readonly right: string;
}

/** The FULL evidence key of a concordance row — stable and collision-free
 *  where `${seriesId}:${doc}:${pos}` is not: countOverlaps can emit two rows
 *  at one start that differ only by node end / contributing members. The
 *  encoding is an INJECTIVE JSON tuple: string fields have no delimiter-free
 *  contract, so concatenation could alias (seriesId 'a:b', doc 'c') with
 *  (seriesId 'a', doc 'b:c') (review-D). */
export function kwicRowKey(r: KwicRowView): string {
  return JSON.stringify([r.seriesId, r.groupId, r.doc, r.pos, r.node.start, r.node.end, r.members]);
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
export const INVENTORY_RHYTHM_BINS = 24;
export const INVENTORY_GROWTH_POINTS = 128;
export const INVENTORY_MATTR_WINDOW = 500;
export const TFIDF_SECTION_MIN_TOKENS = 50;
export const TFIDF_TOP_K = 5;

/** (generation, snapshot) identity — a query result is written only if the live
 *  snapshot still matches this. Snapshot ids are unique per publication; the
 *  extra generation fence is cheap and matches the session contract. */
const snapKey = (s: SnapshotInfo | null): string | null =>
  s ? JSON.stringify([s.generation, s.snapshot]) : null;

export interface SeriesIntent {
  /** Stable PRESENTATION identity: the owning notebook group's UUID — a
   *  display/colour/dedup key, NOT a semantic match key (that is
   *  `termGroupIdentity`). */
  readonly id: string;
  /** The group's display name (quick-add: the NFC term). */
  readonly label: string;
  /** Fixed visual slot (color + dash) — owned by the group, preserved
   *  through rename/edit/reorder/mute, freed on removal. */
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
  /** Snapshot under which every row/state in this arm was issued. */
  readonly snapshot: string;
  /** The served center; `origin: 'bucket'` marks a density-bucket midpoint
   *  target so the caption says "nearest occurrence to this bucket" and can
   *  report the first row's distance (never implying an exact occurrence). */
  readonly center: (ScrubTarget & { readonly origin?: 'bucket'; readonly bucketCount?: number }) | null;
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

/** The dispersion barcode result for the CURRENT effective comparison —
 *  issued with the trend burst, same guards (slice-2 commit D). */
export interface DispersionState {
  /** Snapshot under which this resident result/state was issued. */
  readonly snapshot: string;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly result: DispersionResultV1 }
    | { readonly status: 'error'; readonly message: string };
}

/** The reader result for one exact issued place + current semantic track
 * projection. Pending replaces the prior page immediately, so navigation
 * never presents page A beneath cursor B. */
export interface ReaderPageState {
  readonly snapshot: string;
  readonly place: ReaderPlace;
  readonly tracks: readonly CapturedTrack[];
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly page: ReaderPageResultV1 }
    | { readonly status: 'error'; readonly message: string };
}

export interface InventoryState {
  readonly snapshot: string;
  readonly selection: TokenRangeSelectionV1 | null;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly result: InventoryResultV1 }
    | { readonly status: 'error'; readonly message: string };
}

export interface FrequencyViewV1 {
  readonly schema: 'texttrends/frequency-view/1';
  readonly minCount: number;
  readonly minDocFreq: number;
  readonly classes: readonly FrequencyTokenClassV1[];
  readonly prefixNfc?: string;
  readonly sort: { readonly by: FrequencySortFieldV1; readonly dir: 1 | -1 };
  readonly page: { readonly offset: number; readonly limit: number };
}

export interface FrequencyState {
  readonly snapshot: string;
  readonly selection: TokenRangeSelectionV1 | null;
  readonly view: FrequencyViewV1;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly result: FrequencyListResultV1 }
    | { readonly status: 'error'; readonly message: string };
}

export interface TfidfState {
  readonly snapshot: string;
  readonly doc: string;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly result: TfidfSectionsResultV1 }
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
const SCRUB_GUARD_TOKENS = 28;

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

  /** The query notebook (slice-1 ruling): the authoritative ordered group
   *  list. Session-only in this slice — deliberately NOT persisted anywhere
   *  (a hand-authored notebook is class-1 user data; durability arrives with
   *  the versioned share/persistence slice, never an ad hoc stash). */
  notebook: QueryNotebookV1;
  /** Membership = the group participates in the comparison (trends, passage
   *  marks, KWIC eligibility). Order is notebook order. Never silently
   *  truncated: a sixth activation is refused with `notebookError`. */
  activeGroupIds: ReadonlySet<string>;
  /** Transient view projection: when set, the effective active set is JUST
   *  this group; clearing restores the prior state exactly (nothing else is
   *  mutated). Cleared when the group is removed or deactivated. */
  soloGroupId: string | null;
  /** Style-slot ownership (group id → slot). Preserved through rename,
   *  member edits, reorder, and mute; freed on removal; unique among actives. */
  styleSlots: ReadonlyMap<string, number>;
  /** One bounded notebook-authoring refusal (sixth activation, invalid member
   *  set, over-limit name). Cleared by the next successful notebook action. */
  notebookError: string | null;
  /** The EFFECTIVE active comparison, in notebook order (solo-projected) —
   *  the stored projection every panel and query lane consumes. */
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
  /** The barcode's dispersion result (null = no comparison/corpus). */
  dispersion: DispersionState | null;
  /** The ONE transient linked token-range selection (ruling §2): single-doc,
   *  half-open, snapshot-bound; NEVER persisted, NEVER a durable Brush.
   *  Cleared on snapshot replacement or when its document departs. */
  linkedSelection: TokenRangeSelectionV1 | null;
  /** Range-scoped trends for the selection — an OVERLAY beside the intact
   *  whole-corpus baseline (zero-denominator bins are gaps, never zeros). */
  selectedTrends: ReadonlyMap<string, SeriesTrendState>;
  /** Range-scoped dispersion layer over the dim whole-corpus strip. */
  selectedDispersion: DispersionState | null;
  /** Vocabulary-wide analytics are notebook-independent. */
  inventory: InventoryState | null;
  frequencyView: FrequencyViewV1;
  frequency: FrequencyState | null;
  /** Full-document chapter labels for the focused book. */
  tfidf: TfidfState | null;
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
  passage: PassageBlockState | null;
  /** Bounded, insertion-ordered captured evidence. Pending/error items count
   *  toward the cap; snapshot replacement clears the whole collection. */
  pins: readonly PinnedSnippet[];
  focusedPinId: string | null;
  pinError: string | null;
  pinAnnouncement: string | null;
  /** F owns only the fenced place/placeholder; H attaches reader-page state. */
  readerPlace: ReaderPlace | null;
  readerPage: ReaderPageState | null;
  /** Last served canonical cursors remain operable while the next page is
   * pending, allowing a rapid opposite-direction action to supersede it
   * without continuing to display the stale prose. */
  readerNavigation: {
    readonly previous: ReaderPlace['cursor'] | null;
    readonly next: ReaderPlace['cursor'] | null;
  } | null;

  // ── Query/presentation intent (owned here). ──
  /** Append-only quick-add: each comma term becomes a single-token folded
   *  group, active and concordance-enabled; a term already in the notebook
   *  (same matching identity) is skipped; a batch that cannot FULLY activate
   *  is refused atomically via `inputError` (nothing partial, ruling §3). */
  quickAdd(input: string): void;
  // ── Notebook authoring (slice-1 commit B: model + actions; UI lands in the
  //    panel commit). Rename/reorder are presentation-only (no reissue);
  //    member/overlap edits and active-set changes reissue the evidence. ──
  renameGroup(groupId: string, name: string): void;
  setGroupMembers(groupId: string, members: readonly GroupMember[], countOverlaps: boolean): void;
  removeGroup(groupId: string): void;
  reorderGroups(order: readonly string[]): void;
  setGroupActive(groupId: string, active: boolean): void;
  setSolo(groupId: string | null): void;
  clearNotebookError(): void;
  setFocus(seriesId: string): void;
  /** Toggle a term in/out of the merged concordance; reissues ONLY the KWIC
   *  query, immediately, against the latest axis position. */
  toggleKwicSeries(seriesId: string): void;
  setTrendView(view: TrendView): void;
  /** Center the concordance on activated barcode evidence IMMEDIATELY (no
   *  scrub debounce). Carries the activated series: a deliberate occurrence
   *  click must yield a concordance CAPABLE of containing it, so a disabled
   *  concordance chip for that series is visibly re-enabled first (review-D
   *  HIGH). `origin: 'bucket'` labels a density-midpoint target. */
  centerKwicAt(seriesId: string, doc: string, token: number, origin?: { readonly kind: 'bucket'; readonly count: number }): void;
  /** Commit a linked range (already clamped to ONE document by the gesture
   *  layer). Reissues the DETAIL consumers (kwic + selected overlays); the
   *  baseline evidence is retained untouched. Null clears. */
  setLinkedSelection(selection: TokenRangeSelectionV1 | null): void;
  runInventory(): void;
  runFrequency(): void;
  runTfidf(): void;
  setFrequencySort(by: FrequencySortFieldV1): void;
  setFrequencyPrefix(prefix: string): void;
  setFrequencyFilter(minCount: number, minDocFreq: number, prefix: string): void;
  setFrequencyClasses(classes: readonly FrequencyTokenClassV1[]): void;
  setFrequencyPage(offset: number): void;
  setFrequencyPageSize(limit: number): void;
  addFrequencyTerm(key: string): void;
  showFrequencyTermInKwic(key: string): void;
  setFocusedDoc(doc: string): void;
  setSectionMarks(on: boolean): void;
  setScrub(target: ScrubTarget): void;
  clearScrub(): void;
  pinPassage(doc: string, token: number): void;
  removePin(id: string): void;
  retryPin(id: string): void;
  focusPin(id: string): void;
  clearPinError(): void;
  openReader(intent: ReaderOpenIntent): void;
  navigateReader(cursor: ReaderPlace['cursor']): void;
  retryReader(): void;
  closeReader(): void;
  runReader(): void;
  /** Internal/publicly harmless revalidation invoked only on snapshot change. */
  revalidatePins(): void;
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

export function createAppRuntime(
  client: QueryClient,
  opts?: { /** Injectable UUID factory (deterministic in tests). */ newId?: () => string },
): AppRuntime {
  const newId = opts?.newId ?? (() => crypto.randomUUID());
  // Ownership: ONE scope for the runtime lifetime (closed on dispose) and one
  // lane per query intent. A lease carries the fences the old hand-rolled
  // epochs + captured keys expressed.
  const scope = new OperationScope();
  const trendLane = new QueryLane(scope);
  const kwicLane = new QueryLane(scope);
  // Outline query intent — a separate lane from the term series so the preview
  // survives an empty term input and a focus change reissues only it.
  const structureLane = new QueryLane(scope);
  // The barcode's dispersion intent — reissued with the trend burst.
  const dispersionLane = new QueryLane(scope);
  // Selected-range overlay lanes — separate latest-wins ownership so a brush
  // never cancels the resident baseline (ruling §2).
  const selectedTrendLane = new QueryLane(scope);
  const selectedDispersionLane = new QueryLane(scope);
  // Vocabulary-wide analytics are independent of notebook query lanes.
  const inventoryLane = new QueryLane(scope);
  const frequencyLane = new QueryLane(scope);
  const tfidfLane = new QueryLane(scope);
  // On-demand authoring intents (edit-context + line-excerpt), each its own
  // lane; superseded on a snapshot change.
  const editContextLane = new QueryLane(scope);
  const lineExcerptLane = new QueryLane(scope);
  // Full-reader pages are a distinct latest-wins presentation intent. Rapid
  // Next/Previous cannot race with trends, passage, pins, or one another.
  const readerLane = new QueryLane(scope);
  // The scrub lane fences the passage pump's RESULTS; the pump's one-active +
  // one-pending slot machinery below stays bespoke (it is a scheduler, not a
  // latest-wins request), so it is a bare lane without tracked cancels.
  const scrubOps = new LatestOperation(scope);
  // Pins are independent intents: keyed ownership prevents pin B from
  // superseding pin A, while the shared scope still fences runtime teardown.
  const pinOps = new KeyedLatestOperation<string>(scope);
  const pinCancels = new Map<string, () => void>();
  const pinRequests = new Map<
    string,
    {
      readonly wire: readonly { readonly seriesId: string; readonly group: TermGroupSpec }[];
      readonly tracks: readonly CapturedTrack[];
    }
  >();
  // The SETTLED axis position the concordance centres on (null = reading order),
  // and the trailing-edge debounce timer from raw scrub motion to that center.
  let kwicCenter: (ScrubTarget & { readonly origin?: 'bucket'; readonly bucketCount?: number }) | null = null;
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

    /** The EXACT authored core spec for a series (its notebook group) — the
     *  store passes authored members through verbatim; nothing is rebuilt.
     *  Null when the group vanished between projection and issue (callers
     *  treat that as a superseded intent). */
    const specFor = (id: string): TermGroupSpec | null => {
      const g = get().notebook.groups.find((x) => x.id === id);
      return g ? coreGroupOf(g) : null;
    };

    /** Current MATCHING identity of a group, null if the group is gone. A
     *  result may commit only while its issued identity is still current
     *  (ruling invariant 4) — a member edit under the same UUID must reject
     *  the old semantics' late result even if a reissue was somehow missed. */
    const identityOf = (id: string): string | null => {
      const g = get().notebook.groups.find((x) => x.id === id);
      return g ? groupIdentity(g) : null;
    };

    /** The stored `series` projection: effective actives in notebook order
     *  (solo narrows to one), carrying group-owned style slots. */
    const projectSeries = (
      nb: QueryNotebookV1,
      active: ReadonlySet<string>,
      solo: string | null,
      slots: ReadonlyMap<string, number>,
    ): SeriesIntent[] =>
      nb.groups
        .filter((g) => active.has(g.id) && (solo === null || g.id === solo))
        .map((g) => ({ id: g.id, label: g.name, styleSlot: slots.get(g.id) ?? 0 }));

    /** Wire tracks + captured issue-time identities for a series set; null if
     *  any group vanished (the intent is already superseded). */
    const trackSpecs = (
      series: readonly SeriesIntent[],
    ): {
      wire: { seriesId: string; group: TermGroupSpec }[];
      identities: (readonly [string, string])[];
      captured: readonly CapturedTrack[];
    } | null => {
      const wire: { seriesId: string; group: TermGroupSpec }[] = [];
      const identities: (readonly [string, string])[] = [];
      const captured: CapturedTrack[] = [];
      for (const s of series) {
        const spec = specFor(s.id);
        if (spec === null) return null;
        const identity = termGroupIdentity(spec);
        wire.push({ seriesId: s.id, group: spec });
        identities.push([s.id, identity] as const);
        captured.push(Object.freeze({
          seriesId: s.id,
          groupId: spec.id,
          identity,
          label: s.label,
          styleSlot: s.styleSlot,
        }));
      }
      return { wire, identities, captured: Object.freeze(captured) };
    };

    const identitiesCurrent = (pairs: readonly (readonly [string, string])[]): boolean =>
      pairs.every(([id, ident]) => identityOf(id) === ident);

    const replacePin = (
      id: string,
      replace: (pin: PinnedSnippet) => PinnedSnippet,
    ): void => {
      set((state) => ({
        pins: state.pins.map((pin) => pin.id === id ? replace(pin) : pin),
      }));
    };

    /** Issue one independently-owned pin passage request. Deliberately no
     * live semantic-identity guard: the pending arm already captured the
     * semantics this result truthfully describes. */
    const issuePin = (
      id: string,
      anchor: PinAnchor,
      tracks: readonly CapturedTrack[],
      wire: readonly { readonly seriesId: string; readonly group: TermGroupSpec }[],
    ): void => {
      const issuedKey = snapKey(get().snapshot);
      const lease = pinOps.begin(
        id,
        () => snapKey(get().snapshot) === issuedKey,
        () => get().pins.some((pin) => pin.id === id),
      );
      pinRequests.set(id, { wire, tracks });
      const handle = client.query(anchor.snapshot, {
        op: 'passage',
        request: {
          doc: anchor.doc,
          centerToken: anchor.token,
          maxTokens: PASSAGE_MAX_TOKENS,
          tracks: wire,
        },
      });
      pinCancels.set(id, handle.cancel);
      const releaseCancel = () => {
        if (pinCancels.get(id) === handle.cancel) pinCancels.delete(id);
      };
      void handle.result
        .then((data) => {
          releaseCancel();
          if (!lease.isCurrent()) return;
          if (data.op !== 'passage') {
            replacePin(id, (pin) => ({ ...pin, kind: 'error', message: 'unexpected pin result' }));
            return;
          }
          const evidence = evidenceFrom(data.passage, anchor.token);
          if (evidence === null) {
            replacePin(id, (pin) => ({ ...pin, kind: 'error', message: 'passage did not contain the pinned token' }));
            return;
          }
          replacePin(id, (pin) => ({
            kind: 'ready',
            id: pin.id,
            anchor: pin.anchor,
            tracks: pin.tracks,
            evidence,
          }));
        })
        .catch((e: unknown) => {
          releaseCancel();
          if (isCancelled(e) || !lease.isCurrent()) return;
          replacePin(id, (pin) => ({
            kind: 'error',
            id: pin.id,
            anchor: pin.anchor,
            tracks: pin.tracks,
            message: e instanceof Error ? e.message : String(e),
          }));
        });
    };

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
    const blockServes = (passage: PassageBlockState, target: ScrubTarget): boolean => {
      if (passage.result.doc !== target.doc) return false;
      const { start, end } = passage.result.tokens;
      if (target.token < start || target.token >= end) return false;
      const tc = docTokenCountOf(target.doc);
      if (tc !== null && !passage.result.truncatedByCharCap) {
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
      const tracks = trackSpecs(series);
      if (tracks === null) return; // a group vanished mid-intent: superseded
      const issuedKey = snapKey(snapshot);
      const lease = scrubOps.begin(
        () => snapKey(get().snapshot) === issuedKey,
        () => identitiesCurrent(tracks.identities),
      );
      const handle = client.query(snapshot.snapshot, {
        op: 'passage',
        request: {
          doc: target.doc,
          centerToken: target.token,
          maxTokens: PASSAGE_MAX_TOKENS,
          tracks: tracks.wire,
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
          if (data.op === 'passage' && current()) {
            set({
              passage: {
                snapshot: snapshot.snapshot,
                tracks: tracks.captured,
                result: data.passage,
              },
            });
          }
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

    /** (Re)issue the SELECTED-range overlays (trends + dispersion) for the
     *  active linked selection — separate lanes so a brush never cancels the
     *  resident whole-corpus baseline (ruling §2). No selection: overlays
     *  clear; the baseline stands. */
    const runSelected = () => {
      selectedTrendLane.supersede();
      selectedDispersionLane.supersede();
      const { snapshot, series, linkedSelection } = get();
      if (!snapshot || series.length === 0 || linkedSelection === null
        || !isValidSelection(linkedSelection, snapshot.snapshot, snapshot.readyDocs)) {
        set({ selectedTrends: new Map(), selectedDispersion: null });
        return;
      }
      const issuedKey = snapKey(snapshot);
      const issuedSelection = linkedSelection;
      const wireSelection = detailSelection(snapshot.readyDocs, issuedSelection);
      const guard = () => get().linkedSelection === issuedSelection;
      set({ selectedTrends: new Map(series.map((s) => [s.id, { status: 'pending' } as const])) });
      const lease = selectedTrendLane.ops.begin(
        () => snapKey(get().snapshot) === issuedKey,
        guard,
      );
      for (const s of series) {
        const spec = specFor(s.id);
        if (spec === null) continue;
        const issuedIdentity = termGroupIdentity(spec);
        const write = (state: SeriesTrendState) =>
          set((prev) => {
            const next = new Map(prev.selectedTrends);
            next.set(s.id, state);
            return { selectedTrends: next };
          });
        issueOn(
          selectedTrendLane,
          snapshot.snapshot,
          { op: 'trend', selection: wireSelection, group: spec, request: { coordinate: 'declared-sequence', binsPerDoc: BINS } },
          lease,
          (data) => {
            if (data.op === 'trend' && identityOf(s.id) === issuedIdentity) write({ status: 'ready', trend: data.trend });
          },
          (message) => {
            if (identityOf(s.id) === issuedIdentity) write({ status: 'error', message });
          },
        );
      }
      const dTracks = trackSpecs(series);
      if (dTracks !== null) {
        const dLease = selectedDispersionLane.ops.begin(
          () => snapKey(get().snapshot) === issuedKey,
          () => identitiesCurrent(dTracks.identities),
          guard,
        );
        set({
          selectedDispersion: {
            snapshot: snapshot.snapshot,
            state: { status: 'pending' },
          },
        });
        issueOn(
          selectedDispersionLane,
          snapshot.snapshot,
          { op: 'dispersion', selection: wireSelection, tracks: dTracks.wire, request: { method: 'dispersion/1', exactMax: DISPERSION_EXACT_MAX, bucketBudget: DISPERSION_BUCKET_BUDGET } },
          dLease,
          (data) => {
            if (data.op === 'dispersion') {
              set({
                selectedDispersion: {
                  snapshot: snapshot.snapshot,
                  state: { status: 'ready', result: data.dispersion },
                },
              });
            }
          },
          (message) => set({
            selectedDispersion: {
              snapshot: snapshot.snapshot,
              state: { status: 'error', message },
            },
          }),
        );
      }
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
        set({ kwic: { snapshot: snapshot.snapshot, center, state: { status: 'no-terms' } } });
        return;
      }
      const tracks = trackSpecs(enabled);
      if (tracks === null) { set({ kwic: null }); return; }
      const issuedKey = snapKey(snapshot);
      // The concordance is a DETAIL consumer: an active linked range scopes
      // it to exactly that range via the ONE selection builder (ruling §2 —
      // the [doc] is load-bearing; every row and total is inside the range).
      const issuedSelection = get().linkedSelection;
      const lease = kwicLane.ops.begin(
        () => snapKey(get().snapshot) === issuedKey,
        () => identitiesCurrent(tracks.identities),
        () => get().linkedSelection === issuedSelection,
      );
      set({ kwic: { snapshot: snapshot.snapshot, center, state: { status: 'pending' } } });
      issueOn(
        kwicLane,
        snapshot.snapshot,
        {
          op: 'kwic',
          selection: detailSelection(snapshot.readyDocs, issuedSelection),
          tracks: tracks.wire,
          request: {
            contextTokens: 6,
            ...(center ? { center: { doc: center.doc, token: center.token } } : {}),
            sort: [{ at: 'doc', dir: 1 }, { at: 'pos', dir: 1 }],
            page: { offset: 0, limit: 50 },
          },
        },
        lease,
        (data) => {
          if (data.op === 'kwic') {
            set({
              kwic: {
                snapshot: snapshot.snapshot,
                center,
                state: { status: 'ready', total: data.total, rows: data.rows },
              },
            });
          }
        },
        (message) => set({
          kwic: {
            snapshot: snapshot.snapshot,
            center,
            state: { status: 'error', message },
          },
        }),
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
      if (held && held.state.status !== 'pending') {
        set({
          kwic: {
            snapshot: held.snapshot,
            center: held.center,
            state: { status: 'pending' },
          },
        });
      }
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

    /**
     * Adopt a notebook mutation: recompute style slots, the series
     * projection, and the dependent normalizations (focus in projection;
     * concordance membership per surviving group, newly active groups
     * enabled; solo only on an active group). ONE authority so every action
     * leaves the same invariants (ruling invariant 7). Reissue policy is the
     * CALLER's: rename/reorder are presentation-only.
     */
    /** The EFFECTIVE query intent: for each projected series in order, its
     *  UUID, matching identity, and concordance membership. Reissue decisions
     *  compare THIS — a mutation that leaves it unchanged (muting a solo'd-out
     *  group, editing an unprojected one, appending while soloed) must not
     *  cancel or recompute live evidence (ruling invariant 2, review-C). */
    const effectiveIntentKey = (
      nb: QueryNotebookV1,
      series: readonly SeriesIntent[],
      enabled: ReadonlySet<string>,
    ): string =>
      JSON.stringify(series.map((s) => {
        const g = nb.groups.find((x) => x.id === s.id);
        return [s.id, g ? groupIdentity(g) : null, enabled.has(s.id)];
      }));

    const adoptNotebook = (
      next: { notebook?: QueryNotebookV1; activeGroupIds?: ReadonlySet<string>; soloGroupId?: string | null },
      opts: { reissue: boolean },
    ): void => {
      const prev = get();
      const prevIntent = effectiveIntentKey(prev.notebook, prev.series, prev.kwicEnabledSeries);
      const notebook = next.notebook ?? prev.notebook;
      const known = new Set(notebook.groups.map((g) => g.id));
      const active = new Set([...(next.activeGroupIds ?? prev.activeGroupIds)].filter((id) => known.has(id)));
      let solo = next.soloGroupId === undefined ? prev.soloGroupId : next.soloGroupId;
      if (solo !== null && !active.has(solo)) solo = null;
      const activeInOrder = notebook.groups.filter((g) => active.has(g.id)).map((g) => g.id);
      const styleSlots = reconcileStyleSlots(prev.styleSlots, activeInOrder, known, prev.activeGroupIds);
      const series = projectSeries(notebook, active, solo, styleSlots);
      // Concordance membership: preserved for every SURVIVING group (muting
      // must not destroy the toggle — invariant 6); a newly created group
      // joins enabled. Effective KWIC stays `series ∩ enabled` at issue
      // time, always a subset of the actives.
      const nextEnabled = new Set<string>();
      for (const g of notebook.groups) {
        const existedBefore = prev.notebook.groups.some((p) => p.id === g.id);
        if (existedBefore ? prev.kwicEnabledSeries.has(g.id) : true) nextEnabled.add(g.id);
      }
      const stillFocused = series.some((s) => s.id === prev.focusedSeries);
      set({
        notebook,
        activeGroupIds: active,
        soloGroupId: solo,
        styleSlots,
        series,
        notebookError: null,
        kwicEnabledSeries: nextEnabled,
        focusedSeries: stillFocused ? prev.focusedSeries : series[0]?.id ?? null,
      });
      if (opts.reissue && effectiveIntentKey(notebook, series, nextEnabled) !== prevIntent) {
        get().runQueries();
      }
    };

    /** Refuse a notebook action with one bounded message (no state change). */
    const refuseNotebook = (message: string): void => set({ notebookError: message });

    // The store starts EMPTY — the demo notebook is the composition root's
    // seeding decision (store-instance.ts), not baked model state.
    return {
      bootstrap: { phase: 'initializing' },
      projectSession: null,
      snapshot: null,
      loadingPhase: null,
      loadError: null,
      commandError: null,
      notebook: { schema: 'texttrends/query-notebook/1', groups: [] },
      activeGroupIds: new Set<string>(),
      soloGroupId: null,
      styleSlots: new Map<string, number>(),
      notebookError: null,
      series: [],
      inputError: null,
      // Canonical from the start: the store, not the panels, decides the
      // default focus (review round 5 — a derived fallback left the pressed
      // chip and the recorded focus disagreeing).
      focusedSeries: null,
      trends: new Map(),
      kwic: null,
      // Every term appears in the concordance by default.
      kwicEnabledSeries: new Set<string>(),
      dispersion: null,
      linkedSelection: null,
      selectedTrends: new Map(),
      selectedDispersion: null,
      inventory: null,
      frequencyView: {
        schema: 'texttrends/frequency-view/1',
        minCount: 1,
        minDocFreq: 1,
        classes: ['lexical'],
        sort: { by: 'count', dir: -1 },
        page: { offset: 0, limit: 100 },
      },
      frequency: null,
      tfidf: null,
      trendView: 'series',
      focusedDoc: null,
      structure: null,
      editContext: null,
      lineExcerpt: null,
      sectionMarks: false,
      scrub: null,
      passage: null,
      pins: [],
      focusedPinId: null,
      pinError: null,
      pinAnnouncement: null,
      readerPlace: null,
      readerPage: null,
      readerNavigation: null,

      quickAdd(input) {
        const state = get();
        const room = Math.min(
          NOTEBOOK_LIMITS_V1.maxGroups - state.notebook.groups.length,
          MAX_SERIES - state.activeGroupIds.size,
        );
        const parsed = parseQuickAdd(input, newId, Math.max(0, room), state.notebook.groups);
        if (parsed.error !== null) {
          // ATOMIC refusal: the existing notebook and its evidence stand
          // untouched beside the message (append-only — a refused add never
          // clears anything).
          set({ inputError: parsed.error });
          return;
        }
        set({ inputError: null });
        if (parsed.groups.length === 0) return; // blank or all-duplicates: no-op
        const notebook: QueryNotebookV1 = {
          schema: 'texttrends/query-notebook/1',
          groups: [...state.notebook.groups, ...parsed.groups],
        };
        const active = new Set(state.activeGroupIds);
        for (const g of parsed.groups) active.add(g.id); // room was preflighted
        adoptNotebook({ notebook, activeGroupIds: active }, { reissue: true });
      },

      // ── Notebook authoring actions (commit B: model only; UI lands with
      //    the panel). Every action leaves invariants via adoptNotebook. ──
      renameGroup(groupId, name) {
        const nb = get().notebook;
        const g = nb.groups.find((x) => x.id === groupId);
        if (!g) return;
        const renamed = { ...g, name };
        try {
          validateNotebookGroup(renamed);
        } catch (e) {
          refuseNotebook(msg(e));
          return;
        }
        const notebook: QueryNotebookV1 = { ...nb, groups: nb.groups.map((x) => (x.id === groupId ? renamed : x)) };
        // Presentation-only: labels update, NO worker request (invariant 2).
        adoptNotebook({ notebook }, { reissue: false });
      },

      setGroupMembers(groupId, members, countOverlaps) {
        const nb = get().notebook;
        const g = nb.groups.find((x) => x.id === groupId);
        if (!g) return;
        const edited = { ...g, members, countOverlaps };
        try {
          validateNotebookGroup(edited);
        } catch (e) {
          refuseNotebook(msg(e));
          return;
        }
        const changed = groupIdentity(edited) !== groupIdentity(g);
        const notebook: QueryNotebookV1 = { ...nb, groups: nb.groups.map((x) => (x.id === groupId ? edited : x)) };
        // A semantic edit preserves the UUID but invalidates and reissues the
        // evidence (invariant 3); an identity-neutral edit reissues nothing.
        adoptNotebook({ notebook }, { reissue: changed });
      },

      removeGroup(groupId) {
        const nb = get().notebook;
        if (!nb.groups.some((x) => x.id === groupId)) return;
        const notebook: QueryNotebookV1 = { ...nb, groups: nb.groups.filter((x) => x.id !== groupId) };
        const wasProjected = get().series.some((s) => s.id === groupId);
        adoptNotebook({ notebook }, { reissue: wasProjected });
      },

      reorderGroups(order) {
        const nb = get().notebook;
        const byId = new Map(nb.groups.map((g) => [g.id, g]));
        // A total permutation of the CURRENT groups, or the action is refused
        // (a stale drag must not drop groups).
        if (order.length !== nb.groups.length || new Set(order).size !== order.length ||
          order.some((id) => !byId.has(id))) {
          refuseNotebook('reorder must name every group exactly once');
          return;
        }
        const notebook: QueryNotebookV1 = { ...nb, groups: order.map((id) => byId.get(id)!) };
        // Presentation-only (invariant 2): order/labels move, slots and
        // results stay; occurrence work is not reissued.
        adoptNotebook({ notebook }, { reissue: false });
      },

      setGroupActive(groupId, active) {
        const state = get();
        if (!state.notebook.groups.some((x) => x.id === groupId)) return;
        const has = state.activeGroupIds.has(groupId);
        if (active === has) return;
        if (active && state.activeGroupIds.size >= MAX_SERIES) {
          // EXPLICIT refusal, never silent truncation (invariant 5).
          refuseNotebook(`Compare up to ${MAX_SERIES} groups — deactivate one first`);
          return;
        }
        const next = new Set(state.activeGroupIds);
        if (active) next.add(groupId);
        else next.delete(groupId);
        adoptNotebook({ activeGroupIds: next }, { reissue: true });
      },

      setSolo(groupId) {
        const state = get();
        if (groupId !== null && !state.activeGroupIds.has(groupId)) {
          refuseNotebook('solo is only available for an active group');
          return;
        }
        if (state.soloGroupId === groupId) return;
        adoptNotebook({ soloGroupId: groupId }, { reissue: true });
      },

      clearNotebookError() {
        set({ notebookError: null });
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
        get().runTfidf(); // full-document chapter labels, independent of brush/notebook
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

      pinPassage(doc, token) {
        const { snapshot, pins, passage, series } = get();
        if (
          !snapshot
          || !snapshot.readyDocs.includes(doc)
          || !Number.isSafeInteger(token)
          || token < 0
        ) return;
        const tokenCount = docTokenCountOf(doc);
        if (tokenCount !== null && token >= tokenCount) return;
        const anchor: PinAnchor = { snapshot: snapshot.snapshot, doc, token };
        const duplicate = pins.find((pin) => samePinAnchor(pin.anchor, anchor));
        if (duplicate) {
          set({
            focusedPinId: duplicate.id,
            pinError: null,
            pinAnnouncement: 'That position is already pinned; focused the existing evidence.',
          });
          return;
        }
        if (pins.length >= MAX_PINNED_SNIPPETS) {
          set({
            pinError: `Pinned evidence is limited to ${MAX_PINNED_SNIPPETS} — remove one first.`,
            pinAnnouncement: null,
          });
          return;
        }
        const request = trackSpecs(series);
        if (request === null) return;
        const id = newId();
        if (canReusePassage(passage, anchor, snapshot.snapshot, request.captured)) {
          const evidence = evidenceFrom(passage.result, token);
          if (evidence !== null) {
            const ready: PinnedSnippet = Object.freeze({
              kind: 'ready',
              id,
              anchor: Object.freeze(anchor),
              tracks: request.captured,
              evidence,
            });
            set({
              pins: [...pins, ready],
              focusedPinId: id,
              pinError: null,
              pinAnnouncement: 'Pinned the loaded passage.',
            });
            return;
          }
        }
        const pending: PinnedSnippet = Object.freeze({
          kind: 'pending',
          id,
          anchor: Object.freeze(anchor),
          tracks: request.captured,
        });
        set({
          pins: [...pins, pending],
          focusedPinId: id,
          pinError: null,
          pinAnnouncement: 'Capturing pinned evidence.',
        });
        issuePin(id, anchor, request.captured, request.wire);
      },

      removePin(id) {
        try {
          pinCancels.get(id)?.();
        } catch {
          // Best-effort transport cleanup; ownership invalidation is authority.
        }
        pinCancels.delete(id);
        pinRequests.delete(id);
        pinOps.invalidate(id);
        set((state) => {
          const index = state.pins.findIndex((pin) => pin.id === id);
          const pins = state.pins.filter((pin) => pin.id !== id);
          const neighbour =
            index < 0 || pins.length === 0
              ? null
              : pins[Math.min(index, pins.length - 1)]?.id ?? null;
          return {
            pins,
            focusedPinId: state.focusedPinId === id ? neighbour : state.focusedPinId,
            pinError: null,
            pinAnnouncement: 'Removed pinned evidence.',
          };
        });
      },

      retryPin(id) {
        const pin = get().pins.find((candidate) => candidate.id === id);
        const request = pinRequests.get(id);
        if (!pin || pin.kind !== 'error' || !request) return;
        replacePin(id, () => ({
          kind: 'pending',
          id: pin.id,
          anchor: pin.anchor,
          tracks: pin.tracks,
        }));
        set({ focusedPinId: id, pinError: null, pinAnnouncement: 'Retrying pinned evidence.' });
        issuePin(id, pin.anchor, request.tracks, request.wire);
      },

      focusPin(id) {
        if (!get().pins.some((pin) => pin.id === id)) return;
        set({ focusedPinId: id, pinAnnouncement: 'Focused pinned evidence.' });
      },

      clearPinError() {
        set({ pinError: null });
      },

      openReader(intent) {
        const snapshot = get().snapshot;
        const place = readerPlaceFor(
          intent,
          snapshot?.snapshot ?? null,
          snapshot?.readyDocs ?? [],
        );
        if (place) {
          set({ readerPlace: place, readerNavigation: null });
          get().runReader();
        }
      },

      navigateReader(cursor) {
        const { readerPlace: place, readerNavigation: navigation } = get();
        if (
          !place
          || !navigation
          || (
            !sameReaderCursor(cursor, navigation.previous)
            && !sameReaderCursor(cursor, navigation.next)
          )
          || sameReaderCursor(cursor, place.cursor)
        ) return;
        if (
          !Number.isSafeInteger(cursor.token)
          || cursor.token < 0
          || (cursor.kind === 'before' && cursor.token < 1)
        ) return;
        set({ readerPlace: { ...place, cursor: { ...cursor } } });
        get().runReader();
      },

      retryReader() {
        if (get().readerPlace) get().runReader();
      },

      closeReader() {
        readerLane.supersede();
        set({ readerPlace: null, readerPage: null, readerNavigation: null });
      },

      runReader() {
        readerLane.supersede();
        const { snapshot, readerPlace: place, series } = get();
        if (
          !snapshot
          || !place
          || place.snapshot !== snapshot.snapshot
          || !snapshot.readyDocs.includes(place.doc)
        ) {
          set({ readerPage: null });
          return;
        }
        const tracks = trackSpecs(series);
        if (tracks === null) {
          set({ readerPage: null });
          return;
        }
        const issuedKey = snapKey(snapshot);
        const issuedPlace = place;
        const lease = readerLane.ops.begin(
          () => snapKey(get().snapshot) === issuedKey,
          () => sameReaderPlace(get().readerPlace, issuedPlace),
          () => identitiesCurrent(tracks.identities),
        );
        set({
          readerPage: {
            snapshot: snapshot.snapshot,
            place: issuedPlace,
            tracks: tracks.captured,
            state: { status: 'pending' },
          },
        });
        issueOn(
          readerLane,
          snapshot.snapshot,
          {
            op: 'reader-page',
            tracks: tracks.wire,
            request: {
              method: 'reader-page/1',
              doc: issuedPlace.doc,
              cursor: issuedPlace.cursor,
              maxTokens: READER_MAX_TOKENS,
            },
          },
          lease,
          (data) => {
            if (data.op !== 'reader-page') return;
            if (data.page.doc !== issuedPlace.doc) {
              set({
                readerPage: {
                  snapshot: snapshot.snapshot,
                  place: issuedPlace,
                  tracks: tracks.captured,
                  state: { status: 'error', message: 'reader returned the wrong document' },
                },
              });
              return;
            }
            set({
              readerPage: {
                snapshot: snapshot.snapshot,
                place: issuedPlace,
                tracks: tracks.captured,
                state: { status: 'ready', page: data.page },
              },
              readerNavigation: {
                previous: data.page.previous,
                next: data.page.next,
              },
            });
          },
          (message) => set({
            readerPage: {
              snapshot: snapshot.snapshot,
              place: issuedPlace,
              tracks: tracks.captured,
              state: { status: 'error', message },
            },
          }),
        );
      },

      revalidatePins() {
        const state = get();
        const liveSnapshot = state.snapshot?.snapshot ?? null;
        const readyDocs = state.snapshot?.readyDocs ?? [];
        const dead = state.pins.filter(
          (pin) =>
            pin.anchor.snapshot !== liveSnapshot
            || !readyDocs.includes(pin.anchor.doc),
        );
        for (const pin of dead) {
          try {
            pinCancels.get(pin.id)?.();
          } catch {
            // Lease invalidation below remains authoritative.
          }
          pinCancels.delete(pin.id);
          pinRequests.delete(pin.id);
          pinOps.invalidate(pin.id);
        }
        const readerLive =
          state.readerPlace !== null
          && state.readerPlace.snapshot === liveSnapshot
          && readyDocs.includes(state.readerPlace.doc);
        if (dead.length > 0 || (!readerLive && state.readerPlace !== null)) {
          const deadIds = new Set(dead.map((pin) => pin.id));
          set({
            pins: state.pins.filter((pin) => !deadIds.has(pin.id)),
            focusedPinId: deadIds.has(state.focusedPinId ?? '') ? null : state.focusedPinId,
            pinError: null,
            pinAnnouncement: dead.length > 0 ? 'Cleared pins from the replaced snapshot.' : state.pinAnnouncement,
            readerPlace: readerLive ? state.readerPlace : null,
            readerPage: readerLive ? state.readerPage : null,
            readerNavigation: readerLive ? state.readerNavigation : null,
          });
        }
      },

      runQueries() {
        const { snapshot, series } = get();
        // Reader highlights use the CURRENT semantic active-track projection;
        // rename-only notebook edits do not call runQueries and remain
        // presentation-only, while active/member/overlap changes reissue here.
        get().runReader();
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
        dispersionLane.supersede();
        // A published snapshot replacement invalidates the (snapshot-bound)
        // linked range; runSelected below clears the overlays with it.
        if (get().linkedSelection !== null
          && (!snapshot || !isValidSelection(get().linkedSelection!, snapshot.snapshot, snapshot.readyDocs))) {
          set({ linkedSelection: null });
        }
        if (!snapshot || series.length === 0) {
          // Unlike removal, deactivating the final group leaves its notebook
          // identity valid. Kill selected leases explicitly before this early
          // return or their late results could repopulate the cleared overlays.
          selectedTrendLane.supersede();
          selectedDispersionLane.supersede();
          set({ trends: new Map(), scrub: null, dispersion: null, selectedTrends: new Map(), selectedDispersion: null });
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
          const spec = specFor(s.id);
          if (spec === null) continue; // vanished mid-burst: superseded intent
          const issuedIdentity = termGroupIdentity(spec);
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
              group: spec,
              request: { coordinate: 'declared-sequence', binsPerDoc: BINS },
            },
            lease,
            (data) => {
              // Commit only under the ISSUED matching semantics (invariant 4):
              // a member edit under the same UUID kills the old result even if
              // a reissue were somehow missed.
              if (data.op === 'trend' && identityOf(s.id) === issuedIdentity) write({ status: 'ready', trend: data.trend });
            },
            // A genuine failure must mark ITS series, not silently vanish —
            // and must not erase successful peers.
            (message) => {
              if (identityOf(s.id) === issuedIdentity) write({ status: 'error', message });
            },
          );
        }

        // The barcode rides the SAME burst/guards as the trends: one
        // dispersion query for the whole effective comparison.
        dispersionLane.supersede();
        const dTracks = trackSpecs(series);
        if (dTracks !== null) {
          const dLease = dispersionLane.ops.begin(
            () => snapKey(get().snapshot) === issuedKey,
            () => identitiesCurrent(dTracks.identities),
          );
          set({
            dispersion: {
              snapshot: issuedSnapshot,
              state: { status: 'pending' },
            },
          });
          issueOn(
            dispersionLane,
            issuedSnapshot,
            {
              op: 'dispersion',
              selection: { docs: [...snapshot.readyDocs] },
              tracks: dTracks.wire,
              request: { method: 'dispersion/1', exactMax: DISPERSION_EXACT_MAX, bucketBudget: DISPERSION_BUCKET_BUDGET },
            },
            dLease,
            (data) => {
              if (data.op === 'dispersion') {
                set({
                  dispersion: {
                    snapshot: issuedSnapshot,
                    state: { status: 'ready', result: data.dispersion },
                  },
                });
              }
            },
            (message) => set({
              dispersion: {
                snapshot: issuedSnapshot,
                state: { status: 'error', message },
              },
            }),
          );
        }

        // The selected overlays follow the same burst (a snapshot change or
        // comparison change either revalidates or clears them).
        runSelected();
        runKwic();
      },

      runInventory() {
        inventoryLane.supersede();
        const { snapshot, linkedSelection } = get();
        if (!snapshot) {
          set({ inventory: null });
          return;
        }
        const issuedKey = snapKey(snapshot);
        const issuedSelection = linkedSelection;
        const lease = inventoryLane.ops.begin(
          () => snapKey(get().snapshot) === issuedKey,
          () => get().linkedSelection === issuedSelection,
        );
        set({
          inventory: {
            snapshot: snapshot.snapshot,
            selection: issuedSelection,
            state: { status: 'pending' },
          },
        });
        issueOn(
          inventoryLane,
          snapshot.snapshot,
          {
            op: 'inventory',
            selection: detailSelection(snapshot.readyDocs, issuedSelection),
            request: {
              method: 'inventory/1',
              rhythmBinsPerDoc: INVENTORY_RHYTHM_BINS,
              growthPoints: INVENTORY_GROWTH_POINTS,
              sections: true,
              mattrWindow: INVENTORY_MATTR_WINDOW,
            },
          },
          lease,
          (data) => {
            if (data.op !== 'inventory') return;
            set({
              inventory: {
                snapshot: snapshot.snapshot,
                selection: issuedSelection,
                state: { status: 'ready', result: data.inventory },
              },
            });
          },
          (message) => set({
            inventory: {
              snapshot: snapshot.snapshot,
              selection: issuedSelection,
              state: { status: 'error', message },
            },
          }),
        );
      },

      runFrequency() {
        frequencyLane.supersede();
        const { snapshot, linkedSelection, frequencyView } = get();
        if (!snapshot) {
          set({ frequency: null });
          return;
        }
        const issuedKey = snapKey(snapshot);
        const issuedSelection = linkedSelection;
        const issuedView = frequencyView;
        const lease = frequencyLane.ops.begin(
          () => snapKey(get().snapshot) === issuedKey,
          () => get().linkedSelection === issuedSelection,
          () => get().frequencyView === issuedView,
        );
        set({
          frequency: {
            snapshot: snapshot.snapshot,
            selection: issuedSelection,
            view: issuedView,
            state: { status: 'pending' },
          },
        });
        issueOn(
          frequencyLane,
          snapshot.snapshot,
          {
            op: 'freq-list',
            selection: detailSelection(snapshot.readyDocs, issuedSelection),
            request: {
              method: 'freq-list/1',
              filter: {
                minCount: issuedView.minCount,
                minDocFreq: issuedView.minDocFreq,
                classes: issuedView.classes,
                ...(issuedView.prefixNfc === undefined
                  ? {}
                  : { prefixNfc: issuedView.prefixNfc }),
              },
              sort: issuedView.sort,
              page: issuedView.page,
              dispersion: true,
            },
          },
          lease,
          (data) => {
            if (data.op !== 'freq-list') return;
            set({
              frequency: {
                snapshot: snapshot.snapshot,
                selection: issuedSelection,
                view: issuedView,
                state: { status: 'ready', result: data.frequency },
              },
            });
          },
          (message) => set({
            frequency: {
              snapshot: snapshot.snapshot,
              selection: issuedSelection,
              view: issuedView,
              state: { status: 'error', message },
            },
          }),
        );
      },

      runTfidf() {
        tfidfLane.supersede();
        const { snapshot, focusedDoc } = get();
        if (!snapshot || !focusedDoc || !snapshot.readyDocs.includes(focusedDoc)) {
          set({ tfidf: null });
          return;
        }
        const issuedKey = snapKey(snapshot);
        const issuedDoc = focusedDoc;
        const lease = tfidfLane.ops.begin(
          () => snapKey(get().snapshot) === issuedKey,
          () => get().focusedDoc === issuedDoc,
        );
        set({
          tfidf: {
            snapshot: snapshot.snapshot,
            doc: issuedDoc,
            state: { status: 'pending' },
          },
        });
        issueOn(
          tfidfLane,
          snapshot.snapshot,
          {
            op: 'tfidf-sections',
            request: {
              method: 'tfidf-sections/1',
              doc: issuedDoc,
              level: 1,
              minSectionTokens: TFIDF_SECTION_MIN_TOKENS,
              topK: TFIDF_TOP_K,
            },
          },
          lease,
          (data) => {
            if (data.op !== 'tfidf-sections') return;
            set({
              tfidf: {
                snapshot: snapshot.snapshot,
                doc: issuedDoc,
                state: { status: 'ready', result: data.tfidf },
              },
            });
          },
          (message) => set({
            tfidf: {
              snapshot: snapshot.snapshot,
              doc: issuedDoc,
              state: { status: 'error', message },
            },
          }),
        );
      },

      setFrequencySort(by) {
        const current = get().frequencyView;
        const dir = current.sort.by === by
          ? (current.sort.dir === 1 ? -1 : 1)
          : (by === 'key' ? 1 : -1);
        set({
          frequencyView: {
            ...current,
            sort: { by, dir },
            page: { ...current.page, offset: 0 },
          },
        });
        get().runFrequency();
      },

      setFrequencyPrefix(prefix) {
        get().setFrequencyFilter(
          get().frequencyView.minCount,
          get().frequencyView.minDocFreq,
          prefix,
        );
      },

      setFrequencyFilter(minCount, minDocFreq, prefix) {
        const normalized = prefix.trim().normalize('NFC');
        const current = get().frequencyView;
        if (
          !Number.isSafeInteger(minCount) ||
          minCount < 1 ||
          !Number.isSafeInteger(minDocFreq) ||
          minDocFreq < 1 ||
          normalized.length > FREQUENCY_PREFIX_MAX_UNITS
        ) {
          return;
        }
        const { prefixNfc: _oldPrefix, ...withoutPrefix } = current;
        set({
          frequencyView: normalized === ''
            ? {
                ...withoutPrefix,
                minCount,
                minDocFreq,
                page: { ...current.page, offset: 0 },
              }
            : {
                ...current,
                minCount,
                minDocFreq,
                prefixNfc: normalized,
                page: { ...current.page, offset: 0 },
              },
        });
        get().runFrequency();
      },

      setFrequencyClasses(classes) {
        const unique = [...new Set(classes)].filter(
          (value): value is FrequencyTokenClassV1 =>
            value === 'lexical' || value === 'numeral',
        );
        if (unique.length === 0) return;
        const current = get().frequencyView;
        set({
          frequencyView: {
            ...current,
            classes: unique,
            page: { ...current.page, offset: 0 },
          },
        });
        get().runFrequency();
      },

      setFrequencyPage(offset) {
        const current = get().frequencyView;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset + current.page.limit > FREQUENCY_WINDOW_MAX
        ) {
          return;
        }
        set({
          frequencyView: {
            ...current,
            page: { ...current.page, offset },
          },
        });
        get().runFrequency();
      },

      setFrequencyPageSize(limit) {
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > FREQUENCY_PAGE_MAX
        ) {
          return;
        }
        const current = get().frequencyView;
        set({
          frequencyView: {
            ...current,
            page: { offset: 0, limit },
          },
        });
        get().runFrequency();
      },

      addFrequencyTerm(key) {
        const label = key.normalize('NFC');
        const state = get();
        if (
          state.notebook.groups.length >= NOTEBOOK_LIMITS_V1.maxGroups ||
          state.activeGroupIds.size >= MAX_SERIES
        ) {
          refuseNotebook('deactivate a group before adding this frequency-table term');
          return;
        }
        const probe = {
          id: 'probe',
          name: label,
          members: [{
            id: 'member',
            kind: 'token' as const,
            surface: label,
            match: { case: 'sensitive' as const, diacritics: 'sensitive' as const },
          }],
          countOverlaps: false,
        };
        if (state.notebook.groups.some((group) => groupIdentity(group) === groupIdentity(probe))) {
          refuseNotebook('that exact term is already in the notebook');
          return;
        }
        const group = {
          ...probe,
          id: newId(),
          members: [{ ...probe.members[0]!, id: newId() }],
        };
        try {
          validateNotebookGroup(group);
        } catch (e) {
          refuseNotebook(msg(e));
          return;
        }
        const notebook: QueryNotebookV1 = {
          schema: 'texttrends/query-notebook/1',
          groups: [...state.notebook.groups, group],
        };
        const active = new Set(state.activeGroupIds);
        active.add(group.id);
        adoptNotebook({ notebook, activeGroupIds: active }, { reissue: true });
      },

      showFrequencyTermInKwic(key) {
        const label = key.normalize('NFC');
        const probe = {
          id: 'probe',
          name: label,
          members: [{
            id: 'member',
            kind: 'token' as const,
            surface: label,
            match: { case: 'sensitive' as const, diacritics: 'sensitive' as const },
          }],
          countOverlaps: false,
        };
        const state = get();
        const group = state.notebook.groups.find(
          (candidate) => groupIdentity(candidate) === groupIdentity(probe),
        );
        if (!group) {
          get().addFrequencyTerm(key);
          return;
        }
        if (!state.activeGroupIds.has(group.id) && state.activeGroupIds.size >= MAX_SERIES) {
          refuseNotebook('deactivate a group before showing this term in the concordance');
          return;
        }
        const active = new Set(state.activeGroupIds);
        active.add(group.id);
        adoptNotebook({ activeGroupIds: active, soloGroupId: null }, { reissue: true });
        if (!get().kwicEnabledSeries.has(group.id)) get().toggleKwicSeries(group.id);
        get().setFocus(group.id);
      },

      setLinkedSelection(selection) {
        const { snapshot } = get();
        if (selection !== null
          && (!snapshot || !isValidSelection(selection, snapshot.snapshot, snapshot.readyDocs))) {
          return; // a stale gesture (superseded snapshot / departed doc) commits nothing
        }
        if (get().linkedSelection === selection) return;
        set({ linkedSelection: selection });
        // Detail consumers reissue; the resident BASELINE trends/dispersion
        // are untouched (clearing a brush must not recompute them).
        runSelected();
        runKwic();
        get().runInventory();
        get().runFrequency();
      },

      centerKwicAt(seriesId, doc, token, origin) {
        const state = get();
        if (!state.snapshot?.readyDocs.includes(doc)) return;
        // A DELIBERATE click outside the active range clears the range first
        // (visibly — the shading and overlays drop) so the clicked evidence
        // can appear in the range-scoped concordance (ruling §2).
        const sel = state.linkedSelection;
        if (sel !== null && (doc !== sel.doc || token < sel.tokens.start || token >= sel.tokens.end)) {
          set({ linkedSelection: null });
          runSelected();
        }
        // The activated track must be able to appear in the result: a
        // disabled chip is re-enabled (visible state change, not a silent
        // override) before the reissue (review-D HIGH).
        if (state.series.some((s) => s.id === seriesId) && !state.kwicEnabledSeries.has(seriesId)) {
          const next = new Set(state.kwicEnabledSeries);
          next.add(seriesId);
          set({ kwicEnabledSeries: next });
        }
        // IMMEDIATE evidence: cancel any pending debounce and adopt the
        // position as the concordance center (like the chip toggle path).
        if (kwicCenterTimer !== null) { clearTimeout(kwicCenterTimer); kwicCenterTimer = null; }
        kwicCenter = origin ? { doc, token, origin: 'bucket', bucketCount: origin.count } : { doc, token };
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
      readerLane.supersede();
      if (store.getState().editContext !== null || store.getState().lineExcerpt !== null) {
        store.setState({ editContext: null, lineExcerpt: null });
      }
      store.getState().revalidatePins();
      store.getState().runQueries();
      store.getState().runStructure();
      store.getState().runInventory();
      store.getState().runFrequency();
      store.getState().runTfidf();
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
      dispersionLane.supersede();
      selectedTrendLane.supersede();
      selectedDispersionLane.supersede();
      inventoryLane.supersede();
      frequencyLane.supersede();
      tfidfLane.supersede();
      editContextLane.supersede();
      lineExcerptLane.supersede();
      readerLane.supersede();
      passageActiveCancel?.();
      passageActiveCancel = null;
      passagePending = null;
      for (const cancel of pinCancels.values()) {
        try {
          cancel();
        } catch {
          // Scope closure already killed ownership; transport is best effort.
        }
      }
      pinCancels.clear();
      pinRequests.clear();
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
