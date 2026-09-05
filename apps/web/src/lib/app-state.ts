/** Shared application contracts. Runtime ownership lives in store.ts and its controllers. */

import type { StoreApi, UseBoundStore } from 'zustand';
import type {
  MatchesAnchorV1,
  MatchesAxisArraysV1,
  GroupMember,
  FrequencyTextFilterV1,
  KwicContextMark,
  NumericTrend,
  TrendBinsSpecV1,
  WorkspaceDocumentMetaV1,
  WorkspaceLibraryDocumentV1,
  WorkspaceTrendMeasureV1,
  WorkspaceV1,
} from '@texttrends/core';
import type { TokenRangeSelectionV1 } from './selection.ts';
import type { CapturedTrack } from './track-legend.ts';
import type { ReaderOpenIntent, ReaderAnchorKind, ReaderPlace } from './reader-intent.ts';
import type { AtlasNormalization, ReaderScale } from './reader-view.ts';
import type { PositionHistory, PositionHistoryOrigin } from './position-history.ts';
import type { NotebookGroupV1, QueryNotebookV1, SeriesStyleV1 } from './notebook.ts';
import type { SnapshotInfo } from './client.ts';
import type { InteractionState } from './interaction.ts';
import type { RsvpPacing } from '@texttrends/rsvp';
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
} from '../shared/analysis-contract.ts';
import type { MatchesColumn, MatchesColumnSettings } from './matches-columns.ts';
import type { SessionState } from './project-session.ts';
import type { LocalLibraryFile } from './local-library.ts';
import type { Layer, LayerKind } from './layers.ts';
import type { Place } from './places.ts';
import type { TrendView } from './trend-view.ts';

export interface KwicRowView {
  /** The series (track) that produced this row — the merged match set tags
   *  each occurrence so the panel can colour and label it. */
  readonly seriesId: string;
  /** Wire provenance retained for occurrence identity: under
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
  readonly mode: 'documents' | 'document-rest' | 'selection-rest';
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

export interface KeynessScope {
  readonly view: KeynessViewV1;
  readonly readyDocs: readonly string[];
  readonly selection: TokenRangeSelectionV1 | null;
  readonly tokenCountOf: (doc: string) => number | undefined;
}

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

export type ScrubIntent =
  | { readonly kind: 'drift'; readonly origin: PositionHistoryOrigin }
  | { readonly kind: 'jump'; readonly origin: PositionHistoryOrigin };

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

/** Bootstrap lifecycle, distinct from analysis state: the store is exported
 *  synchronously while the local library, workspace, and initial project load
 *  asynchronously, so there is a window before one-shot session attachment.
 *  A bootstrap failure here is NOT an analysis-generation failure. */
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
  appendFiles(files: readonly LocalLibraryFile[]): void;
  replaceFiles(files: readonly LocalLibraryFile[]): void;
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
  /** Saved references excluded from analysis because their source is damaged. */
  unavailableDocs: readonly { readonly index: number; readonly doc: WorkspaceLibraryDocumentV1 }[];

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
  /** Session-only reading jump list, independent of URL/layer history. */
  positionHistory: PositionHistory;
  /** Transient, snapshot-bound source text for the global reading footer. */
  footerPassage: FooterPassageState | null;
  /** Latest exact w/b navigation request and its accessible outcome. */
  occurrenceNavigation: OccurrenceNavigationState | null;
  /** F owns only the fenced place/placeholder; H attaches reader-page state. */
  readerPlace: ReaderPlace | null;
  /** Presentation scale is transient: it never enters the Reader layer or
   * workspace. External evidence resets it to Read; internal movement keeps it. */
  readerScale: ReaderScale;
  /** Device-local Atlas legibility preference, persisted outside workspace. */
  atlasNormalization: AtlasNormalization;
  readerPage: ReaderPageState | null;
  readerVisibleRange: ReaderVisibleRangeV1 | null;
  /** Page-local presentation state that distinguishes a deliberate prose pick
   * from Reader's automatically published page start. `scrub` remains the one
   * canonical reading position. */
  readerCursorToken: number | null;
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
  setScrub(target: ScrubTarget, intent?: ScrubIntent): void;
  clearScrub(): void;
  /** Move through reading positions without recording the traversal itself. */
  stepPositionHistory(direction: -1 | 1): ScrubTarget | null;
  stepOccurrence(direction: 1 | -1): void;
  openReader(intent: ReaderOpenIntent, returnFocusTo?: string): void;
  /** Move to the adjacent nonempty text at the same relative position. */
  stepReaderDocument(direction: -1 | 1): ScrubTarget | null;
  /** Commit one Atlas location. Body positions stay in Atlas; an explicit
   * descent returns to authenticated Read with the evidence claim preserved. */
  selectAtlasPosition(
    target: ScrubTarget,
    anchor: ReaderAnchorKind,
    descend?: boolean,
  ): void;
  setReaderScale(scale: ReaderScale): void;
  setAtlasNormalization(normalization: AtlasNormalization): void;
  setReaderVisibleRange(range: ReaderVisibleRangeV1): void;
  setReadingCursor(token: number): void;
  refitReaderAt(token: number): void;
  /** Seek to one validated token. Drag phases coalesce into one history jump. */
  seekReader(token: number, phase?: 'start' | 'preview' | 'commit'): void;
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
  replaceInputsAndTerms(files: readonly LocalLibraryFile[]): { readonly texts: number; readonly terms: number } | null;
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
  /** Report an async local-library/workspace bootstrap failure. */
  failBootstrap(error: unknown): void;
  /** Surface a recoverable startup reconciliation to the user. */
  reportNotice(message: string): void;
  /** Surface a non-fatal startup durability failure through the normal retry UI. */
  reportWorkspaceFailure(error: unknown): void;
  /** Fence the bridge and dispose the session. */
  dispose(): void;
}
