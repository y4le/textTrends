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
 * so components talk only to the store. Query and matches work stay here:
 * they are
 * request/response operations, not competing listeners.
 *
 * Query-notebook intent (slice-1 notebook ruling):
 * the authoritative query model is an ordered notebook of term GROUPS, each
 * a stable UUID + display name + authored core members. The comparison is
 * the ≤MAX_SERIES ACTIVE groups (solo temporarily narrows to one); `series`
 * is the stored projection the panels consume. TWO identities, never
 * conflated: the UUID is presentation identity (style, matches membership,
 * result keys); `termGroupIdentity` is matching
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
 * Intent discipline (UI review round 1, extended): trend intent and
 * matches-window intent are SEPARATE latest-wins lanes (operation leases
 * over one runtime scope). Changing the compared terms or the snapshot
 * cancels and reissues both. Matches is a merged multi-term,
 * full-corpus view independent of `linkedSelection`.
 * `setScrub` publishes only the shared reading cursor; the mounted surface
 * requests a bounded rank/position window. Exact evidence may additionally
 * carry a one-shot row identity for duplicate-position disambiguation. A
 * result is written only while its lease holds — latest in its lane, scope
 * alive, AND the captured (generation, snapshot) identity guard — so a slow
 * stale query can never relabel itself, even after disposal.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  canonicalJson,
  COMPANY_GAP_EDGES_V1,
  DESTINATION_MAX_RESULTS,
  DESTINATION_WINDOW_TOKENS_V1,
  type MatchesAnchorV1,
  type MatchesAxisArraysV1,
  DISPERSION_BUCKET_BUDGET,
  DISPERSION_EXACT_MAX,
  FREQUENCY_FILTER_MAX_UNITS,
  KWIC_MAX_PAGE,
  MAX_KWIC_TRACKS,
  parseWorkspaceTrendView,
  STOPLIST_EN_ID,
  STOPLIST_EN_VERSION,
  STOPLIST_MAX_TOP_N,
  TREND_MAX_ROWS,
  TREND_RATE_DENOMINATOR,
  termGroupIdentity,
  type GroupMember,
  type FrequencyTextFilterV1,
  type KwicContextMark,
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
  type TokenRangeSelectionV1,
} from './selection.ts';
import { fullTokenCountsForDocs } from './doc-tokens.ts';
import { trendBinLimits } from './trend-settings.ts';
import { COMPARE_MAX_RESIDENT_ROWS } from './compare-scroll.ts';
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
  normalizeAuthoredAliases,
  parseQuickAdd,
  resolveActiveStyleCollisions,
  stylesVisuallyCollide,
  validateNotebookGroup,
  type NotebookGroupV1,
  type QueryNotebookV1,
  type SeriesStyleV1,
} from './notebook.ts';
import { isCancelled, WorkerClientError } from './client.ts';
import type { SnapshotInfo } from './client.ts';
import {
  compileFindQuery,
  findScope,
  findWrapped,
  NO_INTERACTION,
  type FindDispersionState,
  type FindSeekState,
  type FindTrendState,
  type InteractionState,
  type PrimaryInteraction,
} from './interaction.ts';
import {
  clampRsvpPacing,
  RSVP_PACING_DEFAULTS,
  type RsvpPacing,
} from '@texttrends/rsvp';
import {
  LatestOperation,
  OperationScope,
  type OperationLease,
} from './operation-lease.ts';
import type {
  CompanyResultV1,
  DestinationsResultV1,
  MatchesWindowResultV1,
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
  clampMatchesColumnWidth,
  MATCHES_COLUMN_DEFAULTS,
  MATCHES_CONTEXT_TOKENS,
  MATCHES_CONTEXT_TOKENS_MAX,
  type MatchesColumn,
  type MatchesColumnSettings,
} from './matches-columns.ts';
import {
  SessionCommandError,
  type AnalysisPhase,
  type ProjectView,
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
import { parseRoute, routeSearch, type RouteV1 } from './route.ts';
import type { HistoryPort } from './history-port.ts';
import { PLACES, type Place } from './places.ts';
import { DEFAULT_TREND_VIEW, type TrendView } from './trend-view.ts';

/** Source budgets are call-site intent, not the worker's protocol ceiling.
 * The footer is latency-sensitive and only renders one clipped passage; the
 * full Reader gets a larger reservoir for browser-measured pages. */
const FOOTER_PASSAGE_MAX_TOKENS = 400;
const READER_SOURCE_MAX_TOKENS = 4_096;

export interface KwicRowView {
  /** The series (track) that produced this row — the merged match set tags
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
  readonly leftMarks: readonly KwicContextMark[];
  readonly leftMarksTruncated: boolean;
  readonly nodeText: string;
  readonly right: string;
  readonly rightMarks: readonly KwicContextMark[];
  readonly rightMarksTruncated: boolean;
}

/** The full occurrence key of a match row — stable and collision-free
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

/** The max compared/matches terms — one authority, shared with the kwic
 *  track cap so a series set can always be sent as matches tracks. */
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

export interface MatchesWindowView {
  readonly total: number;
  readonly trackCount: number;
  readonly anchorRank: number | null;
  readonly firstRank: number;
  readonly before: number;
  readonly after: number;
  readonly contextTokens: number;
  readonly preceding: MatchesWindowResultV1['preceding'];
  readonly rows: readonly KwicRowView[];
  /** Exact activation disambiguation, consumed into this landed window. */
  readonly revealRank: number | null;
}

export interface MatchesRevealTarget {
  readonly snapshot: string;
  readonly trackKey: string;
  readonly seriesId: string;
  readonly groupId?: string;
  readonly doc: string;
  readonly token: number;
  readonly members?: readonly number[];
}

export type MatchesActivationOrigin =
  | { readonly kind: 'bucket'; readonly count: number }
  | {
      readonly kind: 'occurrence';
      readonly groupId?: string;
      readonly members?: readonly number[];
    };

/** The bounded resident window and sparse axis for the active comparison. */
export interface KwicState {
  readonly snapshot: string;
  readonly trackKey: string;
  readonly request: {
    readonly anchor: MatchesAnchorV1;
    readonly before: number;
    readonly after: number;
    readonly contextTokens: number;
  } | null;
  readonly axis: MatchesAxisArraysV1 | null;
  /** Retained while a neighboring window is pending, so bounded navigation
   * never blanks already materialized rows. */
  readonly resident: MatchesWindowView | null;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready' }
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

/** Stable series identities for a strict pair-focused destination request.
 * The worker receives ordinals derived from the canonical overview track
 * order; presentation reorder therefore never changes the analytical intent. */
export interface DestinationFocusIntent {
  readonly seriesIds: readonly [string, string];
}

export interface CompanyState {
  readonly snapshot: string;
  /** Ordered matching identities, canonicalized independently of notebook
   * presentation order. This is the semantic resident-result key. */
  readonly trackKey: string;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly result: CompanyResultV1 }
    | { readonly status: 'error'; readonly message: string };
}

export interface DestinationsState {
  readonly snapshot: string;
  /** Track identity plus stable pair focus; exact ready results can survive a
   * temporary linked selection and reappear without recomputation. */
  readonly resultKey: string;
  readonly focus: DestinationFocusIntent | null;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly result: DestinationsResultV1 }
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

export interface FrequencyViewV2 {
  readonly schema: 'texttrends/frequency-view/2';
  readonly minCount: number;
  readonly minDocFreq: number;
  readonly classes: readonly FrequencyTokenClassV1[];
  readonly stoplistTopN: number;
  readonly filter?: FrequencyTextFilterV1;
  readonly sort: { readonly by: FrequencySortFieldV1; readonly dir: 1 | -1 };
  readonly page: { readonly offset: number; readonly limit: number };
}

export interface FrequencyState {
  readonly snapshot: string;
  readonly selection: TokenRangeSelectionV1 | null;
  readonly view: FrequencyViewV2;
  /** Authenticated rows retained while the next chunk is in flight. */
  readonly resident: FrequencyListResultV1 | null;
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
  readonly stoplistTopN: number;
  readonly sort: {
    readonly by: KeynessSortFieldV1;
    readonly dirA: 1 | -1;
    readonly dirB: 1 | -1;
  };
  readonly showConfidenceIntervals: boolean;
  readonly pageLimit: number;
}

export interface KeynessSettingsInputV1 {
  readonly minCountTotal: number;
  readonly minDocFreqTotal: number;
  readonly classes: readonly FrequencyTokenClassV1[];
  readonly stoplistTopN: number;
  readonly sortBy: KeynessSortFieldV1;
  readonly dirA: 1 | -1;
  readonly dirB: 1 | -1;
  readonly showConfidenceIntervals: boolean;
}

export interface KeynessTableState {
  readonly snapshot: string;
  readonly side: 'a' | 'b';
  readonly view: KeynessViewV1;
  /** Authenticated ranks retained while the next viewport chunk is in flight. */
  readonly resident: KeynessResultV1 | null;
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
  mode: 'document-rest',
  documentA: null,
  documentB: null,
  restOn: 'b',
  minCountTotal: 5,
  minDocFreqTotal: 2,
  classes: Object.freeze(['lexical'] as const),
  stoplistTopN: 0,
  sort: Object.freeze({
    by: 'logRatio' as const,
    dirA: -1 as const,
    dirB: 1 as const,
  }),
  showConfidenceIntervals: false,
  pageLimit: 100,
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
    view.stoplistTopN,
    { by: view.sort.by, dir: side === 'a' ? view.sort.dirA : view.sort.dirB },
    view.pageLimit,
    side,
  ]);
}

export type { TrendView } from './trend-view.ts';

export interface TrendSettingsInput {
  readonly bins: TrendBinsSpecV1;
  readonly measure: WorkspaceTrendMeasureV1;
}

export type TrendSettingsOutcome = 'applied' | 'unchanged' | 'rejected';

export interface RemovedNotebookGroup {
  readonly group: NotebookGroupV1;
  readonly index: number;
  readonly active: boolean;
  readonly solo: boolean;
}

export interface MatchesView {
  readonly columns: MatchesColumnSettings;
}

/** The scrubbed reading position — document-local, view-independent. */
export interface ScrubTarget {
  readonly doc: string;
  readonly token: number;
}

/** One exact any-active-term navigation intent. The worker returns one bounded
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
): string {
  if (navigation === null) return '';
  const way = navigation.direction === 1 ? 'next' : 'previous';
  switch (navigation.state.status) {
    case 'pending': return `finding ${way} reference from any term`;
    case 'ready': return `${way} reference from any term`;
    case 'edge': return `no references from any term`;
    case 'error': return `reference navigation failed: ${navigation.state.message}`;
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
  /** Place-independent informational notice (startup reconciliation, etc.). */
  appNotice: string | null;
  workspacePersistence: WorkspacePersistenceState;

  /** The one primary interaction state. Utility panes and future cursor
   * pinning are orthogonal; future command/speed modes extend this union. */
  interaction: InteractionState;
  /** One bounded Find authoring refusal, separate from a submitted query. */
  interactionError: string | null;
  enterFind(): void;
  submitFind(raw: string): boolean;
  stepFind(direction: 1 | -1): void;
  exitInteraction(): void;
  clearInteractionError(): void;
  enterRsvp(playing: boolean): void;
  setRsvpPlaying(playing: boolean): void;
  setRsvpPacing(patch: Partial<RsvpPacing>): void;
  publishRsvpPosition(token: number): void;
  rsvpSeek(token: number): void;
  exitRsvp(token: number): void;

  // ── Route/layer state: session presentation, never research data. ──
  place: Place;
  /** A p-less URL waits for the attached corpus before choosing Inputs or
   * Trends. Explicit links are resolved immediately and always win. */
  routeStatus: 'pending' | 'resolved';
  layers: readonly Layer[];
  setPlace(place: Place): void;
  /** Correct an unavailable place without adding a history entry. */
  replacePlace(place: Place): void;
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
   *  marks, and matches eligibility). Order is notebook order. Never silently
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
  /** Add demo suggestions without replacing authored terms. Valid new terms
   *  enter the notebook; as many as fit also become active. */
  mergeStarterTerms(input: string): { readonly added: number; readonly activated: number; readonly skipped: number };
  /** Seeded 'pending' per issued series — panels must not show stale arrays. */
  trends: ReadonlyMap<string, SeriesTrendState>;
  kwic: KwicState | null;
  /** One-shot exact activation intent; consumed by the next matching window. */
  matchesReveal: MatchesRevealTarget | null;
  /** Tab-local Matches controls. Kept outside portable workspace semantics. */
  matchesView: MatchesView;
  /** The barcode's dispersion result (null = no comparison/corpus). */
  dispersion: DispersionState | null;
  /** Full-corpus no-selection overview lanes. They are independently owned so
   * one analysis can fail without blanking the other. */
  company: CompanyState | null;
  destinations: DestinationsState | null;
  /** Stable series-id focus; only the Destinations lane depends on it. */
  destinationFocus: DestinationFocusIntent | null;
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
  /** Canonical full-corpus measurements for Inputs. Unlike `inventory`, this
   * lane is never replaced or cancelled by a linked Trends range. */
  corpusInventory: InventoryState | null;
  /** Snapshot-bound full-document extents survive a range-scoped inventory
   * replacing the visible corpus inventory. Cleared on snapshot identity. */
  corpusTokenCounts: ReadonlyMap<string, number>;
  frequencyView: FrequencyViewV2;
  frequency: FrequencyState | null;
  /** Comparison-owned, brush-independent two-side keyness research intent. */
  keynessView: KeynessViewV1;
  keynessA: KeynessTableState | null;
  keynessB: KeynessTableState | null;
  keynessInventoryA: KeynessInventoryState | null;
  keynessInventoryB: KeynessInventoryState | null;
  /** Durable choice restored when the corpus has enough texts to expose all
   * presentations. `trendView` may temporarily be `series` for one text. */
  trendViewPreference: TrendView;
  trendView: TrendView;
  /** Durable result geometry and resident-data display transform. Bin changes
   * reissue only baseline + selected trend lanes; measure changes query
   * nothing. */
  trendBins: TrendBinsSpecV1;
  trendMeasure: WorkspaceTrendMeasureV1;
  /** Resident explanation for automatic geometry normalization or a corpus
   * that cannot satisfy the bounded trend protocol. */
  trendSettingsNotice: string | null;
  scrub: ScrubTarget | null;
  /** Transient, snapshot-bound source text for the global reading footer. */
  footerPassage: FooterPassageState | null;
  /** Latest exact w/b navigation request and its accessible outcome. */
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
   *  group and active; a term already in the notebook
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
  requestMatchesWindow(
    anchor: MatchesAnchorV1,
    window?: {
      readonly before: number;
      readonly after: number;
      readonly contextTokens?: number;
    },
  ): void;
  setMatchesColumnWidth(column: MatchesColumn, width: number): void;
  setMatchesContextWeights(left: number, right: number): void;
  resetMatchesColumn(column: MatchesColumn): void;
  resetMatchesColumns(): void;
  setTrendView(view: TrendView): void;
  applyTrendSettings(input: TrendSettingsInput): TrendSettingsOutcome;
  /** Reveal an activated barcode occurrence immediately. Density midpoints
   *  publish only the shared cursor, never an exact reveal target. */
  centerKwicAt(seriesId: string, doc: string, token: number, origin?: MatchesActivationOrigin): void;
  /** Commit explicit per-document spans from one contiguous reading-order
   *  gesture. Reissues detail consumers; baseline results remain resident.
   *  Null clears. */
  setLinkedSelection(selection: TokenRangeSelectionV1 | null): void;
  /** Focus Reading Destinations on one Company pair. Null restores the
   * all-track ranking; invalid/inactive pairs are ignored. */
  setDestinationFocus(seriesIds: readonly [string, string] | null): void;
  runInventory(): void;
  runFrequency(retainResident?: boolean): void;
  loadMoreFrequency(): void;
  setFrequencySort(by: FrequencySortFieldV1): void;
  setFrequencyFilter(filter: FrequencyTextFilterV1 | null): void;
  setFrequencyStoplistTopN(topN: number): void;
  setFrequencyPage(offset: number): void;
  addFrequencyTerm(key: string): void;
  showFrequencyTermInKwic(key: string): void;
  runKeyness(): void;
  loadMoreKeyness(side: 'a' | 'b'): void;
  /** Restore the default first-document-v-rest comparison. The document may
   * still be importing; the reset remains pending until it is ready. */
  resetKeynessComparison(doc: string): void;
  setKeynessMode(mode: KeynessViewV1['mode']): void;
  setKeynessDocument(side: 'a' | 'b', doc: string): void;
  /** Set one visible compare selector. Null represents all ready documents
   * except the single document selected on the opposite side. */
  setKeynessSelection(side: 'a' | 'b', doc: string | null): void;
  swapKeynessSides(): void;
  applyKeynessSettings(input: KeynessSettingsInputV1): void;
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
  /** True when the session accepted the batch; false when a command boundary
   *  refused it and published `commandError`. */
  importFiles(files: readonly LocalLibraryFile[]): boolean;
  removeImport(doc: string): void;
  removeDocument(doc: string): void;
  removeDocuments(docs: readonly string[]): void;
  /** Clear the active corpus and the complete term notebook as one user
   *  command. Saved library bytes remain independently owned. */
  clearActiveInputsAndTerms(): { readonly texts: number; readonly terms: number };
  editMeta(doc: string, patch: MetaPatch): void;
  setLanguage(doc: string, language: string): void;
  reorder(order: readonly string[]): void;
  /** Reopen analysis on the SAME lifetime session (post-error retry). */
  retryAnalysis(): void;
  clearCommandError(): void;
  clearAppNotice(): void;
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
  /** Surface a non-fatal startup durability failure through the normal retry UI. */
  reportWorkspaceFailure(error: unknown): void;
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

function queryErrorMessage(e: unknown): string {
  return e instanceof WorkerClientError && e.analysisCode === 'CAP_EXCEEDED'
    ? 'Too many occurrences to analyse at once — narrow the selected range or corpus.'
    : msg(e);
}

function findErrorMessage(e: unknown): string {
  return e instanceof WorkerClientError && e.analysisCode === 'CAP_EXCEEDED'
    ? 'This query occurs too often to navigate exactly — try a longer phrase.'
    : queryErrorMessage(e);
}

function overviewQueryErrorMessage(e: unknown): string {
  return e instanceof WorkerClientError && e.analysisCode === 'CAP_EXCEEDED'
    ? 'This overview is too large to analyse exactly — remove a tracked term or text.'
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

function regexForLegacyFrequencyPrefix(prefix: string): string {
  return `^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`;
}

export function workspaceFromApp(state: AppState): WorkspaceV1 | null {
  const project = state.projectSession?.project;
  if (!project) return null;
  if (project.kind === 'library' && project.data.docs.some((doc) => doc.library === undefined)) return null;
  const { filter, ...frequency } = state.frequencyView;
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
    // Deprecated workspace/1 compatibility field. Matches now follows
    // the shared active projection, so new saves mirror `active` here.
    kwicEnabled: state.notebook.groups
      .filter((group) => state.activeGroupIds.has(group.id))
      .map((group) => group.id),
    views: {
      trend: {
        mode: state.trendViewPreference,
        bins: state.trendBins,
        measure: state.trendMeasure,
      },
      frequency: {
        minCount: frequency.minCount,
        minDocFreq: frequency.minDocFreq,
        classes: frequency.classes,
        stoplistTopN: frequency.stoplistTopN,
        ...(filter === undefined ? {} : { filter }),
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
        stoplistTopN: state.keynessView.stoplistTopN,
        sort: state.keynessView.sort,
        showConfidenceIntervals: state.keynessView.showConfidenceIntervals,
        pageSize: state.keynessView.pageLimit,
      },
    },
  };
}

/** A fresh install is a durable, fully valid local workspace with no inputs.
 *  Demo content is an explicit acquisition, never implicit project state. */
export function emptyLibraryWorkspace(): WorkspaceV1 {
  return {
    schema: 'texttrends/workspace/1',
    corpus: { kind: 'library', order: [], docs: [] },
    notebook: { schema: 'texttrends/query-notebook/3', groups: [] },
    active: [],
    kwicEnabled: [],
    views: {
      trend: {
        mode: DEFAULT_TREND_VIEW,
        bins: DEFAULT_TREND_BINS,
        measure: DEFAULT_TREND_MEASURE,
      },
      frequency: {
        minCount: 1,
        minDocFreq: 1,
        classes: ['lexical'],
        stoplistTopN: 0,
        sort: { by: 'count', dir: -1 },
        pageSize: 100,
      },
      compare: {
        mode: DEFAULT_KEYNESS_VIEW.mode,
        documentA: null,
        documentB: null,
        restOn: DEFAULT_KEYNESS_VIEW.restOn,
        minCountTotal: DEFAULT_KEYNESS_VIEW.minCountTotal,
        minDocFreqTotal: DEFAULT_KEYNESS_VIEW.minDocFreqTotal,
        classes: DEFAULT_KEYNESS_VIEW.classes,
        stoplistTopN: DEFAULT_KEYNESS_VIEW.stoplistTopN,
        sort: DEFAULT_KEYNESS_VIEW.sort,
        showConfidenceIntervals: DEFAULT_KEYNESS_VIEW.showConfidenceIntervals,
        pageSize: DEFAULT_KEYNESS_VIEW.pageLimit,
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

function routeFromUrl(url: string): RouteV1 {
  try {
    return parseRoute(new URL(url, 'https://texttrends.invalid/').search);
  } catch {
    return { place: null };
  }
}

function urlWithRoute(
  url: string,
  route: RouteV1,
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

function defaultPlaceFor(project: ProjectView | null | undefined): Place {
  return (project?.data.order.length ?? 0) === 0 ? 'inputs' : 'trends';
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
    /** Session-restored presentation geometry, separate from workspace semantics. */
    matchesColumns?: MatchesColumnSettings;
    /** Device-local RSVP rhythm, separate from workspace semantics. */
    rsvpPacing?: RsvpPacing;
  },
): AppRuntime {
  const newId = opts?.newId ?? (() => crypto.randomUUID());
  const newLayerId = opts?.newLayerId ?? (() => crypto.randomUUID());
  const historyPort = opts?.history ?? null;
  let lastRsvpPacing = clampRsvpPacing(opts?.rsvpPacing ?? RSVP_PACING_DEFAULTS);
  let workspaceStore = opts?.workspace ?? null;
  // Ownership: ONE scope for the runtime lifetime (closed on dispose) and one
  // lane per query intent. A lease carries the fences the old hand-rolled
  // epochs + captured keys expressed.
  const scope = new OperationScope();
  const trendLane = new QueryLane(scope);
  const matchesLane = new QueryLane(scope);
  // The barcode's dispersion intent — reissued with the trend burst.
  const dispersionLane = new QueryLane(scope);
  // No-selection overview analyses are independent latest-wins lanes. A
  // Company failure or pair-focus change cannot supersede its sibling.
  const companyLane = new QueryLane(scope);
  const destinationsLane = new QueryLane(scope);
  // Selected-range overlay lanes — separate latest-wins ownership so a brush
  // never cancels the resident baseline (ruling §2).
  const selectedTrendLane = new QueryLane(scope);
  const selectedDispersionLane = new QueryLane(scope);
  // Vocabulary-wide analytics are independent of notebook query lanes.
  const inventoryLane = new QueryLane(scope);
  // Inputs presents stable, full-text facts. Its baseline query must be able
  // to land even when a rapid range gesture supersedes the vocabulary lane.
  const corpusInventoryLane = new QueryLane(scope);
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
  // Exact any-term stepping is independent of Reader/footer passage work.
  const occurrenceLane = new QueryLane(scope);
  // Temporary corpus Find is notebook-independent and must not race with the
  // existing any-active-term occurrence navigation lane.
  const findLane = new QueryLane(scope);
  // Find projects one temporary term through the same graph/barcode contracts
  // without superseding or overwriting the durable comparison residents.
  const findTrendLane = new QueryLane(scope);
  const findDispersionLane = new QueryLane(scope);
  // The global reading footer reuses reader-page/1 through a separate lane.
  // Reader navigation and footer scrubbing never supersede one another.
  const footerPassageLane = new QueryLane(scope);
  let footerPassagePending: ScrubTarget | null = null;
  let footerPassageActive: { readonly cancel: () => void } | null = null;
  let footerPassageMargin = 0;

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
  // A demo acquisition knows its declared first document before concurrent
  // extraction has made that document ready. Keep that one-shot intent outside
  // the durable workspace so async completion order cannot choose Book 2.
  let pendingKeynessResetDoc: string | null = null;
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
    ? { place: null }
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
      options: {
        readonly preserveReaderNavigation?: boolean;
        readonly resolveRoute?: boolean;
      } = {},
    ): void => {
      if (historyPort !== null) {
        const routePlace = options.resolveRoute === true || get().routeStatus === 'resolved'
          ? place
          : null;
        historyPort[mode](
          historyStateFor(layers),
          urlWithRoute(historyPort.url, { place: routePlace }),
        );
      }
      const current = get();
      const readerPlace = readerForLayers(layers, current.snapshot);
      const readerChanged = !sameReaderPlace(current.readerPlace, readerPlace);
      if (readerChanged) readerLane.supersede();
      set((state) => ({
        place,
        routeStatus: options.resolveRoute === true ? 'resolved' : state.routeStatus,
        layers,
        interaction: state.interaction.kind === 'rsvp'
          && (
            readerPlace === null
            || readerPlace.snapshot !== state.interaction.rsvp.snapshot
            || readerPlace.doc !== state.interaction.rsvp.doc
          )
          ? state.interaction.suspended
          : state.interaction,
        notebookError: place === state.place ? state.notebookError : null,
        readerPlace,
        readerPage: readerChanged ? null : state.readerPage,
        readerVisibleRange: readerChanged ? null : state.readerVisibleRange,
        readerNavigation:
          readerChanged && !options.preserveReaderNavigation
            ? null
            : state.readerNavigation,
      }));
      if (current.readerPlace !== null && readerPlace === null && current.scrub !== null) {
        scheduleFooterPassage(current.scrub);
      }
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
      errorMessage: (error: unknown) => string = queryErrorMessage,
    ): void => {
      const handle = client.query(snapshotId, op);
      lane.track(handle.cancel);
      void handle.result
        .then((data) => {
          if (lease.isCurrent()) onReady(data);
        })
        .catch((e: unknown) => {
          if (isCancelled(e) || !lease.isCurrent()) return;
          onError(errorMessage(e));
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
        offset: 0,
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
        resident: null,
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
              ...(issuedView.stoplistTopN === 0 ? {} : {
                stoplist: {
                  id: STOPLIST_EN_ID,
                  version: STOPLIST_EN_VERSION,
                  topN: issuedView.stoplistTopN,
                },
              }),
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
            resident: data.keyness,
            state: { status: 'ready', result: data.keyness },
          });
        },
        (message) => writeKeynessTable(side, {
          snapshot: snapshot.snapshot,
          side,
          view: issuedView,
          resident: null,
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
      const find = findScope(get().interaction)?.find ?? null;
      if (find?.query.seriesId === id) return find.query.identity;
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

    /** Find temporarily replaces the authored comparison for every term-aware
     * presentation consumer while leaving the durable series/results resident. */
    const effectiveTrackSpecs = (
      series: readonly SeriesIntent[],
    ): ReturnType<typeof trackSpecs> => {
      const scoped = findScope(get().interaction);
      if (scoped === null) return trackSpecs(series);
      const find = scoped.find;
      if (find === null) {
        return { wire: [], identities: [], captured: Object.freeze([]) };
      }
      return {
        wire: [{ seriesId: find.query.seriesId, group: find.query.group }],
        identities: [[find.query.seriesId, find.query.identity] as const],
        captured: Object.freeze([Object.freeze({
          seriesId: find.query.seriesId,
          groupId: find.query.group.id,
          identity: find.query.identity,
          label: find.query.label,
          style: find.query.style,
        })]),
      };
    };

    const identitiesCurrent = (pairs: readonly (readonly [string, string])[]): boolean =>
      pairs.every(([id, ident]) => identityOf(id) === ident);

    /** Company/Destinations are set analyses, not notebook-order analyses.
     * Canonical series-id order keeps rename and reorder presentation-only and
     * gives both lanes one stable semantic result key. */
    const overviewTrackSpecs = (
      series: readonly SeriesIntent[],
    ): ReturnType<typeof trackSpecs> => trackSpecs(
      [...series].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );

    const overviewTrackKey = (
      tracks: NonNullable<ReturnType<typeof overviewTrackSpecs>>,
    ): string => canonicalJson(tracks.identities);

    const normalizeDestinationFocus = (
      value: readonly [string, string] | null,
      tracks: NonNullable<ReturnType<typeof overviewTrackSpecs>>,
    ): DestinationFocusIntent | null | undefined => {
      if (value === null) return null;
      const [left, right] = value;
      if (left === right) return undefined;
      const active = new Set(tracks.wire.map((track) => track.seriesId));
      if (!active.has(left) || !active.has(right)) return undefined;
      return {
        seriesIds: left < right ? [left, right] : [right, left],
      };
    };

    const sameDestinationFocus = (
      left: DestinationFocusIntent | null,
      right: DestinationFocusIntent | null,
    ): boolean => left === null
      ? right === null
      : right !== null
        && left.seriesIds[0] === right.seriesIds[0]
        && left.seriesIds[1] === right.seriesIds[1];

    const resultTracksMatch = (
      result: readonly { readonly seriesId: string; readonly groupId: string }[],
      tracks: NonNullable<ReturnType<typeof overviewTrackSpecs>>,
    ): boolean => result.length === tracks.wire.length
      && result.every((track, index) =>
        track.seriesId === tracks.wire[index]!.seriesId
        && track.groupId === tracks.wire[index]!.group.id);

    const runCompanyOverview = (): void => {
      companyLane.supersede();
      const { snapshot, series, linkedSelection, company } = get();
      const tracks = overviewTrackSpecs(series);
      if (!snapshot || tracks === null || tracks.wire.length < 2) {
        set({ company: null });
        return;
      }
      const issuedSnapshotKey = snapKey(snapshot);
      const trackKey = overviewTrackKey(tracks);
      const residentMatches = company?.snapshot === snapshot.snapshot
        && company.trackKey === trackKey;
      if (linkedSelection !== null) {
        if (!residentMatches || company.state.status !== 'ready') set({ company: null });
        return;
      }
      if (residentMatches && company.state.status === 'ready') return;

      const lease = companyLane.ops.begin(
        () => snapKey(get().snapshot) === issuedSnapshotKey,
        () => {
          const liveTracks = overviewTrackSpecs(get().series);
          return liveTracks !== null
            && overviewTrackKey(liveTracks) === trackKey
            && identitiesCurrent(tracks.identities);
        },
        () => get().linkedSelection === null,
      );
      set({
        company: {
          snapshot: snapshot.snapshot,
          trackKey,
          state: { status: 'pending' },
        },
      });
      issueOn(
        companyLane,
        snapshot.snapshot,
        {
          op: 'company',
          tracks: tracks.wire,
          request: { method: 'company/1', gapEdges: COMPANY_GAP_EDGES_V1 },
        },
        lease,
        (data) => {
          if (
            data.op !== 'company'
            || data.company.method !== 'company/1'
            || !resultTracksMatch(data.company.tracks, tracks)
          ) {
            set({
              company: {
                snapshot: snapshot.snapshot,
                trackKey,
                state: { status: 'error', message: 'worker returned mismatched Company data' },
              },
            });
            return;
          }
          set({
            company: {
              snapshot: snapshot.snapshot,
              trackKey,
              state: { status: 'ready', result: data.company },
            },
          });
        },
        (message) => set({
          company: {
            snapshot: snapshot.snapshot,
            trackKey,
            state: { status: 'error', message },
          },
        }),
        overviewQueryErrorMessage,
      );
    };

    const runDestinationsOverview = (): void => {
      destinationsLane.supersede();
      const state = get();
      const { snapshot, series, linkedSelection, destinations } = state;
      const tracks = overviewTrackSpecs(series);
      if (!snapshot || tracks === null || tracks.wire.length === 0) {
        set({ destinations: null, destinationFocus: null });
        return;
      }
      const normalizedFocus = normalizeDestinationFocus(
        state.destinationFocus?.seriesIds ?? null,
        tracks,
      );
      const focus = normalizedFocus === undefined ? null : normalizedFocus;
      if (!sameDestinationFocus(state.destinationFocus, focus)) {
        set({ destinationFocus: focus });
      }
      const trackKey = overviewTrackKey(tracks);
      const resultKey = canonicalJson([trackKey, focus?.seriesIds ?? null]);
      const residentMatches = destinations?.snapshot === snapshot.snapshot
        && destinations.resultKey === resultKey;
      if (linkedSelection !== null) {
        if (!residentMatches || destinations.state.status !== 'ready') {
          set({ destinations: null });
        }
        return;
      }
      if (residentMatches && destinations.state.status === 'ready') return;

      const focusOrdinals = focus === null
        ? null
        : {
            a: tracks.wire.findIndex((track) => track.seriesId === focus.seriesIds[0]),
            b: tracks.wire.findIndex((track) => track.seriesId === focus.seriesIds[1]),
          };
      if (focusOrdinals !== null && (
        focusOrdinals.a < 0
        || focusOrdinals.a >= focusOrdinals.b
        || focusOrdinals.b >= tracks.wire.length
      )) {
        throw new Error('canonical destination focus did not map to ordered tracks');
      }
      const issuedSnapshotKey = snapKey(snapshot);
      const lease = destinationsLane.ops.begin(
        () => snapKey(get().snapshot) === issuedSnapshotKey,
        () => {
          const liveTracks = overviewTrackSpecs(get().series);
          if (liveTracks === null || overviewTrackKey(liveTracks) !== trackKey) return false;
          const liveFocus = normalizeDestinationFocus(
            get().destinationFocus?.seriesIds ?? null,
            liveTracks,
          );
          return liveFocus !== undefined
            && sameDestinationFocus(liveFocus, focus)
            && identitiesCurrent(tracks.identities);
        },
        () => get().linkedSelection === null,
      );
      set({
        destinations: {
          snapshot: snapshot.snapshot,
          resultKey,
          focus,
          state: { status: 'pending' },
        },
      });
      issueOn(
        destinationsLane,
        snapshot.snapshot,
        {
          op: 'destinations',
          tracks: tracks.wire,
          request: {
            method: 'destinations/1',
            windowTokens: DESTINATION_WINDOW_TOKENS_V1,
            limit: DESTINATION_MAX_RESULTS,
            focus: focusOrdinals,
          },
        },
        lease,
        (data) => {
          if (
            data.op !== 'destinations'
            || data.destinations.method !== 'destinations/1'
            || !resultTracksMatch(data.destinations.tracks, tracks)
            || canonicalJson(data.destinations.focus) !== canonicalJson(focusOrdinals)
          ) {
            set({
              destinations: {
                snapshot: snapshot.snapshot,
                resultKey,
                focus,
                state: { status: 'error', message: 'worker returned mismatched Reading Destinations data' },
              },
            });
            return;
          }
          set({
            destinations: {
              snapshot: snapshot.snapshot,
              resultKey,
              focus,
              state: { status: 'ready', result: data.destinations },
            },
          });
        },
        (message) => set({
          destinations: {
            snapshot: snapshot.snapshot,
            resultKey,
            focus,
            state: { status: 'error', message },
          },
        }),
        overviewQueryErrorMessage,
      );
    };

    const runOverview = (): void => {
      runCompanyOverview();
      runDestinationsOverview();
    };

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
      const tracks = effectiveTrackSpecs(series);
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

    const writeFindTrend = (identity: string, state: FindTrendState): void => {
      set((live) => {
        const scoped = findScope(live.interaction);
        if (scoped?.find?.query.identity !== identity) return live;
        const find = { ...scoped.find, trend: state };
        return {
          interaction: live.interaction.kind === 'rsvp'
            ? { ...live.interaction, suspended: { kind: 'find', find } }
            : { kind: 'find', find },
          ...(state.status === 'ready'
            ? { corpusTokenCounts: retainTrendTokenCounts(live.corpusTokenCounts, state.trend) }
            : {}),
        };
      });
    };

    const writeFindDispersion = (identity: string, state: FindDispersionState): void => {
      set((live) => {
        const scoped = findScope(live.interaction);
        if (scoped?.find?.query.identity !== identity) return live;
        const find = { ...scoped.find, dispersion: state };
        return {
          interaction: live.interaction.kind === 'rsvp'
            ? { ...live.interaction, suspended: { kind: 'find', find } }
            : { kind: 'find', find },
        };
      });
    };

    /** Reissue Find's temporary graph without disturbing the resident authored
     * comparison. Bin-policy changes call this alongside the durable lanes. */
    const runFindTrend = (): void => {
      findTrendLane.supersede();
      const { snapshot, interaction, trendBins } = get();
      const find = findScope(interaction)?.find ?? null;
      if (!snapshot || !find || find.snapshot !== snapshot.snapshot) return;
      const issuedKey = snapKey(snapshot);
      const issuedIdentity = find.query.identity;
      const issuedBins = trendBins;
      const lease = findTrendLane.ops.begin(
        () => snapKey(get().snapshot) === issuedKey,
        () => {
          return findScope(get().interaction)?.find?.query.identity === issuedIdentity;
        },
        () => {
          const live = get().trendBins;
          return live.mode === issuedBins.mode && live.count === issuedBins.count;
        },
      );
      writeFindTrend(issuedIdentity, { status: 'pending' });
      issueOn(
        findTrendLane,
        snapshot.snapshot,
        {
          op: 'trend',
          selection: { docs: [...snapshot.readyDocs] },
          group: find.query.group,
          request: { coordinate: 'declared-sequence', bins: issuedBins },
        },
        lease,
        (data) => {
          if (data.op !== 'trend') {
            writeFindTrend(issuedIdentity, {
              status: 'error',
              message: 'worker returned the wrong find trend operation',
            });
            return;
          }
          writeFindTrend(issuedIdentity, { status: 'ready', trend: data.trend });
        },
        (message) => writeFindTrend(issuedIdentity, { status: 'error', message }),
      );
    };

    const runFindDispersion = (): void => {
      findDispersionLane.supersede();
      const { snapshot, interaction } = get();
      const find = findScope(interaction)?.find ?? null;
      if (!snapshot || !find || find.snapshot !== snapshot.snapshot) return;
      const issuedKey = snapKey(snapshot);
      const issuedIdentity = find.query.identity;
      const issuedSeriesId = find.query.seriesId;
      const issuedGroupId = find.query.group.id;
      const lease = findDispersionLane.ops.begin(
        () => snapKey(get().snapshot) === issuedKey,
        () => {
          return findScope(get().interaction)?.find?.query.identity === issuedIdentity;
        },
      );
      writeFindDispersion(issuedIdentity, { status: 'pending' });
      issueOn(
        findDispersionLane,
        snapshot.snapshot,
        {
          op: 'dispersion',
          selection: { docs: [...snapshot.readyDocs] },
          tracks: [{ seriesId: issuedSeriesId, group: find.query.group }],
          request: {
            method: 'dispersion/1',
            exactMax: DISPERSION_EXACT_MAX,
            bucketBudget: DISPERSION_BUCKET_BUDGET,
          },
        },
        lease,
        (data) => {
          if (data.op !== 'dispersion') {
            writeFindDispersion(issuedIdentity, {
              status: 'error',
              message: 'worker returned the wrong find dispersion operation',
            });
            return;
          }
          const [track] = data.dispersion.tracks;
          if (
            data.dispersion.tracks.length !== 1
            || track?.seriesId !== issuedSeriesId
            || track?.groupId !== issuedGroupId
          ) {
            writeFindDispersion(issuedIdentity, {
              status: 'error',
              message: 'worker returned the wrong find dispersion track',
            });
            return;
          }
          writeFindDispersion(issuedIdentity, { status: 'ready', result: data.dispersion });
        },
        (message) => writeFindDispersion(issuedIdentity, { status: 'error', message }),
      );
    };

    const runFindAnalysis = (): void => {
      runFindTrend();
      runFindDispersion();
    };

    /** Reissue only the trend result lanes after a bin-policy change.
     * Dispersion, KWIC, and inventory do not depend on trend bins and must
     * remain resident. */
    const runTrendLanesOnly = () => {
      trendLane.supersede();
      selectedTrendLane.supersede();
      runFindTrend();
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

    const sameAnchor = (left: MatchesAnchorV1, right: MatchesAnchorV1): boolean => {
      if (left.kind !== right.kind) return false;
      if (left.kind === 'rank') return right.kind === 'rank' && left.rank === right.rank;
      return right.kind === 'position'
        && left.doc === right.doc
        && left.token === right.token;
    };

    const compareCorpusPosition = (
      left: { readonly doc: string; readonly token: number },
      right: { readonly doc: string; readonly token: number },
      readyDocs: readonly string[],
    ): number => {
      const leftDoc = readyDocs.indexOf(left.doc);
      const rightDoc = readyDocs.indexOf(right.doc);
      return leftDoc === rightDoc ? left.token - right.token : leftDoc - rightDoc;
    };

    const residentCoversAnchor = (
      resident: MatchesWindowView,
      anchor: MatchesAnchorV1,
      readyDocs: readonly string[],
    ): boolean => {
      if (resident.total === 0) return true;
      if (anchor.kind === 'rank') {
        return anchor.rank >= resident.firstRank
          && anchor.rank < resident.firstRank + resident.rows.length;
      }
      const first = resident.rows[0];
      const last = resident.rows.at(-1);
      if (!first || !last) return false;
      const target = { doc: anchor.doc, token: anchor.token };
      const fromFirst = compareCorpusPosition(
        target,
        { doc: first.doc, token: first.pos },
        readyDocs,
      );
      const fromLast = compareCorpusPosition(
        target,
        { doc: last.doc, token: last.pos },
        readyDocs,
      );
      return (fromFirst >= 0 && fromLast <= 0)
        || (resident.firstRank === 0 && fromFirst <= 0)
        || (resident.firstRank + resident.rows.length === resident.total && fromLast >= 0);
    };

    /** Latest-wins bounded window request. Sparse axes survive neighboring
     * windows under the same snapshot + ordered matching identity. */
    const runMatchesWindow = (
      requestedAnchor?: MatchesAnchorV1,
      window: {
        readonly before: number;
        readonly after: number;
        readonly contextTokens?: number;
      } = { before: 24, after: 24 },
      force = false,
    ) => {
      const { snapshot, series, scrub } = get();
      if (!snapshot) {
        matchesLane.supersede();
        set({ kwic: null, matchesReveal: null });
        return;
      }
      const tracks = effectiveTrackSpecs(series);
      if (tracks === null || tracks.wire.length === 0) {
        matchesLane.supersede();
        set({ kwic: null, matchesReveal: null });
        return;
      }
      const anchor = requestedAnchor ?? (scrub && snapshot.readyDocs.includes(scrub.doc)
        ? { kind: 'position' as const, doc: scrub.doc, token: scrub.token }
        : { kind: 'rank' as const, rank: 0 });
      const invalidAnchor = anchor.kind === 'rank'
        ? !Number.isSafeInteger(anchor.rank) || anchor.rank < 0
        : !snapshot.readyDocs.includes(anchor.doc)
          || !Number.isSafeInteger(anchor.token)
          || anchor.token < 0;
      const contextTokens = window.contextTokens ?? MATCHES_CONTEXT_TOKENS;
      if (
        invalidAnchor
        || !Number.isSafeInteger(window.before)
        || window.before < 0
        || !Number.isSafeInteger(window.after)
        || window.after < 0
        || window.before + 1 + window.after > KWIC_MAX_PAGE
        || !Number.isSafeInteger(contextTokens)
        || contextTokens < 0
        || contextTokens > MATCHES_CONTEXT_TOKENS_MAX
      ) return;
      const trackKey = JSON.stringify(tracks.identities);
      const held = get().kwic;
      if (
        !force
        && held?.snapshot === snapshot.snapshot
        && held.trackKey === trackKey
        && held.request !== null
        && sameAnchor(held.request.anchor, anchor)
        && held.request.before === window.before
        && held.request.after === window.after
        && held.request.contextTokens === contextTokens
        && (held.state.status === 'pending' || held.state.status === 'ready')
      ) return;

      if (
        !force
        && held?.snapshot === snapshot.snapshot
        && held.trackKey === trackKey
        && held.resident !== null
        && held.resident.contextTokens === contextTokens
        && (
          (held.resident.firstRank === 0 && held.resident.rows.length === held.resident.total)
          || (
            held.resident.before === window.before
            && held.resident.after === window.after
          )
        )
        && residentCoversAnchor(held.resident, anchor, snapshot.readyDocs)
      ) {
        // A reversal can return to resident evidence while an obsolete
        // outside-window request is pending. Retire it before restoring the
        // resident view, or its late result would pull the surface away again.
        matchesLane.supersede();
        set({
          kwic: {
            ...held,
            request: {
              anchor,
              before: window.before,
              after: window.after,
              contextTokens,
            },
            state: { status: 'ready' },
          },
        });
        return;
      }

      matchesLane.supersede();
      const issuedKey = snapKey(snapshot);
      const retainHeld = held?.snapshot === snapshot.snapshot && held.trackKey === trackKey;
      const retainedAxis = retainHeld ? held.axis : null;
      const retainedWindow = retainHeld ? held.resident : null;
      const request = {
        anchor,
        before: window.before,
        after: window.after,
        contextTokens,
      };
      const lease = matchesLane.ops.begin(
        () => snapKey(get().snapshot) === issuedKey,
        () => identitiesCurrent(tracks.identities),
      );
      set({
        kwic: {
          snapshot: snapshot.snapshot,
          trackKey,
          request,
          axis: retainedAxis,
          resident: retainedWindow,
          state: { status: 'pending' },
        },
      });
      issueOn(
        matchesLane,
        snapshot.snapshot,
        {
          op: 'matches-window',
          tracks: tracks.wire,
          request: {
            method: 'matches-window/1',
            anchor,
            before: window.before,
            after: window.after,
            contextTokens,
            includeAxis: retainedAxis === null,
          },
        },
        lease,
        (data) => {
          if (data.op !== 'matches-window') return;
          const live = get().kwic;
          const axis = data.window.axis
            ?? (live?.snapshot === snapshot.snapshot && live.trackKey === trackKey ? live.axis : null);
          const reveal = get().matchesReveal;
          let revealRank: number | null = null;
          let consumeReveal = false;
          if (
            reveal?.snapshot === snapshot.snapshot
            && reveal.trackKey === trackKey
          ) {
            consumeReveal = true;
            const index = data.window.rows.findIndex((row) =>
              row.seriesId === reveal.seriesId
              && (reveal.groupId === undefined || row.groupId === reveal.groupId)
              && row.doc === reveal.doc
              && row.pos === reveal.token
              && (reveal.members === undefined
                || (row.members.length === reveal.members.length
                  && row.members.every((member, memberIndex) => member === reveal.members?.[memberIndex]))));
            if (index >= 0) revealRank = data.window.firstRank + index;
          }
          set({
            kwic: {
              snapshot: snapshot.snapshot,
              trackKey,
              request,
              axis,
              resident: {
                total: data.window.total,
                trackCount: data.window.trackCount,
                anchorRank: data.window.anchorRank,
                firstRank: data.window.firstRank,
                before: window.before,
                after: window.after,
                contextTokens,
                preceding: data.window.preceding,
                rows: data.window.rows,
                revealRank,
              },
              state: { status: 'ready' },
            },
            ...(consumeReveal ? { matchesReveal: null } : {}),
          });
        },
        (message) => set((state) => ({
          kwic: {
            snapshot: snapshot.snapshot,
            trackKey,
            request,
            axis: state.kwic?.snapshot === snapshot.snapshot && state.kwic.trackKey === trackKey
              ? state.kwic.axis
              : retainedAxis,
            resident: state.kwic?.snapshot === snapshot.snapshot && state.kwic.trackKey === trackKey
              ? state.kwic.resident
              : retainedWindow,
            state: { status: 'error', message },
          },
        })),
      );
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
     * projection, and the dependent normalizations (matches membership per
     * surviving group, newly active groups
     * enabled; solo only on an active group). ONE authority so every action
     * leaves the same invariants (ruling invariant 7). Reissue policy is the
     * CALLER's: rename/reorder are presentation-only.
     */
    /** The EFFECTIVE query intent: for each projected series in order, its
     *  UUID, matching identity, and matches membership. Reissue decisions
     *  compare THIS — a mutation that leaves it unchanged (muting a solo'd-out
     *  group, editing an unprojected one, appending while soloed) must not
     *  cancel or recompute live results (ruling invariant 2, review-C). */
    const effectiveIntentKey = (
      nb: QueryNotebookV1,
      series: readonly SeriesIntent[],
    ): string =>
      JSON.stringify(series.map((s) => {
        const g = nb.groups.find((x) => x.id === s.id);
        return [s.id, g ? groupIdentity(g) : null];
      }));

    const adoptNotebook = (
      next: {
        notebook?: QueryNotebookV1;
        activeGroupIds?: ReadonlySet<string>;
        soloGroupId?: string | null;
      },
      opts: { reissue: boolean },
    ): void => {
      const prev = get();
      const prevIntent = effectiveIntentKey(prev.notebook, prev.series);
      let notebook = next.notebook ?? prev.notebook;
      const known = new Set(notebook.groups.map((g) => g.id));
      const active = new Set([...(next.activeGroupIds ?? prev.activeGroupIds)].filter((id) => known.has(id)));
      notebook = resolveActiveStyleCollisions(notebook, active, prev.activeGroupIds);
      let solo = next.soloGroupId === undefined ? prev.soloGroupId : next.soloGroupId;
      if (solo !== null && !active.has(solo)) solo = null;
      const styles = new Map(notebook.groups.map((group) => [group.id, group.style]));
      const series = projectSeries(notebook, active, solo, styles);
      set({
        notebook,
        activeGroupIds: active,
        soloGroupId: solo,
        styles,
        series,
        notebookError: null,
      });
      if (opts.reissue && effectiveIntentKey(notebook, series) !== prevIntent) {
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
      appNotice: null,
      workspacePersistence: { phase: 'idle' },
      interaction: NO_INTERACTION,
      interactionError: null,
      place: bootRoute.place ?? 'inputs',
      routeStatus: bootRoute.place === null ? 'pending' : 'resolved',
      layers: initialLayers,
      setPlace(place) {
        if (
          !PLACES.includes(place)
          || (place === get().place && get().routeStatus === 'resolved')
        ) return;
        const next: Layer = {
          kind: 'place',
          id: newLayerId(),
          target: Object.freeze({ place }),
          returnFocusTo: `place-${get().place}-heading`,
        };
        const layers = pushLayerStack(get().layers, next);
        rememberLayer(next, layers);
        writeNavigation('push', place, layers, { resolveRoute: true });
      },
      replacePlace(place) {
        if (
          !PLACES.includes(place)
          || (place === get().place && get().routeStatus === 'resolved')
        ) return;
        const next: Layer = {
          kind: 'place',
          id: newLayerId(),
          target: Object.freeze({ place }),
          returnFocusTo: `place-${get().place}-heading`,
        };
        const layers = replaceTopLayer(get().layers, next);
        rememberLayer(next, layers);
        writeNavigation('replace', place, layers, { resolveRoute: true });
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
      trends: new Map(),
      kwic: null,
      matchesReveal: null,
      matchesView: {
        columns: opts?.matchesColumns ?? MATCHES_COLUMN_DEFAULTS,
      },
      dispersion: null,
      company: null,
      destinations: null,
      destinationFocus: null,
      linkedSelection: null,
      selectedTrends: new Map(),
      selectedDispersion: null,
      inventory: null,
      corpusInventory: null,
      corpusTokenCounts: new Map(),
      frequencyView: {
        schema: 'texttrends/frequency-view/2',
        minCount: 1,
        minDocFreq: 1,
        classes: ['lexical'],
        stoplistTopN: 0,
        sort: { by: 'count', dir: -1 },
        page: { offset: 0, limit: 100 },
      },
      frequency: null,
      keynessView: DEFAULT_KEYNESS_VIEW,
      keynessA: null,
      keynessB: null,
      keynessInventoryA: null,
      keynessInventoryB: null,
      trendViewPreference: DEFAULT_TREND_VIEW,
      trendView: DEFAULT_TREND_VIEW,
      trendBins: DEFAULT_TREND_BINS,
      trendMeasure: DEFAULT_TREND_MEASURE,
      trendSettingsNotice: null,
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

      mergeStarterTerms(input) {
        const state = get();
        let groups = [...state.notebook.groups];
        const active = new Set(state.activeGroupIds);
        let added = 0;
        let activated = 0;
        let skipped = 0;
        // Deliberately parse one label at a time: unlike authored quick-add,
        // demo suggestions are best-effort under capacity and one invalid or
        // duplicate suggestion must not refuse its valid siblings atomically.
        for (const raw of input.split(',')) {
          const label = raw.trim();
          if (label === '') continue;
          if (groups.length >= NOTEBOOK_LIMITS_V1.maxGroups) {
            skipped += 1;
            continue;
          }
          const parsed = parseQuickAdd(label, newId, 1, groups);
          if (parsed.error !== null || parsed.groups.length === 0) {
            skipped += 1;
            continue;
          }
          const [group] = parsed.groups;
          groups.push(group!);
          added += 1;
          if (active.size < MAX_SERIES) {
            active.add(group!.id);
            activated += 1;
          }
        }
        if (added > 0) {
          adoptNotebook(
            { notebook: { schema: 'texttrends/query-notebook/3', groups }, activeGroupIds: active },
            { reissue: true },
          );
        }
        return { added, activated, skipped };
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
            && stylesVisuallyCollide(candidate.style, group.style));
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
            && stylesVisuallyCollide(group.style, edited.style));
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
        set({ removedGroups: state.removedGroups.slice(0, -1) });
        adoptNotebook({
          notebook: { ...state.notebook, groups },
          activeGroupIds: active,
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

      requestMatchesWindow(anchor, window) {
        runMatchesWindow(anchor, window);
      },

      setMatchesColumnWidth(column, width) {
        if (!(column in MATCHES_COLUMN_DEFAULTS) || !Number.isFinite(width)) return;
        const view = get().matchesView;
        const next = clampMatchesColumnWidth(column, width);
        if (view.columns[column] === next) return;
        set({
          matchesView: {
            columns: { ...view.columns, [column]: next },
          },
        });
      },

      setMatchesContextWeights(left, right) {
        if (![left, right].every(Number.isFinite)) return;
        const nextLeft = clampMatchesColumnWidth('left', left);
        const nextRight = clampMatchesColumnWidth('right', right);
        const view = get().matchesView;
        if (view.columns.left === nextLeft && view.columns.right === nextRight) return;
        set({
          matchesView: {
            columns: { ...view.columns, left: nextLeft, right: nextRight },
          },
        });
      },

      resetMatchesColumn(column) {
        if (!(column in MATCHES_COLUMN_DEFAULTS)) return;
        const view = get().matchesView;
        const next = MATCHES_COLUMN_DEFAULTS[column];
        if (view.columns[column] === next) return;
        set({
          matchesView: {
            columns: { ...view.columns, [column]: next },
          },
        });
      },

      resetMatchesColumns() {
        const columns = get().matchesView.columns;
        if ((Object.keys(MATCHES_COLUMN_DEFAULTS) as MatchesColumn[]).every(
          (column) => columns[column] === MATCHES_COLUMN_DEFAULTS[column],
        )) return;
        set({ matchesView: { columns: MATCHES_COLUMN_DEFAULTS } });
      },

      setTrendView(view) {
        const textCount = get().projectSession?.project.data.order.length ?? 0;
        set({
          trendViewPreference: view,
          trendView: textCount > 1 ? view : 'series',
        }); // presentation-only: no query is reissued
      },

      applyTrendSettings(input) {
        const state = get();
        let admitted;
        try {
          admitted = parseWorkspaceTrendView({
            mode: state.trendView,
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

      setScrub(target) {
        if (get().interaction.kind === 'rsvp') return;
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
        if (changed) {
          occurrenceLane.supersede();
          set({ scrub: target, occurrenceNavigation: null, matchesReveal: null });
        }
        scheduleFooterPassage(target);
      },

      clearScrub() {
        if (get().interaction.kind === 'rsvp') return;
        occurrenceLane.supersede();
        set({ scrub: null, occurrenceNavigation: null, matchesReveal: null });
        resetFooterPassage();
        runMatchesWindow({ kind: 'rank', rank: 0 });
      },

      enterFind() {
        const current = get().interaction;
        if (current.kind === 'rsvp') return;
        set({
          interaction: current.kind === 'find'
            ? current
            : { kind: 'find', find: null },
          interactionError: null,
        });
        if (current.kind !== 'find') {
          get().runReader();
          resetFooterPassage();
          if (get().scrub) get().runFooterPassage();
          runMatchesWindow();
        }
      },

      submitFind(raw) {
        // Defensive only: active RSVP owns focus/shortcuts, so no authoring
        // surface treats this refusal as a validation error.
        if (get().interaction.kind === 'rsvp') return false;
        const compiled = compileFindQuery(raw, newId);
        if (!compiled.ok) {
          set({ interactionError: compiled.message });
          return false;
        }
        findLane.supersede();
        findTrendLane.supersede();
        findDispersionLane.supersede();
        const snapshot = get().snapshot;
        if (snapshot === null) {
          set({
            interaction: { kind: 'find', find: null },
            interactionError: 'Add an input before finding in the corpus.',
          });
          return false;
        }
        set({
          interaction: {
            kind: 'find',
            find: {
              snapshot: snapshot.snapshot,
              query: compiled.query,
              anchor: null,
              state: { status: 'idle' },
              trend: { status: 'pending' },
              dispersion: { status: 'pending' },
            },
          },
          interactionError: null,
        });
        runFindAnalysis();
        get().runReader();
        resetFooterPassage();
        if (get().scrub) get().runFooterPassage();
        runMatchesWindow();
        get().stepFind(1);
        return true;
      },

      stepFind(direction) {
        const initial = get();
        const snapshot = initial.snapshot;
        const find = initial.interaction.kind === 'find'
          ? initial.interaction.find
          : null;
        if (
          snapshot === null
          || find === null
          || find.snapshot !== snapshot.snapshot
          || (direction !== 1 && direction !== -1)
        ) return;
        if (find.state.status === 'pending' && find.state.direction === direction) return;

        findLane.supersede();
        const currentReader = initial.readerPlace;
        const readyReader = currentReader
          && initial.readerPage
          && sameReaderPlace(initial.readerPage.place, currentReader)
          && initial.readerPage.state.status === 'ready'
          ? initial.readerPage.state.page
          : null;
        const candidateVisible = initial.readerVisibleRange;
        const visibleReader = readyReader
          && candidateVisible !== null
          && candidateVisible.snapshot === initial.readerPage?.snapshot
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
        let anchor = readerAnchor ?? initial.scrub;
        const syntheticAnchor = anchor === null;
        if (anchor === null) {
          const candidates = direction === 1
            ? [...snapshot.readyDocs].reverse()
            : snapshot.readyDocs;
          const doc = candidates.find((candidate) =>
            (initial.corpusTokenCounts.get(candidate) ?? 0) > 0);
          const tokenCount = doc ? initial.corpusTokenCounts.get(doc) ?? 0 : 0;
          anchor = doc
            ? { doc, token: direction === 1 ? tokenCount - 1 : 0 }
            : null;
        }
        if (anchor === null || !snapshot.readyDocs.includes(anchor.doc)) {
          set({
            interaction: {
              kind: 'find',
              find: {
                ...find,
                anchor: null,
                state: { status: 'error', message: 'source positions are still loading' },
              },
            },
          });
          return;
        }

        const issuedKey = snapKey(snapshot);
        const issuedIdentity = find.query.identity;
        const issuedSeriesId = find.query.seriesId;
        const issuedGroupId = find.query.group.id;
        const issuedAnchor = anchor;
        const lease = findLane.ops.begin(
          () => snapKey(get().snapshot) === issuedKey,
          () => {
            const live = get().interaction;
            return live.kind === 'find'
              && live.find?.query.identity === issuedIdentity;
          },
        );
        set({
          interaction: {
            kind: 'find',
            find: {
              ...find,
              anchor: issuedAnchor,
              state: { status: 'pending', direction },
            },
          },
          interactionError: null,
        });
        const writeFindState = (state: FindSeekState) => {
          const live = get().interaction;
          if (live.kind !== 'find' || live.find?.query.identity !== issuedIdentity) return;
          set({
            interaction: {
              kind: 'find',
              find: { ...live.find, anchor: issuedAnchor, state },
            },
          });
        };
        issueOn(
          findLane,
          snapshot.snapshot,
          {
            op: 'occurrence-step',
            tracks: [{ seriesId: issuedSeriesId, group: find.query.group }],
            request: {
              method: 'occurrence-step/1',
              doc: issuedAnchor.doc,
              token: issuedAnchor.token,
              direction,
            },
          },
          lease,
          (data) => {
            if (
              data.op !== 'occurrence-step'
              || data.step.method !== 'occurrence-step/1'
            ) {
              writeFindState({ status: 'error', message: 'worker returned the wrong operation' });
              return;
            }
            if (data.seriesId !== issuedSeriesId || data.groupId !== issuedGroupId) {
              writeFindState({ status: 'error', message: 'worker returned the wrong find query' });
              return;
            }
            const hit = data.step.hit;
            if (data.step.atEdge !== (hit === null)) {
              writeFindState({ status: 'error', message: 'worker returned an invalid find step' });
              return;
            }
            if (hit === null) {
              writeFindState({ status: 'edge' });
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
                || member >= find.query.group.members.length)
            ) {
              writeFindState({ status: 'error', message: 'worker returned an invalid find match' });
              return;
            }

            get().setScrub({ doc: hit.doc, token: hit.token });
            get().requestMatchesWindow({ kind: 'position', doc: hit.doc, token: hit.token });
            const liveReader = get().readerPlace;
            if (liveReader?.snapshot === snapshot.snapshot) {
              const readerLayer = get().layers.findLast((layer) => layer.kind === 'reader');
              get().openReader({
                snapshot: snapshot.snapshot,
                doc: hit.doc,
                token: hit.token,
                from: 'occurrence',
              }, readerLayer?.returnFocusTo);
            }
            writeFindState({
              status: 'ready',
              direction,
              hit,
              wrapped: syntheticAnchor
                ? false
                : findWrapped(issuedAnchor, hit, direction, snapshot.readyDocs),
            });
          },
          (message) => writeFindState({ status: 'error', message }),
          findErrorMessage,
        );
      },

      exitInteraction() {
        if (get().interaction.kind === 'rsvp') return;
        findLane.supersede();
        findTrendLane.supersede();
        findDispersionLane.supersede();
        set({ interaction: NO_INTERACTION, interactionError: null });
        get().runReader();
        resetFooterPassage();
        if (get().scrub) get().runFooterPassage();
        runMatchesWindow();
      },

      clearInteractionError() {
        set({ interactionError: null });
      },

      enterRsvp(playing) {
        const state = get();
        if (state.interaction.kind === 'rsvp') return;
        const place = state.readerPlace;
        const pageState = state.readerPage;
        const source = pageState
          && place
          && sameReaderPlace(pageState.place, place)
          && pageState.state.status === 'ready'
          ? pageState.state.page
          : null;
        if (
          source === null
          || place === null
          || pageState === null
          || pageState.snapshot !== state.snapshot?.snapshot
          || place.snapshot !== state.snapshot?.snapshot
          || source.doc !== place.doc
          || source.tokens.start >= source.tokens.end
        ) return;
        const visible = state.readerVisibleRange;
        const published = visible !== null
          && visible.snapshot === pageState.snapshot
          && visible.doc === source.doc
          && visible.tokens.start >= source.tokens.start
          && visible.tokens.start < source.tokens.end
          ? visible.tokens.start
          : null;
        const startToken = source.anchor?.token ?? published;
        if (
          startToken === null
          || startToken < source.tokens.start
          || startToken >= source.tokens.end
        ) return;

        occurrenceLane.supersede();
        let suspended: PrimaryInteraction = state.interaction;
        if (suspended.kind === 'find' && suspended.find?.state.status === 'pending') {
          findLane.supersede();
          suspended = {
            kind: 'find',
            find: { ...suspended.find, state: { status: 'idle' } },
          };
        }
        set({
          interaction: {
            kind: 'rsvp',
            rsvp: {
              snapshot: pageState.snapshot,
              doc: source.doc,
              docTokenCount: source.docTokenCount,
              startToken,
              ...lastRsvpPacing,
              playing,
            },
            suspended,
          },
          scrub: { doc: source.doc, token: startToken },
          occurrenceNavigation: null,
          matchesReveal: null,
          interactionError: null,
        });
      },

      setRsvpPlaying(playing) {
        set((state) => state.interaction.kind !== 'rsvp'
          || state.interaction.rsvp.playing === playing
          ? state
          : {
              interaction: {
                ...state.interaction,
                rsvp: { ...state.interaction.rsvp, playing },
              },
            });
      },

      setRsvpPacing(patch) {
        if (get().interaction.kind !== 'rsvp') return;
        const bounded = clampRsvpPacing({ ...lastRsvpPacing, ...patch });
        lastRsvpPacing = bounded;
        set((state) => state.interaction.kind !== 'rsvp'
          ? state
          : {
              interaction: {
                ...state.interaction,
                rsvp: { ...state.interaction.rsvp, ...bounded },
              },
            });
      },

      publishRsvpPosition(token) {
        const state = get();
        const mode = state.interaction.kind === 'rsvp'
          ? state.interaction.rsvp
          : null;
        if (
          mode === null
          || mode.snapshot !== state.snapshot?.snapshot
          || !Number.isSafeInteger(token)
          || token < 0
          || token >= mode.docTokenCount
        ) return;
        const changed = state.scrub?.doc !== mode.doc || state.scrub.token !== token;
        if (!changed && state.occurrenceNavigation === null && state.matchesReveal === null) return;
        if (changed) occurrenceLane.supersede();
        set({
          ...(changed ? { scrub: { doc: mode.doc, token } } : {}),
          occurrenceNavigation: null,
          matchesReveal: null,
        });
      },

      rsvpSeek(token) {
        const state = get();
        const mode = state.interaction.kind === 'rsvp'
          ? state.interaction.rsvp
          : null;
        if (
          mode === null
          || mode.snapshot !== state.snapshot?.snapshot
          || !Number.isSafeInteger(token)
          || token < 0
          || token >= mode.docTokenCount
        ) return;
        replaceReaderTarget({ doc: mode.doc, cursor: { kind: 'from', token } });
      },

      exitRsvp(token) {
        const state = get();
        if (
          state.interaction.kind !== 'rsvp'
          || state.interaction.rsvp.snapshot !== state.snapshot?.snapshot
          || !Number.isSafeInteger(token)
          || token < 0
          || token >= state.interaction.rsvp.docTokenCount
        ) return;
        const { doc } = state.interaction.rsvp;
        const suspended = state.interaction.suspended;
        occurrenceLane.supersede();
        set({
          interaction: suspended,
          scrub: { doc, token },
          occurrenceNavigation: null,
          matchesReveal: null,
          interactionError: null,
        });
        replaceReaderTarget({ doc, cursor: { kind: 'from', token } });
      },

      stepOccurrence(direction) {
        if (get().interaction.kind === 'rsvp') return;
        if (get().interaction.kind === 'find') {
          get().stepFind(direction);
          return;
        }
        occurrenceLane.supersede();
        const state = get();
        const snapshot = state.snapshot;
        const tracks = state.series.flatMap((series) => {
          const group = specFor(series.id);
          return group === null ? [] : [{ seriesId: series.id, group }];
        });
        if (!snapshot || tracks.length === 0 || (direction !== 1 && direction !== -1)) {
          set({ occurrenceNavigation: null });
          return;
        }
        const navigationSeriesId = tracks[0]!.seriesId;
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
            ? [...snapshot.readyDocs].reverse()
            : snapshot.readyDocs;
          const doc = candidates.find((candidate) =>
            (state.corpusTokenCounts.get(candidate) ?? 0) > 0);
          const tokenCount = doc ? state.corpusTokenCounts.get(doc) ?? 0 : 0;
          anchor = doc
            ? { doc, token: direction === 1 ? tokenCount - 1 : 0 }
            : null;
        }
        if (anchor === null || !snapshot.readyDocs.includes(anchor.doc)) {
          set({
            occurrenceNavigation: {
              snapshot: snapshot.snapshot,
              seriesId: navigationSeriesId,
              direction,
              state: { status: 'error', message: 'source positions are still loading' },
            },
          });
          return;
        }
        const issuedKey = snapKey(snapshot);
        const issuedIdentities = tracks.map((track) => ({
          seriesId: track.seriesId,
          identity: termGroupIdentity(track.group),
        }));
        const issuedReader = currentReader;
        const readerLayer = issuedReader
          ? state.layers.findLast((layer) => layer.kind === 'reader')
          : undefined;
        const returnFocusTo = readerLayer?.returnFocusTo;
        const lease = occurrenceLane.ops.begin(
          () => snapKey(get().snapshot) === issuedKey,
          () => issuedIdentities.every((entry) =>
            identityOf(entry.seriesId) === entry.identity),
          () => sameReaderPlace(get().readerPlace, issuedReader),
        );
        set({
          occurrenceNavigation: {
            snapshot: snapshot.snapshot,
            seriesId: navigationSeriesId,
            direction,
            state: { status: 'pending' },
          },
        });
        issueOn(
          occurrenceLane,
          snapshot.snapshot,
          {
            op: 'occurrence-step',
            tracks,
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
              || data.step.method !== 'occurrence-step/1'
            ) {
              set({
                occurrenceNavigation: {
                  snapshot: snapshot.snapshot,
                  seriesId: navigationSeriesId,
                  direction,
                  state: { status: 'error', message: 'worker returned the wrong operation' },
                },
              });
              return;
            }
            const chosen = tracks.find((track) =>
              track.seriesId === data.seriesId && track.group.id === data.groupId);
            if (!chosen) {
              set({
                occurrenceNavigation: {
                  snapshot: snapshot.snapshot,
                  seriesId: navigationSeriesId,
                  direction,
                  state: { status: 'error', message: 'worker returned an inactive term' },
                },
              });
              return;
            }
            const hit = data.step.hit;
            if (data.step.atEdge !== (hit === null)) {
              set({
                occurrenceNavigation: {
                  snapshot: snapshot.snapshot,
                  seriesId: chosen.seriesId,
                  direction,
                  state: { status: 'error', message: 'worker returned an invalid reference step' },
                },
              });
              return;
            }
            if (hit === null) {
              set({
                occurrenceNavigation: {
                  snapshot: snapshot.snapshot,
                  seriesId: chosen.seriesId,
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
                || member >= chosen.group.members.length)
            ) {
              set({
                occurrenceNavigation: {
                  snapshot: snapshot.snapshot,
                  seriesId: chosen.seriesId,
                  direction,
                  state: { status: 'error', message: 'worker returned an invalid reference' },
                },
              });
              return;
            }
            get().setScrub({ doc: hit.doc, token: hit.token });
            // Occurrence stepping deliberately collapses a same-start cluster
            // into one stop; its members are cluster-level provenance, so the
            // Matches applies the documented first-row rule.
            get().centerKwicAt(chosen.seriesId, hit.doc, hit.token, {
              kind: 'occurrence',
              groupId: chosen.group.id,
            });
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
                seriesId: chosen.seriesId,
                direction,
                state: { status: 'ready', hit },
              },
            });
          },
          (message) => set({
            occurrenceNavigation: {
              snapshot: snapshot.snapshot,
              seriesId: navigationSeriesId,
              direction,
              state: { status: 'error', message },
            },
          }),
        );
      },

      openReader(intent, returnFocusTo = `place-${get().place}-heading`) {
        if (get().interaction.kind === 'rsvp') return;
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
        if (state.interaction.kind === 'rsvp') return;
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
        const selectionToken = place.cursor.kind === 'around'
          && place.cursor.token >= range.tokens.start
          && place.cursor.token < range.tokens.end
          ? place.cursor.token
          : range.tokens.start;
        const selectionChanged = state.scrub?.doc !== source.doc
          || state.scrub.token !== selectionToken;
        if (selectionChanged) occurrenceLane.supersede();
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
          ...(selectionChanged
            ? {
                scrub: { doc: source.doc, token: selectionToken },
                occurrenceNavigation: null,
                matchesReveal: null,
              }
            : {}),
        });
      },

      refitReaderAt(token) {
        const state = get();
        if (state.interaction.kind === 'rsvp') return;
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
        if (get().interaction.kind === 'rsvp') return;
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
        const tracks = effectiveTrackSpecs(series);
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
        set({ occurrenceNavigation: null, matchesReveal: null });
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
          companyLane.supersede();
          destinationsLane.supersede();
          set({
            trends: new Map(),
            scrub: null,
            footerPassage: null,
            dispersion: null,
            company: null,
            destinations: null,
            destinationFocus: null,
            selectedTrends: new Map(),
            selectedDispersion: null,
            matchesReveal: null,
          });
          runMatchesWindow();
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

        // Overview messages are posted only after the complete primary trend
        // burst and barcode request. Separate lanes keep their failures and
        // pair-focus refreshes independent from those primary surfaces.
        runOverview();

        // The selected overlays follow the same burst (a snapshot change or
        // comparison change either revalidates or clears them).
        runSelected();
        runMatchesWindow();
      },

      runInventory() {
        inventoryLane.supersede();
        const { snapshot, linkedSelection, corpusInventory } = get();
        if (!snapshot) {
          corpusInventoryLane.supersede();
          set({ inventory: null, corpusInventory: null });
          return;
        }
        const issuedKey = snapKey(snapshot);
        const issuedSelection = linkedSelection;

        // Full-corpus inventory is a separate resident lane. Clearing a range
        // can reveal the authenticated baseline immediately, and creating a
        // range never cancels a baseline that is still landing.
        if (issuedSelection === null) {
          if (
            corpusInventory?.snapshot === snapshot.snapshot
            && corpusInventory.state.status !== 'error'
          ) {
            set({ inventory: corpusInventory });
            return;
          }
          corpusInventoryLane.supersede();
          const pending: InventoryState = {
            snapshot: snapshot.snapshot,
            selection: null,
            state: { status: 'pending' },
          };
          const lease = corpusInventoryLane.ops.begin(
            () => snapKey(get().snapshot) === issuedKey,
          );
          set({ inventory: pending, corpusInventory: pending });
          issueOn(
            corpusInventoryLane,
            snapshot.snapshot,
            {
              op: 'inventory',
              selection: { docs: [...snapshot.readyDocs] },
              request: {
                method: 'inventory/1',
                rhythmBinsPerDoc: 0,
                mattrWindow: INVENTORY_MATTR_WINDOW,
              },
            },
            lease,
            (data) => {
              if (data.op !== 'inventory') return;
              const ready: InventoryState = {
                snapshot: snapshot.snapshot,
                selection: null,
                state: { status: 'ready', result: data.inventory },
              };
              set((state) => {
                const corpusTokenCounts = new Map(state.corpusTokenCounts);
                for (const row of data.inventory.documents) {
                  if (Number.isSafeInteger(row.fullTokens) && row.fullTokens >= 0) {
                    corpusTokenCounts.set(row.doc, row.fullTokens);
                  }
                }
                return {
                  corpusInventory: ready,
                  inventory: state.linkedSelection === null ? ready : state.inventory,
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
            (message) => {
              const error: InventoryState = {
                snapshot: snapshot.snapshot,
                selection: null,
                state: { status: 'error', message },
              };
              set((state) => ({
                corpusInventory: error,
                inventory: state.linkedSelection === null ? error : state.inventory,
              }));
            },
          );
          return;
        }

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
              rhythmBinsPerDoc: 0,
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

      runFrequency(retainResident = false) {
        frequencyLane.supersede();
        const {
          snapshot,
          linkedSelection,
          frequencyView,
          frequency: currentFrequency,
        } = get();
        if (!snapshot) {
          set({ frequency: null });
          return;
        }
        const issuedKey = snapKey(snapshot);
        const issuedSelection = linkedSelection;
        const issuedView = frequencyView;
        const resident = retainResident
          && currentFrequency?.snapshot === snapshot.snapshot
          && currentFrequency.selection === issuedSelection
          ? currentFrequency.resident
            ?? (currentFrequency.state.status === 'ready'
              ? currentFrequency.state.result
              : null)
          : null;
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
            resident,
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
              method: 'freq-list/2',
              filter: {
                minCount: issuedView.minCount,
                minDocFreq: issuedView.minDocFreq,
                classes: issuedView.classes,
                ...(issuedView.stoplistTopN === 0 ? {} : {
                  stoplist: {
                    id: STOPLIST_EN_ID,
                    version: STOPLIST_EN_VERSION,
                    topN: issuedView.stoplistTopN,
                  },
                }),
                ...(issuedView.filter === undefined
                  ? {}
                  : { text: issuedView.filter }),
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
                resident: data.frequency,
                state: { status: 'ready', result: data.frequency },
              },
            });
          },
          (message) => set({
            frequency: {
              snapshot: snapshot.snapshot,
              selection: issuedSelection,
              view: issuedView,
              resident: null,
              state: { status: 'error', message },
            },
          }),
        );
      },

      loadMoreFrequency() {
        const { snapshot, linkedSelection, frequencyView, frequency } = get();
        const resident = frequency?.resident
          ?? (frequency?.state.status === 'ready' ? frequency.state.result : null);
        if (
          !snapshot
          || resident === null
          || frequency?.state.status !== 'ready'
          || resident.rows.length >= resident.total
        ) {
          return;
        }
        const issuedKey = snapKey(snapshot);
        const issuedSelection = linkedSelection;
        const issuedView = frequencyView;
        const offset = issuedView.page.offset + resident.rows.length;
        const limit = Math.min(
          issuedView.page.limit,
          resident.total - resident.rows.length,
        );
        if (!Number.isSafeInteger(offset + limit) || limit < 1) return;

        frequencyLane.supersede();
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
            resident,
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
              method: 'freq-list/2',
              filter: {
                minCount: issuedView.minCount,
                minDocFreq: issuedView.minDocFreq,
                classes: issuedView.classes,
                ...(issuedView.stoplistTopN === 0 ? {} : {
                  stoplist: {
                    id: STOPLIST_EN_ID,
                    version: STOPLIST_EN_VERSION,
                    topN: issuedView.stoplistTopN,
                  },
                }),
                ...(issuedView.filter === undefined
                  ? {}
                  : { text: issuedView.filter }),
              },
              sort: issuedView.sort,
              page: { offset, limit },
              dispersion: true,
            },
          },
          lease,
          (data) => {
            if (data.op !== 'freq-list') return;
            const next = data.frequency;
            if (
              next.total !== resident.total
              || next.totalTokens !== resident.totalTokens
              || next.parts !== resident.parts
              || next.selection !== resident.selection
              || (next.rows.length === 0 && resident.rows.length < resident.total)
            ) {
              set({
                frequency: {
                  snapshot: snapshot.snapshot,
                  selection: issuedSelection,
                  view: issuedView,
                  resident,
                  state: {
                    status: 'error',
                    message: 'Vocabulary changed while more rows were loading. Refresh the view to continue.',
                  },
                },
              });
              return;
            }
            const result: FrequencyListResultV1 = {
              ...next,
              rows: [...resident.rows, ...next.rows],
            };
            set({
              frequency: {
                snapshot: snapshot.snapshot,
                selection: issuedSelection,
                view: issuedView,
                resident: result,
                state: { status: 'ready', result },
              },
            });
          },
          (message) => set({
            frequency: {
              snapshot: snapshot.snapshot,
              selection: issuedSelection,
              view: issuedView,
              resident,
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

      loadMoreKeyness(side) {
        if (side !== 'a' && side !== 'b') return;
        const lane = side === 'a' ? keynessALane : keynessBLane;
        const state = get();
        const { snapshot, keynessView } = state;
        const table = side === 'a' ? state.keynessA : state.keynessB;
        const resident = table?.resident
          ?? (table?.state.status === 'ready' ? table.state.result : null);
        const pair = snapshot
          ? keynessSelections(keynessView, snapshot.readyDocs)
          : null;
        if (
          !snapshot
          || !pair
          || resident === null
          || (
            table?.state.status !== 'ready'
            && table?.state.status !== 'error'
          )
          || resident.rows.length >= Math.min(
            resident.total,
            COMPARE_MAX_RESIDENT_ROWS,
          )
        ) return;
        const offset = resident.rows.length;
        const limit = Math.min(
          keynessView.pageLimit,
          resident.total - resident.rows.length,
          COMPARE_MAX_RESIDENT_ROWS - resident.rows.length,
        );
        if (
          limit < 1
          || !Number.isSafeInteger(offset + limit)
        ) return;
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
        lane.supersede();
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
          resident,
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
                ...(issuedView.stoplistTopN === 0 ? {} : {
                  stoplist: {
                    id: STOPLIST_EN_ID,
                    version: STOPLIST_EN_VERSION,
                    topN: issuedView.stoplistTopN,
                  },
                }),
              },
              sort,
              page: { offset, limit },
              side,
            },
          },
          lease,
          (data) => {
            if (data.op !== 'keyness') return;
            const next = data.keyness;
            if (
              next.method !== resident.method
              || next.effect !== resident.effect
              || next.total !== resident.total
              || next.totalsA.tokens !== resident.totalsA.tokens
              || next.totalsA.documents !== resident.totalsA.documents
              || next.totalsB.tokens !== resident.totalsB.tokens
              || next.totalsB.documents !== resident.totalsB.documents
              || next.rows.length !== limit
            ) {
              writeKeynessTable(side, {
                snapshot: snapshot.snapshot,
                side,
                view: issuedView,
                resident,
                state: {
                  status: 'error',
                  message: 'Comparison ranks changed while more rows were loading. Refresh the view to continue.',
                },
              });
              return;
            }
            const result: KeynessResultV1 = {
              ...next,
              rows: [...resident.rows, ...next.rows],
            };
            writeKeynessTable(side, {
              snapshot: snapshot.snapshot,
              side,
              view: issuedView,
              resident: result,
              state: { status: 'ready', result },
            });
          },
          (message) => writeKeynessTable(side, {
            snapshot: snapshot.snapshot,
            side,
            view: issuedView,
            resident,
            state: { status: 'error', message },
          }),
        );
      },

      setKeynessMode(mode) {
        pendingKeynessResetDoc = null;
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
          },
        });
        get().runKeyness();
      },

      setKeynessDocument(side, doc) {
        pendingKeynessResetDoc = null;
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
          },
        });
        get().runKeyness();
      },

      setKeynessSelection(side, doc) {
        pendingKeynessResetDoc = null;
        if (side !== 'a' && side !== 'b') return;
        const state = get();
        const ready = state.snapshot?.readyDocs ?? [];
        if (ready.length < 2 || (doc !== null && !ready.includes(doc))) return;
        const view = state.keynessView;
        const otherSide = side === 'a' ? 'b' : 'a';
        const currentDoc = side === 'a' ? view.documentA : view.documentB;
        const otherDoc = side === 'a' ? view.documentB : view.documentA;
        const thisIsRest = view.mode === 'document-rest' && view.restOn === side;
        const otherIsRest = view.mode === 'document-rest' && view.restOn === otherSide;
        let next: KeynessViewV1;

        if (doc === null) {
          if (thisIsRest) return;
          if (otherIsRest) {
            const focus = currentDoc && ready.includes(currentDoc)
              ? currentDoc
              : ready[0] ?? null;
            const filler = ready.find((candidate) => candidate !== focus) ?? null;
            next = {
              ...view,
              restOn: side,
              documentA: side === 'a' ? filler : focus,
              documentB: side === 'b' ? filler : focus,
            };
          } else {
            const focus = otherDoc && ready.includes(otherDoc)
              ? otherDoc
              : ready.find((candidate) => candidate !== currentDoc) ?? ready[0] ?? null;
            const filler = ready.find((candidate) => candidate !== focus) ?? null;
            next = {
              ...view,
              mode: 'document-rest',
              restOn: side,
              documentA: side === 'a' ? filler : focus,
              documentB: side === 'b' ? filler : focus,
            };
          }
        } else if (thisIsRest) {
          if (doc === otherDoc) return;
          next = {
            ...view,
            mode: 'documents',
            ...(side === 'a' ? { documentA: doc } : { documentB: doc }),
          };
        } else if (otherIsRest) {
          const filler = ready.find((candidate) => candidate !== doc) ?? null;
          if (doc === currentDoc && otherDoc === filler) return;
          next = {
            ...view,
            ...(side === 'a'
              ? { documentA: doc, documentB: filler }
              : { documentA: filler, documentB: doc }),
          };
        } else {
          if (doc === otherDoc || doc === currentDoc) return;
          next = {
            ...view,
            ...(side === 'a' ? { documentA: doc } : { documentB: doc }),
          };
        }

        set({ keynessView: next });
        get().runKeyness();
      },

      swapKeynessSides() {
        pendingKeynessResetDoc = null;
        const view = get().keynessView;
        const ready = get().snapshot?.readyDocs ?? [];
        let next: KeynessViewV1;
        if (view.mode === 'documents') {
          next = {
            ...view,
            documentA: view.documentB,
            documentB: view.documentA,
          };
        } else if (view.restOn === 'b') {
          const focus = view.documentA;
          next = {
            ...view,
            restOn: 'a',
            documentB: focus,
            documentA: ready.find((doc) => doc !== focus) ?? null,
          };
        } else {
          const focus = view.documentB;
          next = {
            ...view,
            restOn: 'b',
            documentA: focus,
            documentB: ready.find((doc) => doc !== focus) ?? null,
          };
        }
        set({ keynessView: next });
        get().runKeyness();
      },

      resetKeynessComparison(doc) {
        const state = get();
        const activeDocuments = [
          ...(state.projectSession?.project.data.order ?? []),
          ...(state.projectSession?.imports
            .filter((pendingImport) => pendingImport.status !== 'failed')
            .map((pendingImport) => pendingImport.doc) ?? []),
        ];
        if (!activeDocuments.includes(doc)) return;
        const ready = state.snapshot?.readyDocs ?? [];
        const focusReady = ready.includes(doc);
        pendingKeynessResetDoc = focusReady ? null : doc;
        set({
          keynessView: {
            ...state.keynessView,
            mode: DEFAULT_KEYNESS_VIEW.mode,
            documentA: focusReady ? doc : null,
            documentB: focusReady
              ? ready.find((candidate) => candidate !== doc) ?? null
              : null,
            restOn: DEFAULT_KEYNESS_VIEW.restOn,
          },
        });
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
          !Number.isSafeInteger(input.stoplistTopN) ||
          input.stoplistTopN < 0 ||
          input.stoplistTopN > STOPLIST_MAX_TOP_N ||
          !['logRatio', 'logRatioLow', 'g2', 'countA', 'countB']
            .includes(input.sortBy) ||
          (input.dirA !== 1 && input.dirA !== -1) ||
          (input.dirB !== 1 && input.dirB !== -1) ||
          typeof input.showConfidenceIntervals !== 'boolean'
        ) {
          return;
        }
        const view = get().keynessView;
        const sharedQueryChanged =
          view.minCountTotal !== input.minCountTotal ||
          view.minDocFreqTotal !== input.minDocFreqTotal ||
          view.classes.length !== input.classes.length ||
          view.classes.some((value, index) => value !== input.classes[index]) ||
          view.stoplistTopN !== input.stoplistTopN ||
          view.sort.by !== input.sortBy;
        const queryAChanged = sharedQueryChanged || view.sort.dirA !== input.dirA;
        const queryBChanged = sharedQueryChanged || view.sort.dirB !== input.dirB;
        if (
          !queryAChanged &&
          !queryBChanged &&
          view.showConfidenceIntervals === input.showConfidenceIntervals
        ) {
          return;
        }
        set({
          keynessView: {
            ...view,
            minCountTotal: input.minCountTotal,
            minDocFreqTotal: input.minDocFreqTotal,
            classes: [...input.classes],
            stoplistTopN: input.stoplistTopN,
            sort: {
              by: input.sortBy,
              dirA: input.dirA,
              dirB: input.dirB,
            },
            showConfidenceIntervals: input.showConfidenceIntervals,
          },
        });
        if (queryAChanged) runKeynessTable('a');
        if (queryBChanged) runKeynessTable('b');
      },

      setFrequencySort(by) {
        const current = get().frequencyView;
        const dir = current.sort.by === by
          ? (current.sort.dir === 1 ? -1 : 1)
          : (by === 'key' || by === 'class' ? 1 : -1);
        set({
          frequencyView: {
            ...current,
            sort: { by, dir },
            page: { ...current.page, offset: 0 },
          },
        });
        get().runFrequency();
      },

      setFrequencyFilter(filter) {
        const normalized = filter?.query.normalize('NFC') ?? '';
        if (normalized.length > FREQUENCY_FILTER_MAX_UNITS) return;
        if (filter?.mode === 'regex' && normalized !== '') {
          try {
            new RegExp(normalized, 'u');
          } catch {
            return;
          }
        }
        const current = get().frequencyView;
        const nextFilter = filter === null || normalized === ''
          ? undefined
          : { mode: filter.mode, query: normalized } as const;
        if (
          current.filter?.mode === nextFilter?.mode
          && current.filter?.query === nextFilter?.query
        ) return;
        const { filter: _oldFilter, ...withoutFilter } = current;
        set({
          frequencyView: nextFilter === undefined
            ? {
                ...withoutFilter,
                page: { ...current.page, offset: 0 },
              }
            : {
                ...current,
                filter: nextFilter,
                page: { ...current.page, offset: 0 },
              },
        });
        get().runFrequency(true);
      },

      setFrequencyStoplistTopN(topN) {
        if (
          !Number.isSafeInteger(topN)
          || topN < 0
          || topN > STOPLIST_MAX_TOP_N
        ) {
          return;
        }
        const current = get().frequencyView;
        if (current.stoplistTopN === topN) return;
        set({
          frequencyView: {
            ...current,
            stoplistTopN: topN,
            page: { ...current.page, offset: 0 },
          },
        });
        get().runFrequency(true);
      },

      setFrequencyPage(offset) {
        const current = get().frequencyView;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(offset + current.page.limit)
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
            get().setPlace('matches');
          } else if (added) {
            refuseNotebook('term added; deactivate another term before showing its matches');
          }
          return;
        }
        if (!state.activeGroupIds.has(group.id) && state.activeGroupIds.size >= MAX_SERIES) {
          refuseNotebook('deactivate a group before showing matches for this term');
          return;
        }
        const active = new Set(state.activeGroupIds);
        active.add(group.id);
        adoptNotebook({ activeGroupIds: active, soloGroupId: null }, { reissue: true });
        get().setPlace('matches');
      },

      setLinkedSelection(selection) {
        const { snapshot } = get();
        if (selection !== null
          && (!snapshot || !isValidSelection(selection, snapshot.snapshot, snapshot.readyDocs))) {
          return; // a stale gesture (superseded snapshot / departed doc) commits nothing
        }
        if (get().linkedSelection === selection) return;
        set({ linkedSelection: selection });
        if (selection === null) {
          // Exact ready residents survive a temporary range and are reused;
          // cancelled or failed matching intents are reissued here.
          runOverview();
        } else {
          // The selected-range organ replaces overview presentation. Stop
          // expensive work immediately but retain exact ready residents for
          // a possible deselection of the same semantic tracks/focus.
          companyLane.supersede();
          destinationsLane.supersede();
          set((state) => ({
            company: state.company?.state.status === 'ready' ? state.company : null,
            destinations: state.destinations?.state.status === 'ready'
              ? state.destinations
              : null,
          }));
        }
        // Detail consumers reissue; the resident BASELINE trends/dispersion
        // are untouched (clearing a brush must not recompute them).
        runSelected();
        get().runInventory();
        get().runFrequency();
      },

      setDestinationFocus(seriesIds) {
        const tracks = overviewTrackSpecs(get().series);
        if (tracks === null) return;
        const focus = normalizeDestinationFocus(seriesIds, tracks);
        if (focus === undefined || sameDestinationFocus(get().destinationFocus, focus)) return;
        destinationsLane.supersede();
        set({ destinationFocus: focus });
        runDestinationsOverview();
      },

      centerKwicAt(seriesId, doc, token, origin) {
        const state = get();
        if (!state.snapshot?.readyDocs.includes(doc)) return;
        // All navigation publishes the ONE shared cursor. Exact evidence also
        // carries a one-shot row disambiguator; density midpoints never do.
        get().setScrub({ doc, token });
        const live = get();
        const tracks = effectiveTrackSpecs(live.series);
        const trackKey = tracks === null ? '' : JSON.stringify(tracks.identities);
        set({
          matchesReveal: origin?.kind !== 'bucket'
            ? {
                snapshot: state.snapshot.snapshot,
                trackKey,
                seriesId,
                doc,
                token,
                ...(origin?.groupId === undefined ? {} : { groupId: origin.groupId }),
                ...(origin?.members === undefined ? {} : { members: [...origin.members] }),
              }
            : null,
        });
        runMatchesWindow({ kind: 'position', doc, token }, undefined, true);
      },

      // ── Session command wrappers ──────────────────────────────────────────
      importFiles(files) {
        let accepted = false;
        command((s) => {
          if (s.getState().project.kind === 'builtin') s.createLibraryCorpus(files);
          else s.appendFiles(files);
          accepted = true;
        });
        return accepted;
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
      clearActiveInputsAndTerms() {
        if (session === null) {
          set({ commandError: 'the project is still initializing' });
          return { texts: 0, terms: 0 };
        }
        const sessionState = session.getState();
        const documentIds = [...new Set([
          ...sessionState.project.data.order,
          ...sessionState.project.data.docs.map((doc) => doc.doc),
          ...sessionState.imports.map((item) => item.doc),
        ])];
        const termCount = get().notebook.groups.length;
        if (documentIds.length === 0 && termCount === 0) return { texts: 0, terms: 0 };
        if (documentIds.length > 0 && sessionState.project.kind !== 'library') {
          set({ commandError: 'clear inputs requires a library corpus (the built-in is read-only)' });
          return { texts: 0, terms: 0 };
        }

        // Run the only fallible half first. Once the session accepts the one
        // batch removal, its synchronous publication invalidates the old
        // snapshot and generation exactly once; notebook adoption then clears
        // every derived term invariant without creating per-term undo entries.
        if (documentIds.length > 0) {
          let accepted = false;
          command((s) => {
            s.removeDocuments(documentIds);
            accepted = true;
          });
          if (!accepted) return { texts: 0, terms: 0 };
        }
        if (termCount > 0) {
          adoptNotebook({
            notebook: { schema: 'texttrends/query-notebook/3', groups: [] },
            activeGroupIds: new Set(),
            soloGroupId: null,
          }, { reissue: true });
        }
        // When terms are part of the confirmed reset, their deletion undo
        // history is term state too and must not resurrect a cleared term.
        // A texts-only reset leaves an unrelated term undo available.
        set({ ...(termCount > 0 ? { removedGroups: [] } : {}), inputError: null });
        return { texts: documentIds.length, terms: termCount };
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
      clearAppNotice() {
        set({ appNotice: null });
      },
      retryWorkspaceSave() {
        workspacePausedKey = null;
        saveWorkspaceNow();
      },
      restoreWorkspace(workspace) {
        pendingKeynessResetDoc = null;
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
        const frequencyFilter = workspace.views.frequency.filter
          ?? (workspace.views.frequency.regex !== undefined
            ? { mode: 'regex' as const, query: workspace.views.frequency.regex }
            : workspace.views.frequency.prefixNfc === undefined
              ? undefined
              : {
                  mode: 'regex' as const,
                  query: regexForLegacyFrequencyPrefix(workspace.views.frequency.prefixNfc),
                });
        set({
          trendViewPreference: workspace.views.trend.mode,
          trendView: (state.projectSession?.project.data.order.length ?? 0) > 1
            || (workspace.corpus.kind === 'library' && workspace.corpus.order.length === 0)
            ? workspace.views.trend.mode
            : 'series',
          trendBins: restoredTrendBins,
          trendMeasure: workspace.views.trend.measure,
          trendSettingsNotice: fittedRestoredTrendBins === null
            ? `No trend bin mode can represent this corpus within the ${TREND_MAX_ROWS.toLocaleString()}-row result limit.`
            : restoredTrendBinsChanged
              ? trendGeometryNotice(workspace.views.trend.bins, restoredTrendBins)
              : null,
          frequencyView: {
            schema: 'texttrends/frequency-view/2',
            minCount: workspace.views.frequency.minCount,
            minDocFreq: workspace.views.frequency.minDocFreq,
            classes: workspace.views.frequency.classes,
            stoplistTopN: workspace.views.frequency.stoplistTopN,
            ...(frequencyFilter === undefined
              ? {}
              : { filter: frequencyFilter }),
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
            stoplistTopN: compare.stoplistTopN,
            sort: compare.sort,
            showConfidenceIntervals: compare.showConfidenceIntervals,
            pageLimit: compare.pageSize,
          },
          removedGroups: [],
        });
        adoptNotebook(
          {
            notebook: workspace.notebook,
            activeGroupIds: new Set(workspace.active),
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
    const routePlace = route.place ?? defaultPlaceFor(previous.projectSession?.project);
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
      place: routePlace,
      routeStatus: 'resolved',
      layers,
      interaction: state.interaction.kind === 'rsvp'
        && (
          readerPlace === null
          || readerPlace.snapshot !== state.interaction.rsvp.snapshot
          || readerPlace.doc !== state.interaction.rsvp.doc
        )
        ? state.interaction.suspended
        : state.interaction,
      notebookError: routePlace === state.place ? state.notebookError : null,
      readerPlace,
      readerPage: readerChanged ? null : state.readerPage,
      readerVisibleRange: readerChanged ? null : state.readerVisibleRange,
      readerNavigation: readerChanged ? null : state.readerNavigation,
    }));
    if (previous.readerPlace !== null && readerPlace === null && previous.scrub !== null) {
      store.getState().runFooterPassage();
    }
    const normalizedUrl = urlWithRoute(historyPort.url, { place: routePlace });
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
    const readyDocs = next.snapshot?.readyDocs ?? next.project.data.order;
    const currentKeynessView = store.getState().keynessView;
    const activeDocuments = new Set([
      ...next.project.data.order,
      ...next.imports
        .filter((pendingImport) => pendingImport.status !== 'failed')
        .map((pendingImport) => pendingImport.doc),
    ]);
    if (
      pendingKeynessResetDoc !== null
      && !activeDocuments.has(pendingKeynessResetDoc)
    ) {
      pendingKeynessResetDoc = null;
    }
    let keynessView: KeynessViewV1;
    if (pendingKeynessResetDoc !== null) {
      if (readyDocs.includes(pendingKeynessResetDoc)) {
        const focus = pendingKeynessResetDoc;
        pendingKeynessResetDoc = null;
        keynessView = {
          ...currentKeynessView,
          mode: DEFAULT_KEYNESS_VIEW.mode,
          documentA: focus,
          documentB: readyDocs.find((doc) => doc !== focus) ?? null,
          restOn: DEFAULT_KEYNESS_VIEW.restOn,
        };
      } else {
        keynessView = {
          ...currentKeynessView,
          mode: DEFAULT_KEYNESS_VIEW.mode,
          documentA: null,
          documentB: null,
          restOn: DEFAULT_KEYNESS_VIEW.restOn,
        };
      }
    } else {
      keynessView = reconcileKeynessView(currentKeynessView, readyDocs);
    }
    store.setState({
      bootstrap: { phase: 'attached' },
      projectSession: next,
      snapshot: next.snapshot,
      loadingPhase: describeAnalysis(next.analysis),
      loadError: next.analysis.phase === 'error' ? next.analysis.message : null,
      keynessView,
      corpusTokenCounts: prevKey !== nextKey
        ? new Map()
        : store.getState().corpusTokenCounts,
      corpusInventory: prevKey !== nextKey
        ? null
        : store.getState().corpusInventory,
      trendSettingsNotice: prevKey !== nextKey
        ? null
        : store.getState().trendSettingsNotice,
      removedGroups: store.getState().projectSession?.project.id !== next.project.id
        ? []
        : store.getState().removedGroups,
      trendView: next.project.data.order.length === 1
        && !next.imports.some((pendingImport) => pendingImport.status !== 'failed')
        ? 'series'
        : store.getState().trendViewPreference,
    });
    if (prevKey !== nextKey) {
      readerLane.supersede();
      occurrenceLane.supersede();
      findLane.supersede();
      findTrendLane.supersede();
      findDispersionLane.supersede();
      footerPassageLane.supersede();
      footerPassageActive = null;
      footerPassagePending = null;
      store.setState({ interaction: NO_INTERACTION, interactionError: null });
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
      if (store.getState().routeStatus === 'pending') {
        const place = defaultPlaceFor(next.getState().project);
        if (historyPort !== null) {
          historyPort.replace(
            historyStateFor(store.getState().layers),
            urlWithRoute(historyPort.url, { place }),
          );
        }
        store.setState({ place, routeStatus: 'resolved' });
      }
      if (workspaceStore !== null) {
        workspaceHydrated = true;
        workspaceLastKey = workspaceSemanticKey(store.getState());
        store.setState({ workspacePersistence: { phase: 'saved' } });
      }
    },
    failBootstrap(error: unknown) {
      if (disposed) return; // a torn-down runtime reports nothing
      const pending = store.getState().routeStatus === 'pending';
      if (pending && historyPort !== null) {
        historyPort.replace(
          historyStateFor(store.getState().layers),
          urlWithRoute(historyPort.url, { place: 'inputs' }),
        );
      }
      store.setState({
        bootstrap: { phase: 'error', message: msg(error) },
        ...(pending ? { place: 'inputs' as const, routeStatus: 'resolved' as const } : {}),
      });
    },
    reportNotice(message: string) {
      if (!disposed) store.setState({ appNotice: message });
    },
    reportWorkspaceFailure(error: unknown) {
      if (!disposed) {
        store.setState({
          workspacePersistence: {
            phase: 'error',
            message: `Workspace could not be saved: ${msg(error)}`,
          },
        });
      }
    },
    dispose() {
      disposed = true;
      // Close the ownership scope FIRST: every outstanding lease goes dead, so
      // a late settlement (even one whose cancel is never acknowledged) can no
      // longer write to the store. Then best-effort transport cleanup cancels
      // every in-flight query.
      scope.close();
      trendLane.supersede();
      matchesLane.supersede();
      dispersionLane.supersede();
      companyLane.supersede();
      destinationsLane.supersede();
      selectedTrendLane.supersede();
      selectedDispersionLane.supersede();
      inventoryLane.supersede();
      corpusInventoryLane.supersede();
      frequencyLane.supersede();
      keynessALane.supersede();
      keynessBLane.supersede();
      keynessInventoryALane.supersede();
      keynessInventoryBLane.supersede();
      readerLane.supersede();
      occurrenceLane.supersede();
      findLane.supersede();
      findTrendLane.supersede();
      findDispersionLane.supersede();
      footerPassageLane.supersede();
      footerPassageActive = null;
      footerPassagePending = null;
      store.setState({ interaction: NO_INTERACTION, interactionError: null });
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
