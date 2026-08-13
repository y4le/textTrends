/**
 * UI state — zustand. Only handles, metadata, and bounded
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
 * so components talk only to the store. Query and concordance work stay here:
 * they are
 * request/response operations, not competing listeners.
 *
 * Query-notebook intent (slice-1 notebook ruling):
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
  canonicalJson,
  DISPERSION_BUCKET_BUDGET,
  DISPERSION_EXACT_MAX,
  FREQUENCY_PAGE_MAX,
  FREQUENCY_PREFIX_MAX_UNITS,
  FREQUENCY_WINDOW_MAX,
  MAX_KWIC_TRACKS,
  parseWorkspaceTrendView,
  TREND_MAX_ROWS,
  TREND_RATE_DENOMINATOR,
  termGroupIdentity,
  type GroupMember,
  type NumericTrend,
  type TermGroupSpec,
  type TrendBinsSpecV1,
  type WorkspaceDocumentMetaV1,
  type WorkspaceTrendMeasureV1,
  type WorkspaceV1,
} from '@texttrends/core';

import {
  detailSelection,
  isValidSelection,
  selectionContains,
  type TokenRangeSelectionV1,
} from './selection.ts';
import { fullTokenCountsForDocs } from './doc-tokens.ts';
import { trendBinLimits } from './trend-settings.ts';
import type { CapturedTrack } from './track-legend.ts';
import {
  footerPassageServes,
} from './footer-view.ts';
import {
  liveReaderPlace,
  readerPlaceFor,
  sameReaderCursor,
  sameReaderPlace,
  type ReaderOpenIntent,
  type ReaderPlace,
} from './reader-intent.ts';
import {
  coreGroupOf,
  firstFreeStyle,
  groupIdentity,
  groupTitle,
  NOTEBOOK_LIMITS_V1,
  parseQuickAdd,
  resolveActiveStyleCollisions,
  styleKey,
  validateNotebookGroup,
  type NotebookGroupV1,
  type QueryNotebookV1,
  type SeriesStyleV1,
} from './notebook.ts';
import { isCancelled, WorkerClientError } from './client.ts';
import type { SnapshotInfo } from './client.ts';
import {
  LatestOperation,
  OperationScope,
  type OperationLease,
} from './operation-lease.ts';
import type {
  DispersionResultV1,
  QueryOpV4,
  QueryResultDataV4,
  ReaderPageResultV1,
  InventoryResultV1,
  FrequencyListResultV1,
  FrequencySortFieldV1,
  FrequencyTokenClassV1,
  KeynessResultV1,
  KeynessSortFieldV1,
  OccurrenceStepHitV1,
  WireSelectionV4,
} from '../shared/analysis-contract.ts';
import {
  SessionCommandError,
  type AnalysisPhase,
  type SessionState,
} from './project-session.ts';
import type { LocalLibraryFile } from './local-library.ts';
import {
  historyStateFor,
  parseLayerHistory,
  pushLayer as pushLayerStack,
  reconcileLayerRefs,
  replaceTopLayer,
  type Layer,
  type LayerKind,
} from './layers.ts';
import {
  DEFAULT_ROUTE,
  parseRoute,
  routeSearch,
} from './route.ts';
import type { HistoryPort } from './history-port.ts';
import { PLACES, type Place } from './places.ts';
import { builtinCorpusOption, type BuiltinCorpusId } from './project.ts';

/** Source budgets are call-site intent, not the worker's protocol ceiling.
 * The footer is latency-sensitive and only renders one clipped passage; the
 * full Reader gets a larger reservoir for browser-measured pages. */
const FOOTER_PASSAGE_MAX_TOKENS = 400;
const READER_SOURCE_MAX_TOKENS = 4_096;

export interface KwicRowView {
  /** The series (track) that produced this row — the merged concordance tags
   *  each occurrence so the panel can colour and label it. */
  readonly seriesId: string;
  /** Wire provenance retained for occurrence identity (commit D): under
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

/** The full occurrence key of a concordance row — stable and collision-free
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
export const DEFAULT_TREND_BINS: TrendBinsSpecV1 = Object.freeze({
  mode: 'per-doc',
  count: 40,
});
export const DEFAULT_TREND_MEASURE: WorkspaceTrendMeasureV1 = Object.freeze({
  kind: 'rate',
  denominator: TREND_RATE_DENOMINATOR,
  smoothing: 0,
  showRaw: false,
});
export const INVENTORY_RHYTHM_BINS = 24;
export const INVENTORY_GROWTH_POINTS = 128;
export const INVENTORY_MATTR_WINDOW = 500;

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
  /** Authored visual style (color + dash) — owned by the group, preserved
   *  through rename/edit/reorder/mute, freed on removal. */
  readonly style: SeriesStyleV1;
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

/** The smaller token range the browser actually proved visible at the current
 * Reader geometry. Worker slices are reservoirs; this is the presentation
 * truth used by labels and navigation. */
export interface ReaderVisibleRangeV1 {
  readonly snapshot: string;
  readonly doc: string;
  readonly tokens: { readonly start: number; readonly end: number };
  readonly geometry: string;
}

/** One fitted-page destination. Document identity is explicit so page turns
 * can cross corpus text boundaries without overloading token cursors. */
export interface ReaderNavigationTarget {
  readonly doc: string;
  readonly cursor: ReaderPlace['cursor'];
}

/** The reading footer's authenticated source slice. It deliberately has its own
 * lane: Reader paging must never move or blank the workbench footer. */
export interface FooterPassageState {
  readonly snapshot: string;
  readonly doc: string;
  readonly tracks: readonly CapturedTrack[];
  /** Last authenticated page, retained across a newer in-flight request. */
  readonly page: ReaderPageResultV1 | null;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready' }
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

export interface FrequencyViewInputV1 {
  readonly minCount: number;
  readonly minDocFreq: number;
  readonly classes: readonly FrequencyTokenClassV1[];
  readonly prefix: string;
  readonly sort: { readonly by: FrequencySortFieldV1; readonly dir: 1 | -1 };
  readonly pageLimit: number;
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

export interface KeynessViewV1 {
  readonly schema: 'texttrends/keyness-view/1';
  readonly mode: 'documents' | 'document-rest';
  readonly documentA: string | null;
  readonly documentB: string | null;
  /** In document-rest mode, which table contains the complement corpus. */
  readonly restOn: 'a' | 'b';
  readonly minCountTotal: number;
  readonly minDocFreqTotal: number;
  readonly classes: readonly FrequencyTokenClassV1[];
  readonly sort: {
    readonly by: KeynessSortFieldV1;
    readonly dirA: 1 | -1;
    readonly dirB: 1 | -1;
  };
  readonly pageLimit: number;
  readonly offsetA: number;
  readonly offsetB: number;
}

export interface KeynessSettingsInputV1 {
  readonly minCountTotal: number;
  readonly minDocFreqTotal: number;
  readonly classes: readonly FrequencyTokenClassV1[];
  readonly sortBy: KeynessSortFieldV1;
  readonly pageLimit: number;
}

export interface KeynessTableState {
  readonly snapshot: string;
  readonly side: 'a' | 'b';
  readonly view: KeynessViewV1;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly result: KeynessResultV1 }
    | { readonly status: 'error'; readonly message: string };
}

export interface KeynessInventoryState {
  readonly snapshot: string;
  readonly side: 'a' | 'b';
  readonly view: KeynessViewV1;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly result: InventoryResultV1 }
    | { readonly status: 'error'; readonly message: string };
}

export const DEFAULT_KEYNESS_VIEW: KeynessViewV1 = Object.freeze({
  schema: 'texttrends/keyness-view/1',
  mode: 'documents',
  documentA: null,
  documentB: null,
  restOn: 'b',
  minCountTotal: 5,
  minDocFreqTotal: 2,
  classes: Object.freeze(['lexical'] as const),
  sort: Object.freeze({
    by: 'logRatio' as const,
    dirA: -1 as const,
    dirB: 1 as const,
  }),
  pageLimit: 100,
  offsetA: 0,
  offsetB: 0,
});

export function reconcileKeynessView(
  view: KeynessViewV1,
  readyDocs: readonly string[],
): KeynessViewV1 {
  const documentA = view.documentA !== null && readyDocs.includes(view.documentA)
    ? view.documentA
    : readyDocs[0] ?? null;
  const documentB = view.documentB !== null
    && readyDocs.includes(view.documentB)
    && view.documentB !== documentA
    ? view.documentB
    : readyDocs.find((doc) => doc !== documentA) ?? null;
  if (documentA === view.documentA && documentB === view.documentB) return view;
  return { ...view, documentA, documentB };
}

export function keynessSelections(
  view: KeynessViewV1,
  readyDocs: readonly string[],
): { readonly a: WireSelectionV4; readonly b: WireSelectionV4 } | null {
  if (
    view.documentA === null ||
    view.documentB === null ||
    !readyDocs.includes(view.documentA) ||
    !readyDocs.includes(view.documentB) ||
    view.documentA === view.documentB
  ) {
    return null;
  }
  if (view.mode === 'documents') {
    return {
      a: { docs: [view.documentA] },
      b: { docs: [view.documentB] },
    };
  }
  if (view.restOn === 'b') {
    const rest = readyDocs.filter((doc) => doc !== view.documentA);
    return rest.length === 0
      ? null
      : { a: { docs: [view.documentA] }, b: { docs: rest } };
  }
  const rest = readyDocs.filter((doc) => doc !== view.documentB);
  return rest.length === 0
    ? null
    : { a: { docs: rest }, b: { docs: [view.documentB] } };
}

function keynessSideSelectionKey(
  view: KeynessViewV1,
  readyDocs: readonly string[],
  side: 'a' | 'b',
): string | null {
  const pair = keynessSelections(view, readyDocs);
  return pair ? JSON.stringify(pair[side]) : null;
}

function keynessTableIntentKey(
  view: KeynessViewV1,
  readyDocs: readonly string[],
  side: 'a' | 'b',
): string | null {
  const pair = keynessSelections(view, readyDocs);
  if (!pair) return null;
  return JSON.stringify([
    pair,
    view.minCountTotal,
    view.minDocFreqTotal,
    view.classes,
    { by: view.sort.by, dir: side === 'a' ? view.sort.dirA : view.sort.dirB },
    {
      offset: side === 'a' ? view.offsetA : view.offsetB,
      limit: view.pageLimit,
    },
    side,
  ]);
}

export type TrendView = 'series' | 'by-book';

export interface TrendSettingsInput {
  readonly bins: TrendBinsSpecV1;
  readonly measure: WorkspaceTrendMeasureV1;
}

export type TrendSettingsOutcome = 'applied' | 'unchanged' | 'rejected';

export interface RemovedNotebookGroup {
  readonly group: NotebookGroupV1;
  readonly index: number;
  readonly active: boolean;
  readonly kwicEnabled: boolean;
  readonly solo: boolean;
}

/** Concordance presentation intent. Reading mode and rendered context are
 * local presentation; occurrence order is always nearest reading position. */
export type ConcordanceReadingMode = 'aligned' | 'stacked';

export interface ConcordanceView {
  readonly contextChars: 12 | 24 | 38 | 60;
  readonly reading: ConcordanceReadingMode;
}

/** The scrubbed reading position — document-local, view-independent. */
export interface ScrubTarget {
  readonly doc: string;
  readonly token: number;
}

/** One exact focused-term navigation intent. The worker returns one bounded
 * distinct-start hit; raw overlap counts never become a misleading progress
 * readout. */
export interface OccurrenceNavigationState {
  readonly snapshot: string;
  readonly seriesId: string;
  readonly direction: 1 | -1;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly hit: OccurrenceStepHitV1 }
    | { readonly status: 'edge' }
    | { readonly status: 'error'; readonly message: string };
}

export function occurrenceNavigationText(
  navigation: OccurrenceNavigationState | null,
  series: readonly SeriesIntent[],
): string {
  if (navigation === null) return '';
  const label = series.find((item) => item.id === navigation.seriesId)?.label
    ?? 'focused term';
  const way = navigation.direction === 1 ? 'next' : 'previous';
  switch (navigation.state.status) {
    case 'pending': return `finding ${way} ${label} occurrence`;
    case 'ready': return `${way} ${label} occurrence`;
    case 'edge': return `no ${way} ${label} occurrence`;
    case 'error': return `${label} navigation failed: ${navigation.state.message}`;
    default: {
      const exhaustive: never = navigation.state;
      return exhaustive;
    }
  }
}

/** Bootstrap lifecycle, distinct from analysis state: the store is exported
 *  synchronously but the session needs the async-built built-in project, so
 *  there is a window before the one-shot attachment where no session exists.
 *  A construction/hashing failure here is NOT an analysis-generation failure. */
export type BootstrapState =
  | { readonly phase: 'initializing' }
  | { readonly phase: 'attached' }
  | { readonly phase: 'error'; readonly message: string };

export type WorkspacePersistenceState =
  | { readonly phase: 'idle' | 'dirty' | 'saving' | 'saved' }
  | { readonly phase: 'error'; readonly message: string };

export interface WorkspaceStorePort {
  saveWorkspace(workspace: WorkspaceV1): Promise<void>;
}

/** Descriptive metadata a component may patch (title/author/year/tags). */
export type MetaPatch = Partial<Pick<WorkspaceDocumentMetaV1, 'title' | 'author' | 'year' | 'tags'>>;

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
  openBuiltinProject(id: string): void;
  createLibraryCorpus(files: readonly LocalLibraryFile[]): void;
  appendFiles(files: readonly LocalLibraryFile[]): void;
  removeImport(doc: string): void;
  removeDocument(doc: string): void;
  removeDocuments(docs: readonly string[]): void;
  editMeta(doc: string, patch: MetaPatch): void;
  setLanguage(doc: string, language: string): void;
  reorder(order: readonly string[]): void;
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
   *  `projectSession`. */
  commandError: string | null;
  workspacePersistence: WorkspacePersistenceState;

  // ── Route/layer state: session presentation, never research data. ──
  place: Place;
  layers: readonly Layer[];
  setPlace(place: Place): void;
  pushLayer(
    kind: Exclude<LayerKind, 'place'>,
    target: unknown,
    returnFocusTo: string,
  ): void;
  replaceLayer(
    kind: Exclude<LayerKind, 'place'>,
    target: unknown,
    returnFocusTo: string,
  ): void;
  /**
   * Close and Escape delegate to Back; popstate performs the mutation.
   * A count greater than one closes one governed parent and its nested
   * descendants as a single user action. A stale-target caller may override
   * focus restoration with a stable surviving control. Returns false when a
   * traversal is already pending or the requested depth is invalid.
   */
  popLayer(count?: number, returnFocusTo?: string): boolean;

  /** The authoritative ordered group list, persisted in the current
   *  browser-local workspace. */
  notebook: QueryNotebookV1;
  /** Membership = the group participates in the comparison (trends, Reader
   *  marks, and concordance eligibility). Order is notebook order. Never silently
   *  truncated: a sixth activation is refused with `notebookError`. */
  activeGroupIds: ReadonlySet<string>;
  /** Transient view projection: when set, the effective active set is JUST
   *  this group; clearing restores the prior state exactly (nothing else is
   *  mutated). Cleared when the group is removed or deactivated. */
  soloGroupId: string | null;
  /** Style ownership (group id → authored pair). Preserved through rename,
   *  member edits, reorder, and mute; freed on removal; unique among actives. */
  styles: ReadonlyMap<string, SeriesStyleV1>;
  /** One bounded notebook-authoring refusal (sixth activation, invalid member
   *  set, over-limit name). Cleared by the next successful notebook action. */
  notebookError: string | null;
  /** Session undo for explicit term deletion. No derived style entry is retained;
   * undo re-enters normal style reconciliation. Cleared across workspace
   * identity changes. */
  removedGroups: readonly RemovedNotebookGroup[];
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
  /** Session-local Concordance controls. Never serialized or autosaved. */
  concordanceView: ConcordanceView;
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
  /** Snapshot-bound full-document extents survive a range-scoped inventory
   * replacing the visible corpus inventory. Cleared on snapshot identity. */
  corpusTokenCounts: ReadonlyMap<string, number>;
  frequencyView: FrequencyViewV1;
  frequency: FrequencyState | null;
  /** Comparison-owned, brush-independent two-side keyness research intent. */
  keynessView: KeynessViewV1;
  keynessA: KeynessTableState | null;
  keynessB: KeynessTableState | null;
  keynessInventoryA: KeynessInventoryState | null;
  keynessInventoryB: KeynessInventoryState | null;
  trendView: TrendView;
  /** Durable result geometry and resident-data display transform. Bin changes
   * reissue only baseline + selected trend lanes; measure changes query
   * nothing. */
  trendBins: TrendBinsSpecV1;
  trendMeasure: WorkspaceTrendMeasureV1;
  /** Resident explanation for automatic geometry normalization or a corpus
   * that cannot satisfy the bounded trend protocol. */
  trendSettingsNotice: string | null;
  /** The document currently selected by book-level views. */
  focusedDoc: string | null;
  scrub: ScrubTarget | null;
  /** Transient, snapshot-bound source text for the global reading footer. */
  footerPassage: FooterPassageState | null;
  /** Latest exact w/W navigation request and its accessible outcome. */
  occurrenceNavigation: OccurrenceNavigationState | null;
  /** F owns only the fenced place/placeholder; H attaches reader-page state. */
  readerPlace: ReaderPlace | null;
  readerPage: ReaderPageState | null;
  readerVisibleRange: ReaderVisibleRangeV1 | null;
  /** Navigation derived from browser-fitted boundaries, never from the larger
   * worker source slice. A remembered previous boundary is re-requested from
   * its exact start so immediate backtracking reproduces the page. At a text
   * edge, the target continues in declared corpus order. */
  readerNavigation: {
    readonly previous: ReaderNavigationTarget | null;
    readonly next: ReaderNavigationTarget | null;
  } | null;

  // ── Query/presentation intent (owned here). ──
  /** Append-only quick-add: each comma term becomes a single-token folded
   *  group, active and concordance-enabled; a term already in the notebook
   *  (same matching identity) is skipped; a batch that cannot FULLY activate
   *  is refused atomically via `inputError` (nothing partial, ruling §3). */
  quickAdd(input: string): void;
  addTerm(input: {
    readonly aliases: readonly string[];
    readonly displayName?: string;
    readonly exactMatch?: boolean;
    readonly countOverlaps?: boolean;
    readonly style?: SeriesStyleV1;
  }): string | null;
  saveTerm(groupId: string, input: {
    readonly aliases: readonly string[];
    readonly displayName?: string;
    readonly exactMatch: boolean;
    readonly countOverlaps: boolean;
    readonly style: SeriesStyleV1;
  }): boolean;
  setGroupStyle(groupId: string, style: SeriesStyleV1): void;
  // ── Notebook authoring (slice-1 commit B: model + actions; UI lands in the
  //    panel commit). Rename/reorder are presentation-only (no reissue);
  //    member/overlap edits and active-set changes reissue the results. ──
  renameGroup(groupId: string, name: string): void;
  setGroupMembers(groupId: string, members: readonly GroupMember[], countOverlaps: boolean): boolean;
  removeGroup(groupId: string): void;
  undoRemoveGroup(): void;
  dismissRemovedGroup(): void;
  reorderGroups(order: readonly string[]): void;
  setGroupActive(groupId: string, active: boolean): void;
  setSolo(groupId: string | null): void;
  clearNotebookError(): void;
  setFocus(seriesId: string): void;
  /** Toggle a term in/out of the merged concordance; reissues ONLY the KWIC
   *  query, immediately, against the latest axis position. */
  toggleKwicSeries(seriesId: string): void;
  setConcordanceContext(contextChars: ConcordanceView['contextChars']): void;
  setConcordanceReading(reading: ConcordanceReadingMode): void;
  setTrendView(view: TrendView): void;
  applyTrendSettings(input: TrendSettingsInput): TrendSettingsOutcome;
  /** Center the concordance on an activated barcode occurrence IMMEDIATELY (no
   *  scrub debounce). Carries the activated series: a deliberate occurrence
   *  click must yield a concordance CAPABLE of containing it, so a disabled
   *  concordance chip for that series is visibly re-enabled first (review-D
   *  HIGH). `origin: 'bucket'` labels a density-midpoint target. */
  centerKwicAt(seriesId: string, doc: string, token: number, origin?: { readonly kind: 'bucket'; readonly count: number }): void;
  /** Commit explicit per-document spans from one contiguous reading-order
   *  gesture. Reissues detail consumers; baseline results remain resident.
   *  Null clears. */
  setLinkedSelection(selection: TokenRangeSelectionV1 | null): void;
  runInventory(): void;
  runFrequency(): void;
  setFrequencySort(by: FrequencySortFieldV1): void;
  applyFrequencyView(input: FrequencyViewInputV1): void;
  setFrequencyPage(offset: number): void;
  addFrequencyTerm(key: string): void;
  showFrequencyTermInKwic(key: string): void;
  runKeyness(): void;
  setKeynessMode(mode: KeynessViewV1['mode']): void;
  setKeynessDocument(side: 'a' | 'b', doc: string): void;
  swapKeynessSides(): void;
  applyKeynessSettings(input: KeynessSettingsInputV1): void;
  setKeynessDirection(side: 'a' | 'b'): void;
  setKeynessPage(side: 'a' | 'b', offset: number): void;
  setFocusedDoc(doc: string): void;
  setScrub(target: ScrubTarget): void;
  clearScrub(): void;
  stepOccurrence(direction: 1 | -1): void;
  openReader(intent: ReaderOpenIntent, returnFocusTo?: string): void;
  setReaderVisibleRange(range: ReaderVisibleRangeV1): void;
  refitReaderAt(token: number): void;
  navigateReader(target: ReaderNavigationTarget | ReaderPlace['cursor']): void;
  retryReader(): void;
  closeReader(): void;
  runReader(): void;
  /** Browser-measured token reserve required to keep the clipped footer row
   * filled on both sides of its centered cursor. */
  setFooterPassageMargin(tokens: number): void;
  runFooterPassage(): void;
  runQueries(): void;

  // ── Session command wrappers (forward to the one attached session). ──
  /** Import files: create a library corpus from a built-in, or append to the
   *  active library corpus. */
  openBuiltinCorpus(id: BuiltinCorpusId): void;
  importFiles(files: readonly LocalLibraryFile[]): void;
  removeImport(doc: string): void;
  removeDocument(doc: string): void;
  removeDocuments(docs: readonly string[]): void;
  editMeta(doc: string, patch: MetaPatch): void;
  setLanguage(doc: string, language: string): void;
  reorder(order: readonly string[]): void;
  /** Reopen analysis on the SAME lifetime session (post-error retry). */
  retryAnalysis(): void;
  clearCommandError(): void;
  retryWorkspaceSave(): void;
  /** Restore preferences after the composition root has selected the corpus. */
  restoreWorkspace(workspace: WorkspaceV1): void;
}

type TrendCorpusState = Pick<
  AppState,
  'snapshot' | 'inventory' | 'trends' | 'corpusTokenCounts'
>;

function preferredTrendBinsForMode(mode: TrendBinsSpecV1['mode']): TrendBinsSpecV1 {
  return mode === 'per-doc'
    ? DEFAULT_TREND_BINS
    : { mode: 'fixed-tokens', count: 1_000 };
}

function fitCountWithinLimits(
  bins: TrendBinsSpecV1,
  limits: { readonly minimum: number; readonly maximum: number },
): TrendBinsSpecV1 {
  return {
    mode: bins.mode,
    count: Math.max(limits.minimum, Math.min(limits.maximum, bins.count)),
  };
}

function fitTrendBinsToCorpus(
  state: TrendCorpusState,
  bins: TrendBinsSpecV1,
  clamp: boolean,
): TrendBinsSpecV1 | null {
  if (state.snapshot === null) return bins;
  const tokenCounts = fullTokenCountsForDocs(
    state.snapshot.readyDocs,
    {
      corpusTokenCounts: state.corpusTokenCounts,
      inventory: state.inventory,
      trends: state.trends,
    },
  );
  // Corpus geometry is not known yet. Restoration may provision the durable
  // preference now; the inventory landing path normalizes it before it can
  // remain as a failed resident intent.
  if (tokenCounts === null) return bins;
  const limits = trendBinLimits(tokenCounts, bins.mode);
  if (limits === null) {
    if (!clamp) return null;
    const alternate = preferredTrendBinsForMode(
      bins.mode === 'per-doc' ? 'fixed-tokens' : 'per-doc',
    );
    const alternateLimits = trendBinLimits(tokenCounts, alternate.mode);
    return alternateLimits === null
      ? null
      : fitCountWithinLimits(alternate, alternateLimits);
  }
  if (bins.count >= limits.minimum && bins.count <= limits.maximum) return bins;
  if (!clamp) return null;
  return fitCountWithinLimits(bins, limits);
}

function trendGeometryNotice(
  before: TrendBinsSpecV1,
  after: TrendBinsSpecV1,
): string {
  const description = after.mode === 'per-doc'
    ? `${after.count.toLocaleString()} bins per book`
    : `${after.count.toLocaleString()} tokens per bin`;
  const switched = before.mode !== after.mode ? ' and changed bin mode' : '';
  return `Adjusted trend geometry${switched} to ${description} for this corpus. The adjusted value is now the saved preference.`;
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
  attachSession(
    session: SessionPort,
    workspace?: WorkspaceV1,
    workspaceStore?: WorkspaceStorePort,
  ): void;
  /** Report an async bootstrap (built-in construction/hashing) failure. */
  failBootstrap(error: unknown): void;
  /** Surface a recoverable startup reconciliation to the user. */
  reportNotice(message: string): void;
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

function normalizeAuthoredAliases(aliases: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const alias of aliases) {
    const value = alias.trim().normalize('NFC');
    if (value !== '' && !normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

function queryErrorMessage(e: unknown): string {
  return e instanceof WorkerClientError && e.analysisCode === 'CAP_EXCEEDED'
    ? 'Too many occurrences to analyse at once — narrow the selected range or corpus.'
    : msg(e);
}

function retainTrendTokenCounts(
  current: ReadonlyMap<string, number>,
  trend: NumericTrend,
): ReadonlyMap<string, number> {
  const next = new Map(current);
  for (let index = 0; index < trend.order.length; index++) {
    const count = trend.docTokenCount[index];
    if (count !== undefined && Number.isSafeInteger(count) && count >= 0) {
      next.set(trend.order[index]!, count);
    }
  }
  return next;
}

/** The focused doc for the incoming session state: preserve the current focus
 *  while it remains a ready member of the snapshot, otherwise pick the first
 *  ready doc in DECLARED project order (never analysis-completion order). While
 *  a generation has no snapshot, retain a saved focus that belongs to the
 *  declared corpus so boot and restart do not discard it. */
function resolveFocusedDoc(prev: string | null, next: SessionState): string | null {
  const snapshot = next.snapshot;
  if (!snapshot) return prev !== null && next.project.data.order.includes(prev) ? prev : null;
  const ready = new Set(snapshot.readyDocs);
  if (prev !== null && ready.has(prev)) return prev;
  for (const doc of next.project.data.order) if (ready.has(doc)) return doc;
  return snapshot.readyDocs[0] ?? null;
}

function adjacentReaderDocument(
  state: Pick<AppState, 'corpusTokenCounts' | 'projectSession' | 'snapshot'>,
  doc: string,
  direction: 1 | -1,
): ReaderNavigationTarget | null {
  const readyDocs = state.snapshot?.readyDocs;
  if (!readyDocs) return null;
  const ready = new Set(readyDocs);
  const order: string[] = [];
  const seen = new Set<string>();
  const appendReady = (candidate: string) => {
    if (ready.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      order.push(candidate);
    }
  };
  for (const candidate of state.projectSession?.project.data.order ?? []) appendReady(candidate);
  // A restored or partially published session may briefly lack declared-order
  // metadata. Keep every ready document reachable without letting arrival order
  // override a declared position when that metadata is present.
  for (const candidate of readyDocs) appendReady(candidate);

  const current = order.indexOf(doc);
  if (current < 0) return null;
  for (
    let index = current + direction;
    index >= 0 && index < order.length;
    index += direction
  ) {
    const candidate = order[index]!;
    const tokenCount = state.corpusTokenCounts.get(candidate);
    if (tokenCount === undefined || tokenCount <= 0) continue;
    return {
      doc: candidate,
      cursor: direction === 1
        ? { kind: 'from', token: 0 }
        : { kind: 'before', token: tokenCount },
    };
  }
  return null;
}

export function workspaceFromApp(state: AppState): WorkspaceV1 | null {
  const project = state.projectSession?.project;
  if (!project) return null;
  if (project.kind === 'library' && project.data.docs.some((doc) => doc.library === undefined)) return null;
  const { prefixNfc, ...frequency } = state.frequencyView;
  return {
    schema: 'texttrends/workspace/1',
    corpus: project.kind === 'builtin'
      ? { kind: 'builtin', id: project.id }
      : {
          kind: 'library',
          order: project.data.order,
          docs: project.data.docs.map((doc) => ({
            doc: doc.doc,
            library: doc.library!,
            meta: doc.meta,
            ...(doc.extraction.text === undefined || doc.extraction.textLengthUtf16 === undefined
              ? {}
              : { warm: { textHash: doc.extraction.text, textLengthUtf16: doc.extraction.textLengthUtf16 } }),
          })),
        },
    notebook: state.notebook,
    active: state.notebook.groups
      .filter((group) => state.activeGroupIds.has(group.id))
      .map((group) => group.id),
    kwicEnabled: state.notebook.groups
      .filter((group) => state.kwicEnabledSeries.has(group.id))
      .map((group) => group.id),
    views: {
      trend: {
        mode: state.trendView,
        focusedDoc: state.focusedDoc,
        bins: state.trendBins,
        measure: state.trendMeasure,
      },
      frequency: {
        minCount: frequency.minCount,
        minDocFreq: frequency.minDocFreq,
        classes: frequency.classes,
        ...(prefixNfc === undefined ? {} : { prefixNfc }),
        sort: frequency.sort,
        pageSize: frequency.page.limit,
      },
      compare: {
        mode: state.keynessView.mode,
        documentA: state.keynessView.documentA,
        documentB: state.keynessView.documentB,
        restOn: state.keynessView.restOn,
        minCountTotal: state.keynessView.minCountTotal,
        minDocFreqTotal: state.keynessView.minDocFreqTotal,
        classes: state.keynessView.classes,
        sort: state.keynessView.sort,
        pageSize: state.keynessView.pageLimit,
      },
    },
  };
}

export function workspaceSemanticKey(state: AppState): string | null {
  const workspace = workspaceFromApp(state);
  return workspace === null ? null : canonicalJson(workspace);
}

/** One query-intent lane: latest-wins ownership plus the in-flight transport
 *  cancels it may best-effort clean up. Superseding is ONE operation, so no
 *  call site can cancel without invalidating or invalidate without cancelling. */
class QueryLane {
  private readonly cancels = new Set<() => void>();
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
    this.cancels.clear();
    this.ops.invalidate();
  }
  track(cancel: () => void): () => void {
    this.cancels.add(cancel);
    return () => this.cancels.delete(cancel);
  }
}

function routeFromUrl(url: string): { readonly place: Place } {
  try {
    return parseRoute(new URL(url, 'https://texttrends.invalid/').search);
  } catch {
    return DEFAULT_ROUTE;
  }
}

function urlWithRoute(
  url: string,
  route: { readonly place: Place },
): string {
  let parsed: URL;
  try {
    parsed = new URL(url, 'https://texttrends.invalid/');
  } catch {
    parsed = new URL('https://texttrends.invalid/');
  }
  return `${parsed.pathname}${routeSearch(parsed.search, route)}${parsed.hash}`;
}

function relativeHistoryUrl(url: string): string {
  try {
    const parsed = new URL(url, 'https://texttrends.invalid/');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

function restoreFocusTo(id: string): void {
  if (typeof document === 'undefined') return;
  const focus = () => document.getElementById(id)?.focus({ preventScroll: true });
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);
  else queueMicrotask(focus);
}

export function createAppRuntime(
  client: QueryClient,
  opts?: {
    /** Injectable semantic UUID factory (deterministic in tests). */
    newId?: () => string;
    /** Separate strict-v4 identity lane for browser-history layers. */
    newLayerId?: () => string;
    /** Browser history is an injected side-effect boundary, absent in pure tests. */
    history?: HistoryPort;
    /** Last-write-wins storage for the one current workspace. */
    workspace?: WorkspaceStorePort;
  },
): AppRuntime {
  const newId = opts?.newId ?? (() => crypto.randomUUID());
  const newLayerId = opts?.newLayerId ?? (() => crypto.randomUUID());
  const historyPort = opts?.history ?? null;
  let workspaceStore = opts?.workspace ?? null;
  // Ownership: ONE scope for the runtime lifetime (closed on dispose) and one
  // lane per query intent. A lease carries the fences the old hand-rolled
  // epochs + captured keys expressed.
  const scope = new OperationScope();
  const trendLane = new QueryLane(scope);
  const kwicLane = new QueryLane(scope);
  // The barcode's dispersion intent — reissued with the trend burst.
  const dispersionLane = new QueryLane(scope);
  // Selected-range overlay lanes — separate latest-wins ownership so a brush
  // never cancels the resident baseline (ruling §2).
  const selectedTrendLane = new QueryLane(scope);
  const selectedDispersionLane = new QueryLane(scope);
  // Vocabulary-wide analytics are independent of notebook query lanes.
  const inventoryLane = new QueryLane(scope);
  const frequencyLane = new QueryLane(scope);
  // Each visible keyness table and comparison-header inventory owns its lane:
  // paging A cannot supersede B, and neither depends on the global brush.
  const keynessALane = new QueryLane(scope);
  const keynessBLane = new QueryLane(scope);
  const keynessInventoryALane = new QueryLane(scope);
  const keynessInventoryBLane = new QueryLane(scope);
  // Full-reader pages are a distinct latest-wins presentation intent. Rapid
  // Next/Previous cannot race with trends or one another.
  const readerLane = new QueryLane(scope);
  // Exact focused-term stepping is independent of Reader/footer passage work.
  const occurrenceLane = new QueryLane(scope);
  // The global reading footer reuses reader-page/1 through a separate lane.
  // Reader navigation and footer scrubbing never supersede one another.
  const footerPassageLane = new QueryLane(scope);
  let footerPassagePending: ScrubTarget | null = null;
  let footerPassageActive: { readonly cancel: () => void } | null = null;
  let footerPassageMargin = 0;
  // The SETTLED axis position the concordance centres on (null = reading order),
  // and the trailing-edge debounce timer from raw scrub motion to that center.
  let kwicCenter: (ScrubTarget & { readonly origin?: 'bucket'; readonly bucketCount?: number }) | null = null;
  let kwicCenterTimer: ReturnType<typeof setTimeout> | null = null;

  // The one attached session (retained in the closure, never in Zustand state —
  // it holds Files, promises, and cancel handles). Null until the composition
  // root attaches it.
  let session: SessionPort | null = null;
  let unsubscribe: (() => void) | null = null;
  let attached = false;
  let disposed = false;
  let workspaceHydrated = false;
  let workspaceLastKey: string | null = null;
  let workspacePausedKey: string | null = null;
  let workspaceSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let workspaceSaveToken = 0;
  let workspaceScheduling = false;
  let saveWorkspaceNow = (): void => undefined;
  let historyTraversalPending = false;
  let pendingBackFocusTo: string | null = null;
  let readerWalk: {
    readonly snapshot: string;
    readonly doc: string;
    readonly geometry: string;
    boundaries: number[];
    index: number;
  } | null = null;

  // Route and layer state is initialized before the store so the first React
  // snapshot and the current history entry cannot disagree.
  const MAX_LAYER_REGISTRY_ENTRIES = 128;
  const layerRegistry = new Map<string, Layer>();
  const rememberLayer = (layer: Layer, retain: readonly Layer[] = []): void => {
    layerRegistry.delete(layer.id);
    layerRegistry.set(layer.id, layer);
    if (layerRegistry.size <= MAX_LAYER_REGISTRY_ENTRIES) return;
    const protectedIds = new Set(retain.map((item) => item.id));
    for (const id of layerRegistry.keys()) {
      if (layerRegistry.size <= MAX_LAYER_REGISTRY_ENTRIES) break;
      if (!protectedIds.has(id)) layerRegistry.delete(id);
    }
  };
  const resolveLayer = (id: string): Layer | undefined => {
    const layer = layerRegistry.get(id);
    if (layer === undefined) return undefined;
    // A resolved Back/Forward identity becomes most-recently used.
    layerRegistry.delete(id);
    layerRegistry.set(id, layer);
    return layer;
  };
  const bootRoute = historyPort === null
    ? DEFAULT_ROUTE
    : routeFromUrl(historyPort.url);
  let initialLayers: readonly Layer[] = [];
  if (historyPort !== null) {
    historyPort.replace(
      historyStateFor([]),
      urlWithRoute(historyPort.url, bootRoute),
    );
  }

  const store = create<AppState>((set, get) => {
    const readerForLayers = (
      layers: readonly Layer[],
      snapshot = get().snapshot,
    ): ReaderPlace | null => {
      const layer = layers.findLast((candidate) => candidate.kind === 'reader');
      if (layer === undefined) return null;
      return liveReaderPlace(
        layer.target,
        snapshot?.snapshot ?? null,
        snapshot?.readyDocs ?? [],
      );
    };

    const writeNavigation = (
      mode: 'push' | 'replace',
      place: Place,
      layers: readonly Layer[],
      options: { readonly preserveReaderNavigation?: boolean } = {},
    ): void => {
      if (historyPort !== null) {
        historyPort[mode](
          historyStateFor(layers),
          urlWithRoute(historyPort.url, { place }),
        );
      }
      const current = get();
      const readerPlace = readerForLayers(layers, current.snapshot);
      const readerChanged = !sameReaderPlace(current.readerPlace, readerPlace);
      if (readerChanged) readerLane.supersede();
      set((state) => ({
        place,
        layers,
        notebookError: place === state.place ? state.notebookError : null,
        readerPlace,
        readerPage: readerChanged ? null : state.readerPage,
        readerVisibleRange: readerChanged ? null : state.readerVisibleRange,
        readerNavigation:
          readerChanged && !options.preserveReaderNavigation
            ? null
            : state.readerNavigation,
      }));
    };

    const replaceReaderTarget = (target: ReaderNavigationTarget): void => {
      const place = get().readerPlace;
      const cursor = target.cursor;
      if (
        place === null
        || (target.doc === place.doc && sameReaderCursor(cursor, place.cursor))
        || !get().snapshot?.readyDocs.includes(target.doc)
        || !Number.isSafeInteger(cursor.token)
        || cursor.token < 0
        || (cursor.kind === 'before' && cursor.token < 1)
      ) return;
      const readerIndex = get().layers.findLastIndex((layer) => layer.kind === 'reader');
      const readerLayer = get().layers[readerIndex];
      if (readerIndex < 0 || readerLayer?.kind !== 'reader') return;
      const sameDocument = target.doc === place.doc;
      const nextPlace: ReaderPlace = {
        ...place,
        doc: target.doc,
        cursor: { ...cursor },
      };
      const nextLayer: Layer = {
        ...readerLayer,
        target: Object.freeze(nextPlace),
      };
      const layers = get().layers.map((layer, index) =>
        index === readerIndex ? nextLayer : layer);
      rememberLayer(nextLayer, layers);
      writeNavigation(
        'replace',
        get().place,
        layers,
        { preserveReaderNavigation: sameDocument },
      );
      if (!sameDocument) readerWalk = null;
      get().runReader();
    };

    const requestBack = (count = 1, returnFocusTo?: string): boolean => {
      const layers = get().layers;
      if (
        historyTraversalPending
        || layers.length === 0
        || !Number.isSafeInteger(count)
        || count < 1
        || count > layers.length
      ) return false;
      if (historyPort === null) {
        const closing = layers.at(-count)!;
        writeNavigation('replace', get().place, layers.slice(0, -count));
        restoreFocusTo(returnFocusTo ?? closing.returnFocusTo);
        return true;
      }
      historyTraversalPending = true;
      pendingBackFocusTo = returnFocusTo ?? null;
      historyPort.back(count);
      return true;
    };

    const freshLayer = (
      kind: Exclude<LayerKind, 'place'>,
      target: unknown,
      returnFocusTo: string,
    ): Layer => ({
      kind,
      id: newLayerId(),
      target,
      returnFocusTo,
    });

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
          onError(queryErrorMessage(e));
        });
    };

    const writeKeynessTable = (
      side: 'a' | 'b',
      value: KeynessTableState | null,
    ): void => {
      if (side === 'a') set({ keynessA: value });
      else set({ keynessB: value });
    };

    const writeKeynessInventory = (
      side: 'a' | 'b',
      value: KeynessInventoryState | null,
    ): void => {
      if (side === 'a') set({ keynessInventoryA: value });
      else set({ keynessInventoryB: value });
    };

    const runKeynessTable = (side: 'a' | 'b'): void => {
      const lane = side === 'a' ? keynessALane : keynessBLane;
      lane.supersede();
      const { snapshot, keynessView } = get();
      const pair = snapshot
        ? keynessSelections(keynessView, snapshot.readyDocs)
        : null;
      if (!snapshot || !pair) {
        writeKeynessTable(side, null);
        return;
      }
      const issuedKey = snapKey(snapshot);
      const issuedView = keynessView;
      const issuedIntent = keynessTableIntentKey(
        issuedView,
        snapshot.readyDocs,
        side,
      );
      const sort = {
        by: issuedView.sort.by,
        dir: side === 'a' ? issuedView.sort.dirA : issuedView.sort.dirB,
      };
      const page = {
        offset: side === 'a' ? issuedView.offsetA : issuedView.offsetB,
        limit: issuedView.pageLimit,
      };
      const lease = lane.ops.begin(
        () => snapKey(get().snapshot) === issuedKey,
        () => {
          const live = get();
          return live.snapshot !== null
            && keynessTableIntentKey(
              live.keynessView,
              live.snapshot.readyDocs,
              side,
            ) === issuedIntent;
        },
      );
      writeKeynessTable(side, {
        snapshot: snapshot.snapshot,
        side,
        view: issuedView,
        state: { status: 'pending' },
      });
      issueOn(
        lane,
        snapshot.snapshot,
        {
          op: 'keyness',
          request: {
            method: 'keyness-g2-2x2/1',
            effect: 'log-ratio-halves/1',
            a: pair.a,
            b: pair.b,
            filter: {
              minCountTotal: issuedView.minCountTotal,
              minDocFreqTotal: issuedView.minDocFreqTotal,
              classes: issuedView.classes,
            },
            sort,
            page,
            side,
          },
        },
        lease,
        (data) => {
          if (data.op !== 'keyness') return;
          writeKeynessTable(side, {
            snapshot: snapshot.snapshot,
            side,
            view: issuedView,
            state: { status: 'ready', result: data.keyness },
          });
        },
        (message) => writeKeynessTable(side, {
          snapshot: snapshot.snapshot,
          side,
          view: issuedView,
          state: { status: 'error', message },
        }),
      );
    };

    const runKeynessInventory = (side: 'a' | 'b'): void => {
      const lane = side === 'a'
        ? keynessInventoryALane
        : keynessInventoryBLane;
      lane.supersede();
      const { snapshot, keynessView } = get();
      const pair = snapshot
        ? keynessSelections(keynessView, snapshot.readyDocs)
        : null;
      if (!snapshot || !pair) {
        writeKeynessInventory(side, null);
        return;
      }
      const issuedKey = snapKey(snapshot);
      const issuedView = keynessView;
      const issuedSelection = keynessSideSelectionKey(
        issuedView,
        snapshot.readyDocs,
        side,
      );
      const lease = lane.ops.begin(
        () => snapKey(get().snapshot) === issuedKey,
        () => {
          const live = get();
          return live.snapshot !== null
            && keynessSideSelectionKey(
              live.keynessView,
              live.snapshot.readyDocs,
              side,
            ) === issuedSelection;
        },
      );
      writeKeynessInventory(side, {
        snapshot: snapshot.snapshot,
        side,
        view: issuedView,
        state: { status: 'pending' },
      });
      issueOn(
        lane,
        snapshot.snapshot,
        {
          op: 'inventory',
          selection: pair[side],
          request: {
            method: 'inventory/1',
            rhythmBinsPerDoc: 0,
            growthPoints: 0,
            mattrWindow: INVENTORY_MATTR_WINDOW,
          },
        },
        lease,
        (data) => {
          if (data.op !== 'inventory') return;
          writeKeynessInventory(side, {
            snapshot: snapshot.snapshot,
            side,
            view: issuedView,
            state: { status: 'ready', result: data.inventory },
          });
        },
        (message) => writeKeynessInventory(side, {
          snapshot: snapshot.snapshot,
          side,
          view: issuedView,
          state: { status: 'error', message },
        }),
      );
    };

    /** The exact derived core spec for a series (from its authored aliases).
     *  The versioned compiler rebuilds worker members deterministically.
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
     *  (solo narrows to one), carrying group-owned styles. */
    const projectSeries = (
      nb: QueryNotebookV1,
      active: ReadonlySet<string>,
      solo: string | null,
      styles: ReadonlyMap<string, SeriesStyleV1>,
    ): SeriesIntent[] =>
      nb.groups
        .filter((g) => active.has(g.id) && (solo === null || g.id === solo))
        .map((g) => ({ id: g.id, label: groupTitle(g), style: styles.get(g.id) ?? g.style }));

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
          style: s.style,
        }));
      }
      return { wire, identities, captured: Object.freeze(captured) };
    };

    const identitiesCurrent = (pairs: readonly (readonly [string, string])[]): boolean =>
      pairs.every(([id, ident]) => identityOf(id) === ident);

    const footerServes = (target: ScrubTarget): boolean => {
      const snapshot = get().snapshot;
      return snapshot !== null && footerPassageServes(
        get().footerPassage,
        target,
        snapshot.snapshot,
        identityOf,
        footerPassageMargin,
      );
    };

    const resetFooterPassage = () => {
      footerPassagePending = null;
      footerPassageLane.supersede();
      footerPassageActive = null;
      if (get().footerPassage !== null) set({ footerPassage: null });
    };

    let pumpFooterPassage = (): void => undefined;

    const scheduleFooterPassage = (target: ScrubTarget) => {
      const snapshot = get().snapshot;
      if (!snapshot || !snapshot.readyDocs.includes(target.doc)) return;
      if (footerServes(target)) {
        footerPassagePending = null;
        // A rapid reversal may return to the resident page while a now-useless
        // request is active. Keep the exact resident source and retire that
        // request so its late page cannot replace the current text.
        if (footerPassageActive !== null) {
          footerPassageLane.supersede();
          footerPassageActive = null;
        }
        const passage = get().footerPassage;
        // A failed or superseded request cannot leave an error/pending overlay
        // over a resident page that honestly serves the current target.
        if (passage?.page && passage.state.status !== 'ready') {
          set({
            footerPassage: {
              ...passage,
              state: { status: 'ready' },
            },
          });
        }
        return;
      }
      footerPassagePending = { ...target };
      // Pointer sampling is already rAF-coalesced and this lane is
      // single-flight/latest-pending, so a second trailing debounce only adds
      // latency without adding a meaningful work bound.
      pumpFooterPassage();
    };

    pumpFooterPassage = () => {
      if (footerPassageActive !== null) return;
      const target = footerPassagePending;
      footerPassagePending = null;
      const { snapshot, series } = get();
      if (!target || !snapshot || !snapshot.readyDocs.includes(target.doc)) return;
      if (footerServes(target)) return;
      const tracks = trackSpecs(series);
      if (tracks === null) {
        set({ footerPassage: null });
        return;
      }
      const previous = get().footerPassage;
      const residentPage = previous?.snapshot === snapshot.snapshot
        && previous.tracks.length === tracks.captured.length
        && previous.tracks.every((track, index) => {
          const current = tracks.captured[index];
          return current?.seriesId === track.seriesId
            && current.identity === track.identity;
        })
        ? previous.page
        : null;
      const issuedKey = snapKey(snapshot);
      const lease = footerPassageLane.ops.begin(
        () => snapKey(get().snapshot) === issuedKey,
        () => identitiesCurrent(tracks.identities),
      );
      set({
        footerPassage: {
          snapshot: snapshot.snapshot,
          doc: target.doc,
          tracks: tracks.captured,
          page: residentPage,
          state: { status: 'pending' },
        },
      });
      const handle = client.query(snapshot.snapshot, {
        op: 'reader-page',
        tracks: tracks.wire,
        request: {
          method: 'reader-page/1',
          doc: target.doc,
          cursor: { kind: 'around', token: target.token },
          maxTokens: FOOTER_PASSAGE_MAX_TOKENS,
        },
      });
      const active = { cancel: handle.cancel };
      footerPassageActive = active;
      const untrack = footerPassageLane.track(handle.cancel);
      const settle = () => {
        untrack();
        if (footerPassageActive !== active) return;
        footerPassageActive = null;
        if (footerPassagePending && footerServes(footerPassagePending)) {
          footerPassagePending = null;
        }
        if (footerPassagePending) pumpFooterPassage();
      };
      void handle.result
        .then((data) => {
          if (!lease.isCurrent() || data.op !== 'reader-page') return;
          if (data.page.doc !== target.doc) {
            set({
              footerPassage: {
                snapshot: snapshot.snapshot,
                doc: target.doc,
                tracks: tracks.captured,
                page: residentPage,
                state: { status: 'error', message: 'footer source returned the wrong document' },
              },
            });
            return;
          }
          set({
            footerPassage: {
              snapshot: snapshot.snapshot,
              doc: target.doc,
              tracks: tracks.captured,
              page: data.page,
              state: { status: 'ready' },
            },
          });
        })
        .catch((error: unknown) => {
          if (isCancelled(error) || !lease.isCurrent()) return;
          set({
            footerPassage: {
              snapshot: snapshot.snapshot,
              doc: target.doc,
              tracks: tracks.captured,
              page: residentPage,
              state: { status: 'error', message: queryErrorMessage(error) },
            },
          });
        })
        .finally(settle);
    };

    /** Reissue only the two trend result lanes after a bin-policy change.
     * Dispersion, KWIC, and inventory do not depend on trend bins and must
     * remain resident. */
    const runTrendLanesOnly = () => {
      trendLane.supersede();
      selectedTrendLane.supersede();
      const { snapshot, series, linkedSelection, trendBins } = get();
      if (!snapshot || series.length === 0) {
        set({ trends: new Map(), selectedTrends: new Map() });
        return;
      }
      const issuedKey = snapKey(snapshot);
      const issuedBins = trendBins;
      const binsCurrent = () => {
        const current = get().trendBins;
        return current.mode === issuedBins.mode && current.count === issuedBins.count;
      };
      set({
        trends: new Map(series.map((item) => [item.id, { status: 'pending' } as const])),
      });
      const baselineLease = trendLane.ops.begin(
        () => snapKey(get().snapshot) === issuedKey,
        binsCurrent,
      );
      for (const item of series) {
        const spec = specFor(item.id);
        if (spec === null) continue;
        const issuedIdentity = termGroupIdentity(spec);
        const write = (state: SeriesTrendState) => set((live) => {
          const next = new Map(live.trends);
          next.set(item.id, state);
          return {
            trends: next,
            corpusTokenCounts: state.status === 'ready'
              ? retainTrendTokenCounts(live.corpusTokenCounts, state.trend)
              : live.corpusTokenCounts,
          };
        });
        issueOn(
          trendLane,
          snapshot.snapshot,
          {
            op: 'trend',
            selection: { docs: [...snapshot.readyDocs] },
            group: spec,
            request: { coordinate: 'declared-sequence', bins: issuedBins },
          },
          baselineLease,
          (data) => {
            if (data.op === 'trend' && identityOf(item.id) === issuedIdentity) {
              write({ status: 'ready', trend: data.trend });
            }
          },
          (message) => {
            if (identityOf(item.id) === issuedIdentity) {
              write({ status: 'error', message });
            }
          },
        );
      }

      if (
        linkedSelection === null ||
        !isValidSelection(linkedSelection, snapshot.snapshot, snapshot.readyDocs)
      ) {
        set({ selectedTrends: new Map() });
        return;
      }
      const issuedSelection = linkedSelection;
      const wireSelection = detailSelection(snapshot.readyDocs, issuedSelection);
      set({
        selectedTrends: new Map(series.map((item) => [item.id, { status: 'pending' } as const])),
      });
      const selectedLease = selectedTrendLane.ops.begin(
        () => snapKey(get().snapshot) === issuedKey,
        binsCurrent,
        () => get().linkedSelection === issuedSelection,
      );
      for (const item of series) {
        const spec = specFor(item.id);
        if (spec === null) continue;
        const issuedIdentity = termGroupIdentity(spec);
        const write = (state: SeriesTrendState) => set((live) => {
          const next = new Map(live.selectedTrends);
          next.set(item.id, state);
          return { selectedTrends: next };
        });
        issueOn(
          selectedTrendLane,
          snapshot.snapshot,
          {
            op: 'trend',
            selection: wireSelection,
            group: spec,
            request: { coordinate: 'declared-sequence', bins: issuedBins },
          },
          selectedLease,
          (data) => {
            if (data.op === 'trend' && identityOf(item.id) === issuedIdentity) {
              write({ status: 'ready', trend: data.trend });
            }
          },
          (message) => {
            if (identityOf(item.id) === issuedIdentity) {
              write({ status: 'error', message });
            }
          },
        );
      }
    };

    /** (Re)issue the SELECTED-range overlays (trends + dispersion) for the
     *  active linked selection — separate lanes so a brush never cancels the
     *  resident whole-corpus baseline (ruling §2). No selection: overlays
     *  clear; the baseline stands. */
    const runSelected = () => {
      selectedTrendLane.supersede();
      selectedDispersionLane.supersede();
      const { snapshot, series, linkedSelection, trendBins } = get();
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
          { op: 'trend', selection: wireSelection, group: spec, request: { coordinate: 'declared-sequence', bins: trendBins } },
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
      const center = kwicCenter
        && snapshot.readyDocs.includes(kwicCenter.doc)
        ? kwicCenter
        : null;
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
     * Adopt a notebook mutation: recompute styles, the series
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
     *  cancel or recompute live results (ruling invariant 2, review-C). */
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
      next: {
        notebook?: QueryNotebookV1;
        activeGroupIds?: ReadonlySet<string>;
        kwicEnabledGroupIds?: ReadonlySet<string>;
        soloGroupId?: string | null;
      },
      opts: { reissue: boolean },
    ): void => {
      const prev = get();
      const prevIntent = effectiveIntentKey(prev.notebook, prev.series, prev.kwicEnabledSeries);
      let notebook = next.notebook ?? prev.notebook;
      const known = new Set(notebook.groups.map((g) => g.id));
      const active = new Set([...(next.activeGroupIds ?? prev.activeGroupIds)].filter((id) => known.has(id)));
      notebook = resolveActiveStyleCollisions(notebook, active, prev.activeGroupIds);
      let solo = next.soloGroupId === undefined ? prev.soloGroupId : next.soloGroupId;
      if (solo !== null && !active.has(solo)) solo = null;
      const styles = new Map(notebook.groups.map((group) => [group.id, group.style]));
      const series = projectSeries(notebook, active, solo, styles);
      // Concordance membership: preserved for every SURVIVING group (muting
      // must not destroy the toggle — invariant 6); a newly created group
      // joins enabled. Effective KWIC stays `series ∩ enabled` at issue
      // time, always a subset of the actives.
      const nextEnabled = next.kwicEnabledGroupIds === undefined
        ? new Set<string>()
        : new Set(
            [...next.kwicEnabledGroupIds].filter((id) => known.has(id)),
          );
      if (next.kwicEnabledGroupIds === undefined) {
        for (const g of notebook.groups) {
          const existedBefore = prev.notebook.groups.some((p) => p.id === g.id);
          if (existedBefore ? prev.kwicEnabledSeries.has(g.id) : true) {
            nextEnabled.add(g.id);
          }
        }
      }
      const stillFocused = series.some((s) => s.id === prev.focusedSeries);
      set({
        notebook,
        activeGroupIds: active,
        soloGroupId: solo,
        styles,
        series,
        notebookError: null,
        kwicEnabledSeries: nextEnabled,
        focusedSeries: prev.focusedSeries === null
          ? null
          : stillFocused
            ? prev.focusedSeries
            : series[0]?.id ?? null,
      });
      if (opts.reissue && effectiveIntentKey(notebook, series, nextEnabled) !== prevIntent) {
        get().runQueries();
      }
    };

    /** Replace the comparison notebook in one publication when a demo corpus
     *  changes. A later durable research load for that corpus may supersede
     *  these starter terms; on a first visit they make the demo immediately
     *  meaningful instead of carrying another corpus's vocabulary across. */
    const seedDemoNotebook = (input: string) => {
      const parsed = parseQuickAdd(input, newId, MAX_SERIES, []);
      if (parsed.error !== null) throw new Error(`invalid built-in starter terms: ${parsed.error}`);
      const notebook: QueryNotebookV1 = {
        schema: 'texttrends/query-notebook/3',
        groups: parsed.groups,
      };
      const ids = new Set(parsed.groups.map((group) => group.id));
      adoptNotebook(
        {
          notebook,
          activeGroupIds: ids,
          kwicEnabledGroupIds: ids,
          soloGroupId: null,
        },
        { reissue: true },
      );
      set({ inputError: null, notebookError: null, removedGroups: [] });
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
      workspacePersistence: { phase: 'idle' },
      place: bootRoute.place,
      layers: initialLayers,
      setPlace(place) {
        if (!PLACES.includes(place) || place === get().place) return;
        const next: Layer = {
          kind: 'place',
          id: newLayerId(),
          target: Object.freeze({ place }),
          returnFocusTo: `place-${get().place}-heading`,
        };
        const layers = pushLayerStack(get().layers, next);
        rememberLayer(next, layers);
        writeNavigation('push', place, layers);
      },
      pushLayer(kind, target, returnFocusTo) {
        const next = freshLayer(kind, target, returnFocusTo);
        const layers = pushLayerStack(get().layers, next);
        rememberLayer(next, layers);
        writeNavigation('push', get().place, layers);
      },
      replaceLayer(kind, target, returnFocusTo) {
        const next = freshLayer(kind, target, returnFocusTo);
        const layers = replaceTopLayer(get().layers, next);
        rememberLayer(next, layers);
        writeNavigation('replace', get().place, layers);
      },
      popLayer(count = 1, returnFocusTo) {
        return requestBack(count, returnFocusTo);
      },
      notebook: { schema: 'texttrends/query-notebook/3', groups: [] },
      activeGroupIds: new Set<string>(),
      soloGroupId: null,
      styles: new Map<string, SeriesStyleV1>(),
      notebookError: null,
      removedGroups: [],
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
      concordanceView: {
        contextChars: 38,
        reading: 'aligned',
      },
      dispersion: null,
      linkedSelection: null,
      selectedTrends: new Map(),
      selectedDispersion: null,
      inventory: null,
      corpusTokenCounts: new Map(),
      frequencyView: {
        schema: 'texttrends/frequency-view/1',
        minCount: 1,
        minDocFreq: 1,
        classes: ['lexical'],
        sort: { by: 'count', dir: -1 },
        page: { offset: 0, limit: 100 },
      },
      frequency: null,
      keynessView: DEFAULT_KEYNESS_VIEW,
      keynessA: null,
      keynessB: null,
      keynessInventoryA: null,
      keynessInventoryB: null,
      trendView: 'series',
      trendBins: DEFAULT_TREND_BINS,
      trendMeasure: DEFAULT_TREND_MEASURE,
      trendSettingsNotice: null,
      focusedDoc: null,
      scrub: null,
      footerPassage: null,
      occurrenceNavigation: null,
      readerPlace: null,
      readerPage: null,
      readerVisibleRange: null,
      readerNavigation: null,

      quickAdd(input) {
        const state = get();
        const room = Math.min(
          NOTEBOOK_LIMITS_V1.maxGroups - state.notebook.groups.length,
          MAX_SERIES - state.activeGroupIds.size,
        );
        const parsed = parseQuickAdd(input, newId, Math.max(0, room), state.notebook.groups);
        if (parsed.error !== null) {
          // ATOMIC refusal: the existing notebook and its results stand
          // untouched beside the message (append-only — a refused add never
          // clears anything).
          set({ inputError: parsed.error });
          return;
        }
        set({ inputError: null });
        if (parsed.groups.length === 0) return; // blank or all-duplicates: no-op
        const notebook: QueryNotebookV1 = {
          schema: 'texttrends/query-notebook/3',
          groups: [...state.notebook.groups, ...parsed.groups],
        };
        const active = new Set(state.activeGroupIds);
        for (const g of parsed.groups) active.add(g.id); // room was preflighted
        adoptNotebook({ notebook, activeGroupIds: active }, { reissue: true });
      },

      addTerm(input) {
        const state = get();
        if (state.notebook.groups.length >= NOTEBOOK_LIMITS_V1.maxGroups) {
          refuseNotebook(`a notebook holds at most ${NOTEBOOK_LIMITS_V1.maxGroups} terms`);
          return null;
        }
        const aliases = normalizeAuthoredAliases(input.aliases);
        if (aliases.length === 0) {
          refuseNotebook('a term needs at least one alias');
          return null;
        }
        const displayName = input.displayName?.trim().normalize('NFC');
        const group: NotebookGroupV1 = {
          id: newId(),
          aliases,
          ...(displayName && displayName !== aliases[0] ? { displayName } : {}),
          exactMatch: input.exactMatch ?? false,
          countOverlaps: input.countOverlaps ?? false,
          style: input.style ?? firstFreeStyle(state.notebook.groups, state.activeGroupIds),
        };
        try {
          validateNotebookGroup(group);
        } catch (e) {
          refuseNotebook(msg(e));
          return null;
        }
        const duplicate = state.notebook.groups.find((candidate) =>
          groupIdentity(candidate) === groupIdentity(group));
        if (duplicate) {
          set({ notebookError: null });
          return duplicate.id;
        }
        if (state.activeGroupIds.size < MAX_SERIES) {
          const collision = state.notebook.groups.find((candidate) =>
            state.activeGroupIds.has(candidate.id)
            && styleKey(candidate.style) === styleKey(group.style));
          if (collision) {
            refuseNotebook(`${groupTitle(collision)} already uses that color and line type`);
            return null;
          }
        }
        const notebook: QueryNotebookV1 = {
          schema: 'texttrends/query-notebook/3',
          groups: [...state.notebook.groups, group],
        };
        const active = new Set(state.activeGroupIds);
        if (active.size < MAX_SERIES) active.add(group.id);
        adoptNotebook({ notebook, activeGroupIds: active }, { reissue: active.has(group.id) });
        return group.id;
      },

      saveTerm(groupId, input) {
        const state = get();
        const current = state.notebook.groups.find((group) => group.id === groupId);
        if (!current) return false;
        const aliases = normalizeAuthoredAliases(input.aliases);
        const displayName = input.displayName?.trim().normalize('NFC');
        const edited: NotebookGroupV1 = {
          id: current.id,
          aliases,
          ...(displayName && displayName !== aliases[0] ? { displayName } : {}),
          exactMatch: input.exactMatch,
          countOverlaps: input.countOverlaps,
          style: input.style,
        };
        try {
          validateNotebookGroup(edited);
        } catch (e) {
          refuseNotebook(msg(e));
          return false;
        }
        if (state.activeGroupIds.has(groupId)) {
          const collision = state.notebook.groups.find((group) =>
            group.id !== groupId
            && state.activeGroupIds.has(group.id)
            && styleKey(group.style) === styleKey(edited.style));
          if (collision) {
            refuseNotebook(`${groupTitle(collision)} already uses that color and line type`);
            return false;
          }
        }
        const changed = groupIdentity(edited) !== groupIdentity(current);
        if (changed) {
          const duplicate = state.notebook.groups.find((group) =>
            group.id !== groupId && groupIdentity(group) === groupIdentity(edited));
          if (duplicate) {
            refuseNotebook(`${groupTitle(duplicate)} already has those matching aliases`);
            return false;
          }
        }
        const notebook: QueryNotebookV1 = {
          ...state.notebook,
          groups: state.notebook.groups.map((group) => group.id === groupId ? edited : group),
        };
        adoptNotebook({ notebook }, { reissue: changed });
        return true;
      },

      setGroupStyle(groupId, style) {
        const group = get().notebook.groups.find((candidate) => candidate.id === groupId);
        if (!group) return;
        get().saveTerm(groupId, {
          aliases: group.aliases,
          ...(group.displayName ? { displayName: group.displayName } : {}),
          exactMatch: group.exactMatch,
          countOverlaps: group.countOverlaps,
          style,
        });
      },

      // ── Notebook authoring actions (commit B: model only; UI lands with
      //    the panel). Every action leaves invariants via adoptNotebook. ──
      renameGroup(groupId, name) {
        const nb = get().notebook;
        const g = nb.groups.find((x) => x.id === groupId);
        if (!g) return;
        const normalized = name.normalize('NFC');
        const { displayName: _oldName, ...base } = g;
        const renamed: NotebookGroupV1 = normalized === g.aliases[0]
          ? base
          : { ...base, displayName: normalized };
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
        if (!g) return false;
        const aliasOf = (member: GroupMember): string => {
          switch (member.kind) {
            case 'token': return member.surface;
            case 'prefix': return `${member.stem}*`;
            case 'suffix': return `*${member.stem}`;
            case 'phrase': return member.elements.map((element) => element.kind === 'token'
              ? element.surface
              : element.kind === 'prefix' ? `${element.stem}*` : `*${element.stem}`).join(' ');
          }
        };
        const edited: NotebookGroupV1 = {
          ...g,
          aliases: members.map(aliasOf),
          exactMatch: members.some((member) =>
            member.match.case === 'sensitive' || member.match.diacritics === 'sensitive'),
          countOverlaps,
        };
        try {
          validateNotebookGroup(edited);
        } catch (e) {
          refuseNotebook(msg(e));
          return false;
        }
        const changed = groupIdentity(edited) !== groupIdentity(g);
        const notebook: QueryNotebookV1 = { ...nb, groups: nb.groups.map((x) => (x.id === groupId ? edited : x)) };
        // A semantic edit preserves the UUID but invalidates and reissues the
        // results (invariant 3); an identity-neutral edit reissues nothing.
        adoptNotebook({ notebook }, { reissue: changed });
        return true;
      },

      removeGroup(groupId) {
        const nb = get().notebook;
        const index = nb.groups.findIndex((x) => x.id === groupId);
        if (index < 0) return;
        const group = nb.groups[index]!;
        const removed: RemovedNotebookGroup = {
          group,
          index,
          active: get().activeGroupIds.has(groupId),
          kwicEnabled: get().kwicEnabledSeries.has(groupId),
          solo: get().soloGroupId === groupId,
        };
        const notebook: QueryNotebookV1 = { ...nb, groups: nb.groups.filter((x) => x.id !== groupId) };
        const wasProjected = get().series.some((s) => s.id === groupId);
        adoptNotebook({ notebook }, { reissue: wasProjected });
        set((state) => ({ removedGroups: [...state.removedGroups, removed].slice(-5) }));
      },

      undoRemoveGroup() {
        const state = get();
        const removed = state.removedGroups.at(-1);
        if (!removed) return;
        if (
          state.notebook.groups.length >= NOTEBOOK_LIMITS_V1.maxGroups ||
          state.notebook.groups.some((group) => group.id === removed.group.id)
        ) {
          set({ removedGroups: state.removedGroups.slice(0, -1) });
          refuseNotebook('The removed term can no longer be restored.');
          return;
        }
        const groups = [...state.notebook.groups];
        groups.splice(Math.min(removed.index, groups.length), 0, removed.group);
        const active = new Set(state.activeGroupIds);
        if (removed.active && active.size < MAX_SERIES) active.add(removed.group.id);
        const enabled = new Set(state.kwicEnabledSeries);
        if (removed.kwicEnabled) enabled.add(removed.group.id);
        set({ removedGroups: state.removedGroups.slice(0, -1) });
        adoptNotebook({
          notebook: { ...state.notebook, groups },
          activeGroupIds: active,
          kwicEnabledGroupIds: enabled,
          soloGroupId: removed.solo && state.soloGroupId === null
            ? removed.group.id
            : state.soloGroupId,
        }, { reissue: removed.active });
      },

      dismissRemovedGroup() {
        set((state) => ({ removedGroups: state.removedGroups.slice(0, -1) }));
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
        occurrenceLane.supersede();
        set({ focusedSeries: seriesId, occurrenceNavigation: null });
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

      setConcordanceContext(contextChars) {
        if (!([12, 24, 38, 60] as const).includes(contextChars)) return;
        const view = get().concordanceView;
        if (view.contextChars === contextChars) return;
        set({ concordanceView: { ...view, contextChars } });
      },

      setConcordanceReading(reading) {
        if (!(['aligned', 'stacked'] as const).includes(reading)) return;
        const view = get().concordanceView;
        if (view.reading === reading) return;
        set({ concordanceView: { ...view, reading } });
      },

      setTrendView(view) {
        set({ trendView: view }); // presentation-only: no query is reissued
      },

      applyTrendSettings(input) {
        const state = get();
        let admitted;
        try {
          admitted = parseWorkspaceTrendView({
            mode: state.trendView,
            focusedDoc: state.focusedDoc,
            bins: input.bins,
            measure: input.measure,
          });
        } catch {
          return 'rejected';
        }
        if (fitTrendBinsToCorpus(state, admitted.bins, false) === null) return 'rejected';
        const binsChanged =
          admitted.bins.mode !== state.trendBins.mode ||
          admitted.bins.count !== state.trendBins.count;
        const measureChanged = canonicalJson(admitted.measure) !== canonicalJson(state.trendMeasure);
        if (!binsChanged && !measureChanged) return 'unchanged';
        // A measure-only change does not fabricate a new geometry object.
        // Trend-lane leases also fence by bin value, so any future equal-value
        // writer remains semantically current while a reissue is in flight.
        set(binsChanged
          ? {
              trendBins: admitted.bins,
              trendMeasure: admitted.measure,
              trendSettingsNotice: null,
            }
          : {
              trendMeasure: admitted.measure,
              trendSettingsNotice: null,
            });
        if (binsChanged) runTrendLanesOnly();
        return 'applied';
      },

      setFocusedDoc(doc) {
        if (get().focusedDoc === doc) return;
        if (!get().snapshot?.readyDocs.includes(doc)) return; // only a ready doc
        set({ focusedDoc: doc });
      },

      setScrub(target) {
        const { snapshot, corpusTokenCounts } = get();
        const tokenCount = corpusTokenCounts.get(target.doc);
        if (
          !snapshot
          || !snapshot.readyDocs.includes(target.doc)
          || !Number.isSafeInteger(target.token)
          || target.token < 0
          || (tokenCount !== undefined && target.token >= tokenCount)
        ) return;
        const previous = get().scrub;
        const changed =
          previous?.doc !== target.doc || previous.token !== target.token;
        const alreadySettled =
          kwicCenter?.doc === target.doc
          && kwicCenter.token === target.token
          && kwicCenter.origin === undefined;
        if (!changed && alreadySettled) {
          // Footer residency is independent of the settled KWIC center. A
          // missing/error page may retry without invalidating concordance.
          scheduleFooterPassage(target);
          return;
        }
        if (changed) {
          occurrenceLane.supersede();
          set({ scrub: target, occurrenceNavigation: null });
        }
        scheduleFooterPassage(target);
        scheduleKwicCenter(target); // debounced concordance re-centre on the axis
      },

      clearScrub() {
        occurrenceLane.supersede();
        set({ scrub: null, occurrenceNavigation: null });
        resetFooterPassage();
        // The concordance falls back to reading order immediately.
        resetKwicCenter();
        runKwic();
      },

      stepOccurrence(direction) {
        occurrenceLane.supersede();
        const state = get();
        const snapshot = state.snapshot;
        const focused = state.series.find((item) => item.id === state.focusedSeries)
          ?? state.series[0];
        if (!snapshot || !focused || (direction !== 1 && direction !== -1)) {
          set({ occurrenceNavigation: null });
          return;
        }
        const group = specFor(focused.id);
        if (group === null) {
          set({ occurrenceNavigation: null });
          return;
        }
        const currentReader = state.readerPlace;
        const readyReader = currentReader
          && state.readerPage
          && sameReaderPlace(state.readerPage.place, currentReader)
          && state.readerPage.state.status === 'ready'
          ? state.readerPage.state.page
          : null;
        const candidateVisible = state.readerVisibleRange;
        const visibleReader = readyReader
          && candidateVisible !== null
          && candidateVisible.snapshot === state.readerPage?.snapshot
          && candidateVisible.doc === readyReader.doc
          ? candidateVisible
          : null;
        const readerAnchor = readyReader
          ? {
              doc: readyReader.doc,
              token: readyReader.anchor?.token
                ?? visibleReader?.tokens.start
                ?? readyReader.tokens.start,
            }
          : null;
        let anchor = readerAnchor ?? state.scrub;
        if (anchor === null) {
          const candidates = direction === 1
            ? snapshot.readyDocs
            : [...snapshot.readyDocs].reverse();
          const doc = candidates.find((candidate) =>
            (state.corpusTokenCounts.get(candidate) ?? 0) > 0);
          const tokenCount = doc ? state.corpusTokenCounts.get(doc) ?? 0 : 0;
          anchor = doc
            ? { doc, token: direction === 1 ? 0 : tokenCount - 1 }
            : null;
        }
        if (anchor === null || !snapshot.readyDocs.includes(anchor.doc)) {
          set({
            focusedSeries: focused.id,
            occurrenceNavigation: {
              snapshot: snapshot.snapshot,
              seriesId: focused.id,
              direction,
              state: { status: 'error', message: 'source positions are still loading' },
            },
          });
          return;
        }
        const issuedKey = snapKey(snapshot);
        const issuedIdentity = termGroupIdentity(group);
        const issuedReader = currentReader;
        const readerLayer = issuedReader
          ? state.layers.findLast((layer) => layer.kind === 'reader')
          : undefined;
        const returnFocusTo = readerLayer?.returnFocusTo;
        const lease = occurrenceLane.ops.begin(
          () => snapKey(get().snapshot) === issuedKey,
          () => identityOf(focused.id) === issuedIdentity,
          () => sameReaderPlace(get().readerPlace, issuedReader),
        );
        set({
          focusedSeries: focused.id,
          occurrenceNavigation: {
            snapshot: snapshot.snapshot,
            seriesId: focused.id,
            direction,
            state: { status: 'pending' },
          },
        });
        issueOn(
          occurrenceLane,
          snapshot.snapshot,
          {
            op: 'occurrence-step',
            track: { seriesId: focused.id, group },
            request: {
              method: 'occurrence-step/1',
              doc: anchor.doc,
              token: anchor.token,
              direction,
            },
          },
          lease,
          (data) => {
            if (
              data.op !== 'occurrence-step'
              || data.seriesId !== focused.id
              || data.groupId !== group.id
              || data.step.method !== 'occurrence-step/1'
            ) {
              set({
                occurrenceNavigation: {
                  snapshot: snapshot.snapshot,
                  seriesId: focused.id,
                  direction,
                  state: { status: 'error', message: 'worker returned the wrong term' },
                },
              });
              return;
            }
            const hit = data.step.hit;
            if (data.step.atEdge !== (hit === null)) {
              set({
                occurrenceNavigation: {
                  snapshot: snapshot.snapshot,
                  seriesId: focused.id,
                  direction,
                  state: { status: 'error', message: 'worker returned an invalid occurrence step' },
                },
              });
              return;
            }
            if (hit === null) {
              set({
                occurrenceNavigation: {
                  snapshot: snapshot.snapshot,
                  seriesId: focused.id,
                  direction,
                  state: { status: 'edge' },
                },
              });
              return;
            }
            const tokenCount = get().corpusTokenCounts.get(hit.doc);
            if (
              !snapshot.readyDocs.includes(hit.doc)
              || !Number.isSafeInteger(hit.token)
              || hit.token < 0
              || !Number.isSafeInteger(hit.spanTokens)
              || hit.spanTokens < 1
              || (tokenCount !== undefined && hit.token + hit.spanTokens > tokenCount)
              || hit.members.some((member) =>
                !Number.isSafeInteger(member)
                || member < 0
                || member >= group.members.length)
            ) {
              set({
                occurrenceNavigation: {
                  snapshot: snapshot.snapshot,
                  seriesId: focused.id,
                  direction,
                  state: { status: 'error', message: 'worker returned an invalid occurrence' },
                },
              });
              return;
            }
            get().setScrub({ doc: hit.doc, token: hit.token });
            get().centerKwicAt(focused.id, hit.doc, hit.token);
            if (issuedReader !== null) {
              get().openReader({
                snapshot: snapshot.snapshot,
                doc: hit.doc,
                token: hit.token,
                from: 'occurrence',
              }, returnFocusTo);
            }
            set({
              occurrenceNavigation: {
                snapshot: snapshot.snapshot,
                seriesId: focused.id,
                direction,
                state: { status: 'ready', hit },
              },
            });
          },
          (message) => set({
            occurrenceNavigation: {
              snapshot: snapshot.snapshot,
              seriesId: focused.id,
              direction,
              state: { status: 'error', message },
            },
          }),
        );
      },

      openReader(intent, returnFocusTo = `place-${get().place}-heading`) {
        const snapshot = get().snapshot;
        const place = readerPlaceFor(
          intent,
          snapshot?.snapshot ?? null,
          snapshot?.readyDocs ?? [],
        );
        if (place) {
          const next = freshLayer(
            'reader',
            Object.freeze(place),
            returnFocusTo,
          );
          const replacing = get().layers.at(-1)?.kind === 'reader';
          const layers = replacing
            ? replaceTopLayer(get().layers, next)
            : pushLayerStack(get().layers, next);
          rememberLayer(next, layers);
          writeNavigation(replacing ? 'replace' : 'push', get().place, layers);
          get().runReader();
        }
      },

      setReaderVisibleRange(range) {
        const state = get();
        const place = state.readerPlace;
        const source = state.readerPage
          && place
          && sameReaderPlace(state.readerPage.place, place)
          && state.readerPage.state.status === 'ready'
          ? state.readerPage.state.page
          : null;
        if (
          source === null
          || range.snapshot !== state.readerPage?.snapshot
          || range.doc !== source.doc
          || range.doc !== place?.doc
          || !Number.isSafeInteger(range.tokens.start)
          || !Number.isSafeInteger(range.tokens.end)
          || range.tokens.start < source.tokens.start
          || range.tokens.end > source.tokens.end
          || range.tokens.start >= range.tokens.end
          || range.geometry.length === 0
        ) return;

        if (
          readerWalk === null
          || readerWalk.snapshot !== range.snapshot
          || readerWalk.doc !== range.doc
          || readerWalk.geometry !== range.geometry
        ) {
          readerWalk = {
            snapshot: range.snapshot,
            doc: range.doc,
            geometry: range.geometry,
            boundaries: [range.tokens.start, range.tokens.end],
            index: 0,
          };
        } else {
          const walk = readerWalk;
          const existing = walk.boundaries.findIndex((boundary, index) =>
            boundary === range.tokens.start
            && walk.boundaries[index + 1] === range.tokens.end);
          if (existing >= 0) {
            walk.index = existing;
          } else if (walk.boundaries.at(-1) === range.tokens.start) {
            walk.boundaries.push(range.tokens.end);
            walk.index = walk.boundaries.length - 2;
          } else if (walk.boundaries[0] === range.tokens.end) {
            walk.boundaries.unshift(range.tokens.start);
            walk.index = 0;
          } else {
            walk.boundaries = [range.tokens.start, range.tokens.end];
            walk.index = 0;
          }
        }
        const MAX_READER_BOUNDARIES = 257;
        if (readerWalk.boundaries.length > MAX_READER_BOUNDARIES) {
          if (readerWalk.index > MAX_READER_BOUNDARIES / 2) {
            readerWalk.boundaries.shift();
            readerWalk.index--;
          } else {
            readerWalk.boundaries.pop();
          }
        }
        const previousStart = readerWalk.index > 0
          ? readerWalk.boundaries[readerWalk.index - 1]
          : null;
        set({
          readerVisibleRange: range,
          readerNavigation: {
            previous: previousStart !== null && previousStart !== undefined
              ? { doc: source.doc, cursor: { kind: 'from', token: previousStart } }
              : range.tokens.start === 0
                ? adjacentReaderDocument(state, source.doc, -1)
                : { doc: source.doc, cursor: { kind: 'before', token: range.tokens.start } },
            next: range.tokens.end === source.docTokenCount
              ? adjacentReaderDocument(state, source.doc, 1)
              : { doc: source.doc, cursor: { kind: 'from', token: range.tokens.end } },
          },
        });
      },

      refitReaderAt(token) {
        const state = get();
        const visible = state.readerVisibleRange;
        const source = state.readerPage?.state.status === 'ready'
          ? state.readerPage.state.page
          : null;
        if (
          visible === null
          || source === null
          || visible.snapshot !== state.readerPage?.snapshot
          || visible.doc !== source.doc
          || token !== visible.tokens.start
          || token < source.tokens.start
          || token >= source.tokens.end
        ) return;
        replaceReaderTarget({ doc: source.doc, cursor: { kind: 'from', token } });
      },

      navigateReader(target) {
        const { readerPlace: place, readerNavigation: navigation, readerPage } = get();
        const destination: ReaderNavigationTarget | null = place === null
          ? null
          : 'doc' in target
            ? target
            : { doc: place.doc, cursor: target };
        const readyPage = readerPage
          && place
          && sameReaderPlace(readerPage.place, place)
          && readerPage.state.status === 'ready'
          ? readerPage.state.page
          : null;
        const boundaryCursor = destination !== null
          && destination.doc === place?.doc
          && ((destination.cursor.kind === 'from' && destination.cursor.token === 0)
          || (
            destination.cursor.kind === 'before'
            && readyPage !== null
            && destination.cursor.token === readyPage.docTokenCount
          ));
        const matchesNavigation = (candidate: ReaderNavigationTarget | null): boolean =>
          destination !== null
          && candidate !== null
          && destination.doc === candidate.doc
          && sameReaderCursor(destination.cursor, candidate.cursor);
        if (
          !place
          || destination === null
          || !navigation
          || (
            !boundaryCursor
            && !matchesNavigation(navigation.previous)
            && !matchesNavigation(navigation.next)
          )
        ) return;
        replaceReaderTarget(destination);
      },

      retryReader() {
        if (get().readerPlace) get().runReader();
      },

      closeReader() {
        requestBack();
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
          set({ readerPage: null, readerVisibleRange: null, readerNavigation: null });
          return;
        }
        const tracks = trackSpecs(series);
        if (tracks === null) {
          set({ readerPage: null, readerVisibleRange: null, readerNavigation: null });
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
          readerVisibleRange: null,
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
              maxTokens: READER_SOURCE_MAX_TOKENS,
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

      runFooterPassage() {
        const target = get().scrub;
        if (target === null) {
          resetFooterPassage();
          return;
        }
        footerPassagePending = { ...target };
        pumpFooterPassage();
      },

      setFooterPassageMargin(tokens) {
        const next = Number.isFinite(tokens) && tokens > 0
          ? Math.floor(tokens)
          : 0;
        if (next === footerPassageMargin) return;
        const increased = next > footerPassageMargin;
        footerPassageMargin = next;
        const target = get().scrub;
        if (increased && target) scheduleFooterPassage(target);
      },

      runQueries() {
        const { snapshot, series, trendBins } = get();
        occurrenceLane.supersede();
        set({ occurrenceNavigation: null });
        // Reader highlights use the CURRENT semantic active-track projection;
        // rename-only notebook edits do not call runQueries and remain
        // presentation-only, while active/member/overlap changes reissue here.
        get().runReader();
        resetFooterPassage();
        if (snapshot && get().scrub) get().runFooterPassage();
        // Trend intent changed: ALWAYS cancel superseded work, clear to
        // pending, and invalidate the epoch — even when the new intent runs
        // no query.
        trendLane.supersede(); // even a no-query outcome supersedes in-flight work
        // A pending scrub-settle belongs to the old series/snapshot; drop it so
        // it cannot fire a stale center after this reissue. runKwic below uses
        // the last settled center (degrading to reading order if its doc departed).
        if (kwicCenterTimer !== null) { clearTimeout(kwicCenterTimer); kwicCenterTimer = null; }
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
          set({
            trends: new Map(),
            scrub: null,
            footerPassage: null,
            dispersion: null,
            selectedTrends: new Map(),
            selectedDispersion: null,
          });
          resetKwicCenter(); // the axis is gone — no stale center may resurrect
          runKwic(); // clears or re-targets the concordance consistently
          return;
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
              return {
                trends: next,
                corpusTokenCounts: state.status === 'ready'
                  ? retainTrendTokenCounts(prev.corpusTokenCounts, state.trend)
                  : prev.corpusTokenCounts,
              };
            });
          issueOn(
            trendLane,
            issuedSnapshot,
            {
              op: 'trend',
              selection: { docs: [...snapshot.readyDocs] },
              group: spec,
              request: { coordinate: 'declared-sequence', bins: trendBins },
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
              mattrWindow: INVENTORY_MATTR_WINDOW,
            },
          },
          lease,
          (data) => {
            if (data.op !== 'inventory') return;
            set((state) => {
              const corpusTokenCounts = new Map(state.corpusTokenCounts);
              for (const row of data.inventory.documents) {
                if (Number.isSafeInteger(row.fullTokens) && row.fullTokens >= 0) {
                  corpusTokenCounts.set(row.doc, row.fullTokens);
                }
              }
              return {
                inventory: {
                  snapshot: snapshot.snapshot,
                  selection: issuedSelection,
                  state: { status: 'ready', result: data.inventory },
                },
                corpusTokenCounts,
              };
            });
            const current = get();
            const fitted = fitTrendBinsToCorpus(current, current.trendBins, true);
            if (fitted === null) {
              set({
                trendSettingsNotice: `No trend bin mode can represent this corpus within the ${TREND_MAX_ROWS.toLocaleString()}-row result limit.`,
              });
            } else if (
              fitted.mode !== current.trendBins.mode
              || fitted.count !== current.trendBins.count
            ) {
              set({
                trendBins: fitted,
                trendSettingsNotice: trendGeometryNotice(current.trendBins, fitted),
              });
              runTrendLanesOnly();
            }
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

      runKeyness() {
        runKeynessTable('a');
        runKeynessTable('b');
        runKeynessInventory('a');
        runKeynessInventory('b');
      },

      setKeynessMode(mode) {
        if (mode !== 'documents' && mode !== 'document-rest') return;
        const state = get();
        if (state.keynessView.mode === mode) return;
        const ready = state.snapshot?.readyDocs ?? [];
        const focus = state.keynessView.restOn === 'b'
          ? state.keynessView.documentA
          : state.keynessView.documentB;
        const documentA = focus && ready.includes(focus)
          ? focus
          : ready[0] ?? null;
        const documentB = ready.find((doc) => doc !== documentA) ?? null;
        set({
          keynessView: {
            ...state.keynessView,
            mode,
            documentA,
            documentB,
            restOn: 'b',
            offsetA: 0,
            offsetB: 0,
          },
        });
        get().runKeyness();
      },

      setKeynessDocument(side, doc) {
        const state = get();
        const ready = state.snapshot?.readyDocs ?? [];
        if (!ready.includes(doc)) return;
        const view = state.keynessView;
        if (view.mode === 'document-rest') {
          const documentSide = view.restOn === 'b' ? 'a' : 'b';
          if (side !== documentSide) return;
        }
        if (
          (side === 'a' && doc === view.documentB) ||
          (side === 'b' && doc === view.documentA)
        ) {
          return;
        }
        set({
          keynessView: {
            ...view,
            ...(side === 'a' ? { documentA: doc } : { documentB: doc }),
            offsetA: 0,
            offsetB: 0,
          },
        });
        get().runKeyness();
      },

      swapKeynessSides() {
        const view = get().keynessView;
        const ready = get().snapshot?.readyDocs ?? [];
        let next: KeynessViewV1;
        if (view.mode === 'documents') {
          next = {
            ...view,
            documentA: view.documentB,
            documentB: view.documentA,
            offsetA: 0,
            offsetB: 0,
          };
        } else if (view.restOn === 'b') {
          const focus = view.documentA;
          next = {
            ...view,
            restOn: 'a',
            documentB: focus,
            documentA: ready.find((doc) => doc !== focus) ?? null,
            offsetA: 0,
            offsetB: 0,
          };
        } else {
          const focus = view.documentB;
          next = {
            ...view,
            restOn: 'b',
            documentA: focus,
            documentB: ready.find((doc) => doc !== focus) ?? null,
            offsetA: 0,
            offsetB: 0,
          };
        }
        set({ keynessView: next });
        get().runKeyness();
      },

      applyKeynessSettings(input) {
        if (
          !Number.isSafeInteger(input.minCountTotal) ||
          input.minCountTotal < 1 ||
          !Number.isSafeInteger(input.minDocFreqTotal) ||
          input.minDocFreqTotal < 1 ||
          !Array.isArray(input.classes) ||
          input.classes.length < 1 ||
          input.classes.length > 2 ||
          new Set(input.classes).size !== input.classes.length ||
          input.classes.some(
            (value) => value !== 'lexical' && value !== 'numeral',
          ) ||
          !['logRatio', 'g2', 'countA', 'countB'].includes(input.sortBy) ||
          !Number.isSafeInteger(input.pageLimit) ||
          input.pageLimit < 1 ||
          input.pageLimit > FREQUENCY_PAGE_MAX
        ) {
          return;
        }
        const view = get().keynessView;
        set({
          keynessView: {
            ...view,
            minCountTotal: input.minCountTotal,
            minDocFreqTotal: input.minDocFreqTotal,
            classes: [...input.classes],
            sort: { ...view.sort, by: input.sortBy },
            pageLimit: input.pageLimit,
            offsetA: 0,
            offsetB: 0,
          },
        });
        runKeynessTable('a');
        runKeynessTable('b');
      },

      setKeynessDirection(side) {
        if (side !== 'a' && side !== 'b') return;
        const view = get().keynessView;
        const next: KeynessViewV1 = side === 'a'
          ? {
              ...view,
              sort: {
                ...view.sort,
                dirA: view.sort.dirA === 1 ? -1 : 1,
              },
              offsetA: 0,
            }
          : {
              ...view,
              sort: {
                ...view.sort,
                dirB: view.sort.dirB === 1 ? -1 : 1,
              },
              offsetB: 0,
            };
        set({ keynessView: next });
        runKeynessTable(side);
      },

      setKeynessPage(side, offset) {
        if (side !== 'a' && side !== 'b') return;
        const view = get().keynessView;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset + view.pageLimit > FREQUENCY_WINDOW_MAX
        ) {
          return;
        }
        set({
          keynessView: side === 'a'
            ? { ...view, offsetA: offset }
            : { ...view, offsetB: offset },
        });
        runKeynessTable(side);
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

      applyFrequencyView(input) {
        const normalized = input.prefix.trim().normalize('NFC');
        const classes = [...new Set(input.classes)].filter(
          (value): value is FrequencyTokenClassV1 =>
            value === 'lexical' || value === 'numeral',
        );
        const current = get().frequencyView;
        if (
          !Number.isSafeInteger(input.minCount) ||
          input.minCount < 1 ||
          !Number.isSafeInteger(input.minDocFreq) ||
          input.minDocFreq < 1 ||
          normalized.length > FREQUENCY_PREFIX_MAX_UNITS ||
          classes.length === 0 ||
          classes.length !== input.classes.length ||
          !['count', 'docFreq', 'dp', 'dpNorm', 'key'].includes(input.sort.by) ||
          (input.sort.dir !== 1 && input.sort.dir !== -1) ||
          !Number.isSafeInteger(input.pageLimit) ||
          input.pageLimit < 1 ||
          input.pageLimit > FREQUENCY_PAGE_MAX
        ) {
          return;
        }
        const { prefixNfc: _oldPrefix, ...withoutPrefix } = current;
        set({
          frequencyView: normalized === ''
            ? {
                ...withoutPrefix,
                minCount: input.minCount,
                minDocFreq: input.minDocFreq,
                classes,
                sort: { ...input.sort },
                page: { offset: 0, limit: input.pageLimit },
              }
            : {
                ...current,
                minCount: input.minCount,
                minDocFreq: input.minDocFreq,
                classes,
                prefixNfc: normalized,
                sort: { ...input.sort },
                page: { offset: 0, limit: input.pageLimit },
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

      addFrequencyTerm(key) {
        const label = key.normalize('NFC');
        const state = get();
        if (state.notebook.groups.length >= NOTEBOOK_LIMITS_V1.maxGroups) {
          refuseNotebook(`a notebook holds at most ${NOTEBOOK_LIMITS_V1.maxGroups} terms`);
          return;
        }
        const probe: NotebookGroupV1 = {
          id: 'probe',
          aliases: [label],
          exactMatch: true,
          countOverlaps: false,
          style: firstFreeStyle(state.notebook.groups, state.activeGroupIds),
        };
        if (state.notebook.groups.some((group) => groupIdentity(group) === groupIdentity(probe))) {
          refuseNotebook('that exact term is already in the notebook');
          return;
        }
        const group = { ...probe, id: newId() };
        try {
          validateNotebookGroup(group);
        } catch (e) {
          refuseNotebook(msg(e));
          return;
        }
        const notebook: QueryNotebookV1 = {
          schema: 'texttrends/query-notebook/3',
          groups: [...state.notebook.groups, group],
        };
        const active = new Set(state.activeGroupIds);
        if (active.size < MAX_SERIES) active.add(group.id);
        adoptNotebook({ notebook, activeGroupIds: active }, { reissue: active.has(group.id) });
      },

      showFrequencyTermInKwic(key) {
        const label = key.normalize('NFC');
        const state = get();
        const probe: NotebookGroupV1 = {
          id: 'probe',
          aliases: [label],
          exactMatch: true,
          countOverlaps: false,
          style: firstFreeStyle(state.notebook.groups, state.activeGroupIds),
        };
        const group = state.notebook.groups.find(
          (candidate) => groupIdentity(candidate) === groupIdentity(probe),
        );
        if (!group) {
          get().addFrequencyTerm(key);
          const added = get().notebook.groups.find(
            (candidate) => groupIdentity(candidate) === groupIdentity(probe),
          );
          if (added && get().activeGroupIds.has(added.id)) {
            get().setFocus(added.id);
            get().setPlace('concordance');
          } else if (added) {
            refuseNotebook('term added; deactivate another term before showing it in concordance');
          }
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
        get().setPlace('concordance');
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
        // (visibly — the shading and overlays drop) so the clicked occurrence
        // can appear in the range-scoped concordance (ruling §2).
        const sel = state.linkedSelection;
        if (sel !== null && !selectionContains(sel, doc, token)) {
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
        // IMMEDIATE navigation: cancel any pending debounce and adopt the
        // position as the concordance center (like the chip toggle path).
        if (kwicCenterTimer !== null) { clearTimeout(kwicCenterTimer); kwicCenterTimer = null; }
        kwicCenter = origin ? { doc, token, origin: 'bucket', bucketCount: origin.count } : { doc, token };
        runKwic();
      },

      // ── Session command wrappers ──────────────────────────────────────────
      openBuiltinCorpus(id) {
        const current = get().projectSession?.project;
        if (current?.id === id) return;
        const option = builtinCorpusOption(id);
        if (option === undefined) {
          set({ commandError: `unknown built-in corpus '${id}'` });
          return;
        }
        let opened = false;
        command((s) => {
          s.openBuiltinProject(id);
          opened = true;
        });
        if (opened) seedDemoNotebook(option.defaultTerms);
      },
      importFiles(files) {
        command((s) => {
          if (s.getState().project.kind === 'builtin') s.createLibraryCorpus(files);
          else s.appendFiles(files);
        });
      },
      removeImport(doc) {
        command((s) => s.removeImport(doc));
      },
      removeDocument(doc) {
        command((s) => s.removeDocument(doc));
      },
      removeDocuments(docs) {
        command((s) => s.removeDocuments(docs));
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
      retryAnalysis() {
        command((s) => s.start());
      },
      clearCommandError() {
        set({ commandError: null });
      },
      retryWorkspaceSave() {
        workspacePausedKey = null;
        saveWorkspaceNow();
      },
      restoreWorkspace(workspace) {
        const state = get();
        const fittedRestoredTrendBins = fitTrendBinsToCorpus(
          state,
          workspace.views.trend.bins,
          true,
        );
        const restoredTrendBins = fittedRestoredTrendBins ?? state.trendBins;
        const restoredTrendBinsChanged =
          restoredTrendBins.mode !== workspace.views.trend.bins.mode
          || restoredTrendBins.count !== workspace.views.trend.bins.count;
        const compare = workspace.views.compare;
        set({
          trendView: workspace.views.trend.mode,
          trendBins: restoredTrendBins,
          trendMeasure: workspace.views.trend.measure,
          trendSettingsNotice: fittedRestoredTrendBins === null
            ? `No trend bin mode can represent this corpus within the ${TREND_MAX_ROWS.toLocaleString()}-row result limit.`
            : restoredTrendBinsChanged
              ? trendGeometryNotice(workspace.views.trend.bins, restoredTrendBins)
              : null,
          focusedDoc: workspace.views.trend.focusedDoc,
          frequencyView: {
            schema: 'texttrends/frequency-view/1',
            minCount: workspace.views.frequency.minCount,
            minDocFreq: workspace.views.frequency.minDocFreq,
            classes: workspace.views.frequency.classes,
            ...(workspace.views.frequency.prefixNfc === undefined
              ? {}
              : { prefixNfc: workspace.views.frequency.prefixNfc }),
            sort: workspace.views.frequency.sort,
            page: { offset: 0, limit: workspace.views.frequency.pageSize },
          },
          keynessView: {
            schema: 'texttrends/keyness-view/1',
            mode: compare.mode,
            documentA: compare.documentA,
            documentB: compare.documentB,
            restOn: compare.restOn,
            minCountTotal: compare.minCountTotal,
            minDocFreqTotal: compare.minDocFreqTotal,
            classes: compare.classes,
            sort: compare.sort,
            pageLimit: compare.pageSize,
            offsetA: 0,
            offsetB: 0,
          },
          removedGroups: [],
        });
        adoptNotebook(
          {
            notebook: workspace.notebook,
            activeGroupIds: new Set(workspace.active),
            kwicEnabledGroupIds: new Set(workspace.kwicEnabled),
            soloGroupId: null,
          },
          { reissue: true },
        );
        get().runInventory();
        get().runFrequency();
        get().runKeyness();
      },
    };
  });

  const reconcileHistory = (): void => {
    if (historyPort === null || disposed) return;
    const requestedFocusTo = pendingBackFocusTo;
    pendingBackFocusTo = null;
    historyTraversalPending = false;
    const previous = store.getState();
    const route = routeFromUrl(historyPort.url);
    const parsed = parseLayerHistory(historyPort.state);
    const reconciled = reconcileLayerRefs(parsed.refs, resolveLayer);
    let layers = reconciled.layers;
    let staleReader = false;
    const readerIndex = layers.findIndex((layer) => layer.kind === 'reader');
    let readerPlace: ReaderPlace | null = null;
    if (readerIndex >= 0) {
      const layer = layers[readerIndex]!;
      readerPlace = liveReaderPlace(
        layer.target,
        previous.snapshot?.snapshot ?? null,
        previous.snapshot?.readyDocs ?? [],
      );
      if (readerPlace === null) {
        layers = layers.slice(0, readerIndex);
        staleReader = true;
      }
    }
    const readerChanged = !sameReaderPlace(previous.readerPlace, readerPlace);
    if (readerChanged) readerLane.supersede();
    store.setState((state) => ({
      place: route.place,
      layers,
      notebookError: route.place === state.place ? state.notebookError : null,
      readerPlace,
      readerPage: readerChanged ? null : state.readerPage,
      readerVisibleRange: readerChanged ? null : state.readerVisibleRange,
      readerNavigation: readerChanged ? null : state.readerNavigation,
    }));
    const normalizedUrl = urlWithRoute(historyPort.url, { place: route.place });
    if (
      !parsed.valid
      || reconciled.truncated
      || staleReader
      || relativeHistoryUrl(historyPort.url) !== normalizedUrl
    ) {
      historyPort.replace(historyStateFor(layers), normalizedUrl);
    }
    const removed = previous.layers.find(
      (candidate) => !layers.some((layer) => layer.id === candidate.id),
    );
    if (removed) {
      restoreFocusTo(requestedFocusTo ?? removed.returnFocusTo);
    }
    if (readerPlace !== null && readerChanged) {
      store.getState().runReader();
    }
  };
  const unsubscribeHistory = historyPort?.subscribe(reconcileHistory) ?? (() => undefined);

  const clearWorkspaceTimer = (): void => {
    if (workspaceSaveTimer !== null) {
      clearTimeout(workspaceSaveTimer);
      workspaceSaveTimer = null;
    }
  };

  const scheduleWorkspaceSave = (): void => {
    if (
      disposed ||
      !workspaceHydrated ||
      workspaceStore === null
    ) {
      return;
    }
    if (workspaceScheduling) return;
    workspaceScheduling = true;
    clearWorkspaceTimer();
    if (store.getState().workspacePersistence.phase !== 'dirty') {
      store.setState({ workspacePersistence: { phase: 'dirty' } });
    }
    workspaceSaveTimer = setTimeout(() => {
      workspaceSaveTimer = null;
      saveWorkspaceNow();
    }, 1_500);
    workspaceScheduling = false;
  };

  saveWorkspaceNow = (): void => {
    if (disposed || !workspaceHydrated || workspaceStore === null) return;
    const workspace = workspaceFromApp(store.getState());
    const issuedKey = workspaceSemanticKey(store.getState());
    if (workspace === null || issuedKey === null) return;
    clearWorkspaceTimer();
    const token = ++workspaceSaveToken;
    workspaceScheduling = true;
    try {
      store.setState({ workspacePersistence: { phase: 'saving' } });
    } finally {
      workspaceScheduling = false;
    }
    void workspaceStore.saveWorkspace(workspace).then(() => {
      if (disposed || token !== workspaceSaveToken) return;
      workspacePausedKey = null;
      workspaceLastKey = issuedKey;
      const liveKey = workspaceSemanticKey(store.getState());
      if (liveKey === issuedKey) {
        store.setState({ workspacePersistence: { phase: 'saved' } });
      } else {
        scheduleWorkspaceSave();
      }
    }).catch((error: unknown) => {
      if (disposed || token !== workspaceSaveToken) return;
      workspacePausedKey = workspaceSemanticKey(store.getState());
      store.setState({
        workspacePersistence: {
          phase: 'error',
          message: `Workspace could not be saved: ${msg(error)}`,
        },
      });
    });
  };

  const unsubscribeWorkspace = store.subscribe((state) => {
    if (!workspaceHydrated) return;
    const key = workspaceSemanticKey(state);
    if (key === workspacePausedKey) return;
    if (workspacePausedKey !== null) workspacePausedKey = null;
    if (key !== workspaceLastKey) scheduleWorkspaceSave();
  });

  const flushWorkspace = (): void => {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden' &&
      workspaceSaveTimer !== null
    ) {
      saveWorkspaceNow();
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', flushWorkspace);
  }

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
    // ready set (and thus the focus) is stable — the detail view never churns on an
    // unrelated (sources/save) publication.
    const focusedDoc = resolveFocusedDoc(store.getState().focusedDoc, next);
    const keynessView = reconcileKeynessView(
      store.getState().keynessView,
      next.snapshot?.readyDocs ?? next.project.data.order,
    );
    store.setState({
      bootstrap: { phase: 'attached' },
      projectSession: next,
      snapshot: next.snapshot,
      loadingPhase: describeAnalysis(next.analysis),
      loadError: next.analysis.phase === 'error' ? next.analysis.message : null,
      focusedDoc,
      keynessView,
      corpusTokenCounts: prevKey !== nextKey
        ? new Map()
        : store.getState().corpusTokenCounts,
      trendSettingsNotice: prevKey !== nextKey
        ? null
        : store.getState().trendSettingsNotice,
      removedGroups: store.getState().projectSession?.project.id !== next.project.id
        ? []
        : store.getState().removedGroups,
    });
    if (prevKey !== nextKey) {
      readerLane.supersede();
      occurrenceLane.supersede();
      footerPassageLane.supersede();
      footerPassageActive = null;
      footerPassagePending = null;
      const live = store.getState();
      const readerLive =
        live.readerPlace !== null
        && live.readerPlace.snapshot === (live.snapshot?.snapshot ?? null)
        && (live.snapshot?.readyDocs.includes(live.readerPlace.doc) ?? false);
      if (!readerLive && live.readerPlace !== null) {
        const readerIndex = live.layers.findIndex((layer) => layer.kind === 'reader');
        const layers = readerIndex < 0
          ? live.layers
          : live.layers.slice(0, readerIndex);
        // Snapshot invalidation is store-driven, not a user Back intent:
        // consume the now-unresolvable current entry in place.
        if (historyPort !== null) {
          historyPort.replace(
            historyStateFor(layers),
            urlWithRoute(historyPort.url, { place: live.place }),
          );
        }
        store.setState({
          layers,
          readerPlace: null,
          readerPage: null,
          readerVisibleRange: null,
          readerNavigation: null,
        });
      }
      store.getState().runQueries();
      store.getState().runInventory();
      store.getState().runFrequency();
      store.getState().runKeyness();
    }
  };

  return {
    useApp: store,
    attachSession(next: SessionPort, workspace?: WorkspaceV1, workspacePort?: WorkspaceStorePort) {
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
      if (workspacePort !== undefined) {
        if (workspaceStore !== null && workspaceStore !== workspacePort) {
          throw new Error('a different workspace store is already connected');
        }
        workspaceStore = workspacePort;
      }
      attached = true;
      session = next;
      // Subscribe first, then seed from the current state (subscribe does not
      // replay). Ordering matches the ruling: subscribe → seed → start (start
      // is the caller's, after this returns).
      unsubscribe = next.subscribe(acceptSessionState);
      acceptSessionState(next.getState());
      if (workspace !== undefined) store.getState().restoreWorkspace(workspace);
      if (workspaceStore !== null) {
        workspaceHydrated = true;
        workspaceLastKey = workspaceSemanticKey(store.getState());
        store.setState({ workspacePersistence: { phase: 'saved' } });
      }
    },
    failBootstrap(error: unknown) {
      if (disposed) return; // a torn-down runtime reports nothing
      store.setState({ bootstrap: { phase: 'error', message: msg(error) } });
    },
    reportNotice(message: string) {
      if (!disposed) store.setState({ commandError: message });
    },
    dispose() {
      disposed = true;
      // Close the ownership scope FIRST: every outstanding lease goes dead, so
      // a late settlement (even one whose cancel is never acknowledged) can no
      // longer write to the store. Then best-effort transport cleanup: cancel
      // every in-flight query and stop the debounce timer so it cannot mint a
      // query after disposal.
      scope.close();
      trendLane.supersede();
      kwicLane.supersede();
      dispersionLane.supersede();
      selectedTrendLane.supersede();
      selectedDispersionLane.supersede();
      inventoryLane.supersede();
      frequencyLane.supersede();
      keynessALane.supersede();
      keynessBLane.supersede();
      keynessInventoryALane.supersede();
      keynessInventoryBLane.supersede();
      readerLane.supersede();
      occurrenceLane.supersede();
      footerPassageLane.supersede();
      footerPassageActive = null;
      footerPassagePending = null;
      const state = store.getState();
      const readerIndex = state.layers.findIndex((layer) => layer.kind === 'reader');
      if (readerIndex >= 0 || state.readerPlace !== null) {
        const layers = readerIndex < 0
          ? state.layers
          : state.layers.slice(0, readerIndex);
        if (historyPort !== null) {
          historyPort.replace(
            historyStateFor(layers),
            urlWithRoute(historyPort.url, { place: state.place }),
          );
        }
        store.setState({
          layers,
          readerPlace: null,
          readerPage: null,
          readerVisibleRange: null,
          readerNavigation: null,
        });
      }
      if (kwicCenterTimer !== null) {
        clearTimeout(kwicCenterTimer);
        kwicCenterTimer = null;
      }
      clearWorkspaceTimer();
      workspaceSaveToken += 1;
      unsubscribeHistory();
      unsubscribeWorkspace();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', flushWorkspace);
      }
      unsubscribe?.();
      unsubscribe = null;
      session?.dispose();
      session = null;
    },
  };
}
