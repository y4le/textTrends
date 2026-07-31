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
  canonicalJson,
  DISPERSION_BUCKET_BUDGET,
  DISPERSION_EXACT_MAX,
  FREQUENCY_PAGE_MAX,
  FREQUENCY_PREFIX_MAX_UNITS,
  FREQUENCY_WINDOW_MAX,
  MAX_KWIC_TRACKS,
  PASSAGE_MAX_TOKENS,
  READER_MAX_TOKENS,
  termGroupIdentity,
  RESEARCH_MAX_SELECTIONS,
  type CharAnchorV1,
  type DocumentMetaV1,
  type GroupMember,
  type NumericTrend,
  type ResearchStateV1,
  type SavedPinV1,
  type SavedSelectionV1,
  type ShareLinkV1,
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
  liveReaderPlace,
  readerPlaceFor,
  sameReaderCursor,
  sameReaderPlace,
  type ReaderOpenIntent,
  type ReaderPlace,
} from './reader-intent.ts';
import {
  DEFAULT_READER_MODE,
  READER_MODES,
  type ReaderMode,
} from './reader-presentation.ts';
import {
  coreGroupOf,
  groupIdentity,
  NOTEBOOK_LIMITS_V1,
  parseQuickAdd,
  reconcileStyleSlots,
  validateNotebookGroup,
  type QueryNotebookV1,
} from './notebook.ts';
import { isCancelled, UserDataClientError } from './client.ts';
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
  KeynessResultV1,
  KeynessSortFieldV1,
  WireSelectionV4,
} from '../shared/analysis-contract.ts';
import {
  SessionCommandError,
  type AnalysisPhase,
  type FileLike,
  type SessionState,
} from './project-session.ts';
import {
  decodeShareLink,
  matchShareDocuments,
  shareUrlFor,
} from './share-state.ts';
import {
  historyStateFor,
  parseLayerHistory,
  pushLayer as pushLayerStack,
  reconcileLayerRefs,
  replaceTopLayer,
  updateLayerUI,
  type Layer,
  type LayerKind,
  type LayerUI,
} from './layers.ts';
import {
  DEFAULT_ROUTE,
  EVIDENCE_TIERS,
  parseRoute,
  routeSearch,
  type EvidenceTier,
} from './route.ts';
import type { HistoryPort } from './history-port.ts';
import { PLACES, type Place } from './places.ts';


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
  readonly sortA: { readonly by: KeynessSortFieldV1; readonly dir: 1 | -1 };
  readonly sortB: { readonly by: KeynessSortFieldV1; readonly dir: 1 | -1 };
  readonly pageA: { readonly offset: number; readonly limit: number };
  readonly pageB: { readonly offset: number; readonly limit: number };
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

export interface KeynessEvidenceState {
  readonly snapshot: string;
  readonly side: 'a' | 'b';
  readonly key: string;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly total: number; readonly rows: readonly KwicRowView[] }
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
  sortA: Object.freeze({ by: 'logRatio' as const, dir: -1 as const }),
  sortB: Object.freeze({ by: 'logRatio' as const, dir: 1 as const }),
  pageA: Object.freeze({ offset: 0, limit: 100 }),
  pageB: Object.freeze({ offset: 0, limit: 100 }),
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
    side === 'a' ? view.sortA : view.sortB,
    side === 'a' ? view.pageA : view.pageB,
    side,
  ]);
}

export type TrendView = 'series' | 'by-book';

/** Concordance presentation + ordering intent. This is deliberately fenced
 * from durable research state: reading mode and rendered context are local
 * presentation, while changing order reissues only the KWIC lane. */
export type ConcordanceSortMode = 'proximity' | 'L1' | 'R1' | 'R2';
export type ConcordanceReadingMode = 'aligned' | 'stacked';

export interface ConcordanceView {
  readonly sort: ConcordanceSortMode;
  readonly contextChars: 12 | 24 | 38 | 60;
  readonly reading: ConcordanceReadingMode;
}

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

export type ResearchPersistenceState =
  | { readonly phase: 'idle' | 'loading' | 'dirty' | 'saving' | 'saved' }
  | { readonly phase: 'error'; readonly message: string }
  | {
      readonly phase: 'conflict';
      readonly message: string;
      readonly currentRevision: number;
    };

export interface PinRestoreIssue {
  readonly pin: SavedPinV1;
  readonly reason: 'missing-doc' | 'text-mismatch' | 'empty' | 'error';
  readonly message: string;
}

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
  loadResearch(): {
    result: Promise<import('./client.ts').ResearchLoadResult>;
    cancel: () => void;
  };
  saveResearch(
    state: import('@texttrends/core').ResearchStateV1,
    expectedRevision: number,
  ): { result: Promise<{ revision: number }>; cancel: () => void };
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
  researchPersistence: ResearchPersistenceState;
  savedSelections: readonly SavedSelectionV1[];
  durablePins: readonly SavedPinV1[];
  pinRestoreIssues: readonly PinRestoreIssue[];
  selectionError: string | null;
  shareNotice: string | null;

  // ── Route/layer state: session presentation, never research data. ──
  place: Place;
  evidenceTier: EvidenceTier;
  layers: readonly Layer[];
  setPlace(place: Place): void;
  setEvidenceTier(tier: EvidenceTier, returnFocusTo?: string): void;
  pushLayer(
    kind: Exclude<LayerKind, 'place'>,
    target: unknown,
    returnFocusTo: string,
    ui?: LayerUI,
  ): void;
  replaceLayer(
    kind: Exclude<LayerKind, 'place'>,
    target: unknown,
    returnFocusTo: string,
    ui?: LayerUI,
  ): void;
  setLayerUI(id: string, ui: LayerUI): void;
  /**
   * Close and Escape delegate to Back; popstate performs the mutation.
   * A count greater than one closes one governed parent and its nested
   * descendants as a single user action.
   */
  popLayer(count?: number): void;

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
  frequencyView: FrequencyViewV1;
  frequency: FrequencyState | null;
  /** Full-document chapter labels for the focused book. */
  tfidf: TfidfState | null;
  /** Comparison-owned, brush-independent two-side keyness research intent. */
  keynessView: KeynessViewV1;
  keynessA: KeynessTableState | null;
  keynessB: KeynessTableState | null;
  keynessInventoryA: KeynessInventoryState | null;
  keynessInventoryB: KeynessInventoryState | null;
  keynessEvidence: KeynessEvidenceState | null;
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
  setConcordanceSort(sort: ConcordanceSortMode): void;
  setConcordanceContext(contextChars: ConcordanceView['contextChars']): void;
  setConcordanceReading(reading: ConcordanceReadingMode): void;
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
  runKeyness(): void;
  setKeynessMode(mode: KeynessViewV1['mode']): void;
  setKeynessDocument(side: 'a' | 'b', doc: string): void;
  swapKeynessSides(): void;
  setKeynessFilter(
    minCountTotal: number,
    minDocFreqTotal: number,
    classes: readonly FrequencyTokenClassV1[],
  ): void;
  setKeynessSort(side: 'a' | 'b', by: KeynessSortFieldV1): void;
  setKeynessPage(side: 'a' | 'b', offset: number): void;
  setKeynessPageSize(side: 'a' | 'b', limit: number): void;
  openKeynessEvidence(key: string, side: 'a' | 'b'): void;
  closeKeynessEvidence(): void;
  setFocusedDoc(doc: string): void;
  setSectionMarks(on: boolean): void;
  setScrub(target: ScrubTarget): void;
  /** Adopt a reading position and load its bounded passage without changing
   *  concordance intent or issuing a KWIC query. */
  showEvidenceAt(doc: string, token: number): void;
  clearScrub(): void;
  pinPassage(doc: string, token: number): void;
  removePin(id: string): void;
  setPinNote(id: string, note: string): void;
  retryPin(id: string): void;
  focusPin(id: string): void;
  clearPinError(): void;
  openReader(intent: ReaderOpenIntent, returnFocusTo?: string): void;
  setReaderMode(mode: ReaderMode): void;
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
  saveNamedSelection(name: string): void;
  applyNamedSelection(id: string): void;
  removeNamedSelection(id: string): void;
  reloadResearch(): void;
  overwriteResearch(): void;
  createShareUrl(baseUrl?: string): string;
  importShareLink(value: string): void;
  clearResearchNotice(): void;
  /** Internal restoration seam used by the durable controller. */
  restoreResearch(state: ResearchStateV1): void;
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

function projectTextRows(state: AppState): readonly {
  readonly doc: string;
  readonly text: string;
  readonly title: string;
}[] {
  return (state.projectSession?.project.data.docs ?? []).map((entry) => ({
    doc: entry.doc,
    text: entry.extraction.text,
    title: entry.meta.title,
  }));
}

function researchStateFromApp(
  state: AppState,
  revision: number,
): ResearchStateV1 {
  const project = state.projectSession?.project;
  if (!project) throw new RangeError('the project is still initializing');
  const rows = projectTextRows(state);
  const hashOf = new Map(rows.map((row) => [row.doc, row.text]));
  const readyDocs = state.snapshot?.readyDocs ?? project.data.order;
  const sides = keynessSelections(state.keynessView, readyDocs);
  const hashes = (docs: readonly string[]): CharAnchorV1['text'][] =>
    [...new Set(docs.flatMap((doc) => {
      const hash = hashOf.get(doc);
      return hash === undefined ? [] : [hash as CharAnchorV1['text']];
    }))];
  const { prefixNfc, ...frequency } = state.frequencyView;
  return {
    schema: 'texttrends/research-state/1',
    project: project.id,
    revision,
    notebook: state.notebook,
    active: state.notebook.groups
      .filter((group) => state.activeGroupIds.has(group.id))
      .map((group) => group.id),
    kwicEnabled: state.notebook.groups
      .filter((group) => state.kwicEnabledSeries.has(group.id))
      .map((group) => group.id),
    selections: state.savedSelections,
    pins: state.durablePins,
    views: {
      trend: {
        schema: 'texttrends/trend-view/1',
        mode: state.trendView,
        sectionMarks: state.sectionMarks,
        focusedDoc: state.focusedDoc,
      },
      inventory: {
        schema: 'texttrends/inventory-view/1',
        minCount: frequency.minCount,
        minDocFreq: frequency.minDocFreq,
        classes: frequency.classes,
        ...(prefixNfc === undefined ? {} : { prefixNfc }),
        sort: frequency.sort,
        pageSize: frequency.page.limit,
      },
      keyness: {
        schema: 'texttrends/keyness-view/1',
        a: hashes(sides?.a.docs ?? []),
        b: hashes(sides?.b.docs ?? []),
        mode: state.keynessView.mode,
        filter: {
          minCountTotal: state.keynessView.minCountTotal,
          minDocFreqTotal: state.keynessView.minDocFreqTotal,
          classes: state.keynessView.classes,
        },
        sort: {
          by: state.keynessView.sortA.by,
          dirA: state.keynessView.sortA.dir,
          dirB: state.keynessView.sortB.dir,
        },
        pageSize: state.keynessView.pageA.limit,
      },
    },
  };
}

export function researchSemanticKey(state: AppState): string | null {
  if (!state.projectSession) return null;
  const research = researchStateFromApp(state, 1);
  return canonicalJson({ ...research, revision: 1 });
}

function durablePinFor(
  state: AppState,
  pin: Extract<PinnedSnippet, { readonly kind: 'ready' }>,
): SavedPinV1 | null {
  const doc = projectTextRows(state).find((row) => row.doc === pin.anchor.doc);
  if (!doc) return null;
  const start = pin.evidence.docCharsUtf16.start
    + pin.evidence.anchorCharsUtf16.start;
  const end = pin.evidence.docCharsUtf16.start
    + pin.evidence.anchorCharsUtf16.end;
  return {
    id: pin.id,
    note: '',
    anchor: {
      doc: pin.anchor.doc,
      text: doc.text as CharAnchorV1['text'],
      chars: { start, end },
    },
    captured: pin.tracks.map((track) => ({
      seriesId: track.seriesId,
      groupId: track.groupId,
      identity: track.identity,
      label: track.label,
    })),
  };
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

function routeFromUrl(url: string): { readonly place: Place; readonly evidence: EvidenceTier } {
  try {
    return parseRoute(new URL(url, 'https://texttrends.invalid/').search);
  } catch {
    return DEFAULT_ROUTE;
  }
}

function urlWithRoute(
  url: string,
  route: { readonly place: Place; readonly evidence: EvidenceTier },
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

function historyHash(url: string): string {
  try {
    return new URL(url, 'https://texttrends.invalid/').hash;
  } catch {
    return '';
  }
}

function withoutHistoryHash(url: string): string {
  try {
    const parsed = new URL(url, 'https://texttrends.invalid/');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
}

function evidenceForLayers(layers: readonly Layer[]): EvidenceTier {
  if (layers.some((layer) => layer.kind === 'reader')) return 'reader';
  if (layers.some((layer) => layer.kind === 'sheet')) return 'sheet';
  return 'none';
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
  },
): AppRuntime {
  const newId = opts?.newId ?? (() => crypto.randomUUID());
  const newLayerId = opts?.newLayerId ?? (() => crypto.randomUUID());
  const historyPort = opts?.history ?? null;
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
  // Each visible keyness table and comparison-header inventory owns its lane:
  // paging A cannot supersede B, and neither depends on the global brush.
  const keynessALane = new QueryLane(scope);
  const keynessBLane = new QueryLane(scope);
  const keynessInventoryALane = new QueryLane(scope);
  const keynessInventoryBLane = new QueryLane(scope);
  const keynessEvidenceLane = new QueryLane(scope);
  // On-demand authoring intents (edit-context + line-excerpt), each its own
  // lane; superseded on a snapshot change.
  const editContextLane = new QueryLane(scope);
  const lineExcerptLane = new QueryLane(scope);
  // Full-reader pages are a distinct latest-wins presentation intent. Rapid
  // Next/Previous cannot race with trends, passage, pins, or one another.
  const readerLane = new QueryLane(scope);
  const selectionLane = new QueryLane(scope);
  const pinRestoreLane = new QueryLane(scope);
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
  let passagePending: {
    readonly target: ScrubTarget;
    readonly resetKwicOnFailure: boolean;
  } | null = null;

  // The one attached session (retained in the closure, never in Zustand state —
  // it holds Files, promises, and cancel handles). Null until the composition
  // root attaches it.
  let session: SessionPort | null = null;
  let unsubscribe: (() => void) | null = null;
  let attached = false;
  let disposed = false;
  let researchRevision = 0;
  let researchProject: string | null = null;
  let researchHydrated = false;
  let researchLastKey: string | null = null;
  let researchSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let researchLoadCancel: (() => void) | null = null;
  let researchSaveCancel: (() => void) | null = null;
  let researchLoadToken = 0;
  let researchSaveToken = 0;
  let researchScheduling = false;
  let conflictRevision: number | null = null;
  let researchPausedKey: string | null = null;
  let loadResearchForProject = (_project: string): void => undefined;
  let saveResearchNow = (_overwrite = false): void => undefined;
  let restoreDurablePins = (): void => undefined;
  let historyTraversalPending = false;

  // Route and layer state is initialized before the store so the first React
  // snapshot and the current history entry cannot disagree. A deep evidence
  // route first installs a zero-layer base entry, then pushes its layer: Back
  // remains inside the workbench.
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
  let initialEvidence: EvidenceTier = 'none';
  if (historyPort !== null) {
    historyPort.replace(
      historyStateFor([]),
      urlWithRoute(historyPort.url, { place: bootRoute.place, evidence: 'none' }),
    );
    // A sheet can honestly boot without selected evidence. A reader cannot:
    // its target is a snapshot-bound document/cursor held only in the
    // in-memory layer registry, never in the URL.
    if (bootRoute.evidence === 'sheet') {
      const deepLayer: Layer = {
        kind: bootRoute.evidence,
        id: newLayerId(),
        target: Object.freeze({ source: 'route', evidence: bootRoute.evidence }),
        returnFocusTo: `place-${bootRoute.place}-heading`,
        ...(bootRoute.evidence === 'sheet' ? { ui: { detent: 'peek' as const } } : {}),
      };
      initialLayers = pushLayerStack([], deepLayer);
      initialEvidence = bootRoute.evidence;
      rememberLayer(deepLayer, initialLayers);
      historyPort.push(
        historyStateFor(initialLayers),
        urlWithRoute(historyPort.url, bootRoute),
      );
    }
  }

  const store = create<AppState>((set, get) => {
    const readerForLayers = (
      layers: readonly Layer[],
      snapshot = get().snapshot,
    ): ReaderPlace | null => {
      const layer = layers.at(-1);
      if (layer?.kind !== 'reader') return null;
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
      const evidenceTier = evidenceForLayers(layers);
      if (historyPort !== null) {
        historyPort[mode](
          historyStateFor(layers),
          urlWithRoute(historyPort.url, { place, evidence: evidenceTier }),
        );
      }
      const current = get();
      const readerPlace = readerForLayers(layers, current.snapshot);
      const readerChanged = !sameReaderPlace(current.readerPlace, readerPlace);
      if (readerChanged) readerLane.supersede();
      set((state) => ({
        place,
        evidenceTier,
        layers,
        notebookError: place === state.place ? state.notebookError : null,
        readerPlace,
        readerPage: readerChanged ? null : state.readerPage,
        readerNavigation:
          readerChanged && !options.preserveReaderNavigation
            ? null
            : state.readerNavigation,
      }));
    };

    const requestBack = (count = 1): void => {
      const layers = get().layers;
      if (
        historyTraversalPending
        || layers.length === 0
        || !Number.isSafeInteger(count)
        || count < 1
        || count > layers.length
      ) return;
      if (historyPort === null) {
        const closing = layers.at(-count)!;
        writeNavigation('replace', get().place, layers.slice(0, -count));
        restoreFocusTo(closing.returnFocusTo);
        return;
      }
      historyTraversalPending = true;
      historyPort.back(count);
    };

    const freshLayer = (
      kind: Exclude<LayerKind, 'place'>,
      target: unknown,
      returnFocusTo: string,
      ui?: LayerUI,
    ): Layer => ({
      kind,
      id: newLayerId(),
      target,
      returnFocusTo,
      ...(ui === undefined ? {} : { ui }),
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
          onError(e instanceof Error ? e.message : String(e));
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
      const sort = side === 'a' ? issuedView.sortA : issuedView.sortB;
      const page = side === 'a' ? issuedView.pageA : issuedView.pageB;
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
            sections: false,
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

    const upsertDurableReadyPin = (
      ready: Extract<PinnedSnippet, { readonly kind: 'ready' }>,
    ): void => {
      set((state) => {
        const durable = durablePinFor(state, ready);
        if (!durable) return {};
        const sameAnchor = (candidate: SavedPinV1): boolean =>
          candidate.anchor.doc === durable.anchor.doc &&
          candidate.anchor.text === durable.anchor.text &&
          candidate.anchor.chars.start === durable.anchor.chars.start &&
          candidate.anchor.chars.end === durable.anchor.chars.end;
        const existing = state.durablePins.find(sameAnchor);
        const next = existing
          ? { ...durable, id: existing.id, note: existing.note }
          : durable;
        return {
          durablePins: [
            ...state.durablePins.filter(
              (candidate) => candidate.id !== next.id && !sameAnchor(candidate),
            ),
            next,
          ].slice(-MAX_PINNED_SNIPPETS),
          pinRestoreIssues: state.pinRestoreIssues.filter(
            (issue) => issue.pin.id !== existing?.id,
          ),
        };
      });
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
          const ready: Extract<PinnedSnippet, { readonly kind: 'ready' }> = {
            kind: 'ready',
            id,
            anchor,
            tracks,
            evidence,
          };
          replacePin(id, () => ready);
          upsertDurableReadyPin(ready);
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
      const intent = passagePending;
      if (!intent) return;
      passagePending = null;
      const { target } = intent;
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
            // scrub rather than display a block that does not match it. Only
            // raw chart scrubbing owns concordance intent; an Evidence-only
            // adoption must never issue a KWIC query on its failure path.
            const scrub = get().scrub;
            const targetStillCurrent =
              scrub?.doc === target.doc && scrub.token === target.token;
            if (targetStillCurrent) {
              set({ passage: null, scrub: null });
              if (intent.resetKwicOnFailure) {
                resetKwicCenter();
                runKwic();
              }
            }
          }
          pumpPassage();
        });
    };

    /** Adopt one validated reading target into the shared Evidence tier.
     *  Returns whether the reading position changed; passage loading remains
     *  one-active/one-replaceable and is deliberately independent of KWIC. */
    const adoptEvidenceTarget = (
      target: ScrubTarget,
      resetKwicOnFailure: boolean,
    ): boolean => {
      const { snapshot, passage } = get();
      if (
        !snapshot
        || !snapshot.readyDocs.includes(target.doc)
        || !Number.isSafeInteger(target.token)
        || target.token < 0
      ) return false;
      const tokenCount = docTokenCountOf(target.doc);
      if (tokenCount !== null && target.token >= tokenCount) return false;

      const prev = get().scrub;
      const changed = !prev || prev.doc !== target.doc || prev.token !== target.token;
      if (changed) set({ scrub: target });
      if (!passage || !blockServes(passage, target)) {
        passagePending = { target, resetKwicOnFailure };
        pumpPassage();
      }
      return changed;
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
      const { snapshot, series, kwicEnabledSeries, concordanceView } = get();
      // No snapshot, or no terms at all (blank input) → no panel (kwic null),
      // distinct from "terms exist but all toggled off" (the no-terms state).
      if (!snapshot || series.length === 0) {
        set({ kwic: null });
        return;
      }
      // The center must name a ready doc at issue time; a stale center (its doc
      // departed on a new snapshot) degrades to reading order, never a clamp.
      const center = concordanceView.sort === 'proximity'
        && kwicCenter
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
            sort: concordanceView.sort === 'proximity'
              ? [{ at: 'doc', dir: 1 }, { at: 'pos', dir: 1 }]
              : [
                  { at: concordanceView.sort, dir: 1 },
                  { at: 'doc', dir: 1 },
                  { at: 'pos', dir: 1 },
                ],
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
      const { series, kwicEnabledSeries, concordanceView } = get();
      if (!series.some((s) => kwicEnabledSeries.has(s.id))) return;
      // Collocate sorts deliberately do not depend on reading position. Raw
      // evidence navigation therefore leaves their resident ordering intact;
      // returning to proximity adopts the live scrub in one explicit reissue.
      if (concordanceView.sort !== 'proximity') return;
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
      researchPersistence: { phase: 'idle' },
      savedSelections: [],
      durablePins: [],
      pinRestoreIssues: [],
      selectionError: null,
      shareNotice: null,
      place: bootRoute.place,
      evidenceTier: initialEvidence,
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
      setEvidenceTier(tier, returnFocusTo = `place-${get().place}-heading`) {
        if (!EVIDENCE_TIERS.includes(tier) || tier === get().evidenceTier) return;
        if (tier === 'none') {
          // Closing and demotion share the browser's one stack. popstate is
          // the only code path that mutates the visible layer state.
          requestBack();
          return;
        }
        // Reader requires a resolved snapshot/doc/cursor intent. A bare tier
        // would create an invisible URL-only layer; openReader is the sole
        // promotion path.
        if (tier === 'reader') return;
        if (get().evidenceTier === 'reader') {
          if (get().layers.at(-2)?.kind === 'sheet') {
            requestBack();
            return;
          }
          // A hand-authored/deep bare reader has no prior sheet to reveal.
          // Demotion replaces its active depth with the requested sheet.
          const sheet = freshLayer(
            'sheet',
            Object.freeze({ source: 'route', evidence: 'sheet' }),
            returnFocusTo,
            { detent: 'peek' },
          );
          const layers = replaceTopLayer(get().layers, sheet);
          rememberLayer(sheet, layers);
          writeNavigation('replace', get().place, layers);
          return;
        }
        const next = freshLayer(
          tier,
          Object.freeze({ source: 'route', evidence: tier }),
          returnFocusTo,
          tier === 'sheet' ? { detent: 'peek' } : undefined,
        );
        const layers = pushLayerStack(get().layers, next);
        rememberLayer(next, layers);
        writeNavigation('push', get().place, layers);
      },
      pushLayer(kind, target, returnFocusTo, ui) {
        const next = freshLayer(kind, target, returnFocusTo, ui);
        const layers = pushLayerStack(get().layers, next);
        rememberLayer(next, layers);
        writeNavigation('push', get().place, layers);
      },
      replaceLayer(kind, target, returnFocusTo, ui) {
        const next = freshLayer(kind, target, returnFocusTo, ui);
        const layers = replaceTopLayer(get().layers, next);
        rememberLayer(next, layers);
        writeNavigation('replace', get().place, layers);
      },
      setLayerUI(id, ui) {
        const layers = updateLayerUI(get().layers, id, ui);
        if (layers === get().layers) return;
        const changed = layers.find((layer) => layer.id === id);
        if (changed !== undefined) rememberLayer(changed, layers);
        writeNavigation('replace', get().place, layers);
      },
      popLayer(count = 1) {
        requestBack(count);
      },
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
      concordanceView: {
        sort: 'proximity',
        contextChars: 38,
        reading: 'aligned',
      },
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
      keynessView: DEFAULT_KEYNESS_VIEW,
      keynessA: null,
      keynessB: null,
      keynessInventoryA: null,
      keynessInventoryB: null,
      keynessEvidence: null,
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

      setConcordanceSort(sort) {
        if (!(['proximity', 'L1', 'R1', 'R2'] as const).includes(sort)) return;
        const state = get();
        if (state.concordanceView.sort === sort) return;
        if (kwicCenterTimer !== null) {
          clearTimeout(kwicCenterTimer);
          kwicCenterTimer = null;
        }
        if (sort === 'proximity') {
          const scrub = state.scrub;
          kwicCenter = scrub && state.snapshot?.readyDocs.includes(scrub.doc)
            ? scrub
            : null;
        }
        set({ concordanceView: { ...state.concordanceView, sort } });
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
        const changed = adoptEvidenceTarget(target, true);
        const alreadySettled =
          kwicCenter?.doc === target.doc
          && kwicCenter.token === target.token
          && kwicCenter.origin === undefined;
        if (!changed && alreadySettled) return;
        scheduleKwicCenter(target); // debounced concordance re-centre on the axis
      },

      showEvidenceAt(doc, token) {
        adoptEvidenceTarget({ doc, token }, false);
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
            upsertDurableReadyPin(
              ready as Extract<PinnedSnippet, { readonly kind: 'ready' }>,
            );
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
        const removed = get().pins.find((pin) => pin.id === id);
        const durable = removed?.kind === 'ready'
          ? durablePinFor(get(), removed)
          : null;
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
            durablePins: state.durablePins.filter((candidate) =>
              candidate.id !== id &&
              !(
                durable !== null &&
                candidate.anchor.doc === durable.anchor.doc &&
                candidate.anchor.text === durable.anchor.text &&
                candidate.anchor.chars.start === durable.anchor.chars.start &&
                candidate.anchor.chars.end === durable.anchor.chars.end
              )),
            focusedPinId: state.focusedPinId === id ? neighbour : state.focusedPinId,
            pinError: null,
            pinAnnouncement: 'Removed pinned evidence.',
          };
        });
      },

      setPinNote(id, note) {
        const normalized = note.normalize('NFC').slice(0, 2_000);
        const pin = get().pins.find(
          (candidate): candidate is Extract<PinnedSnippet, { readonly kind: 'ready' }> =>
            candidate.id === id && candidate.kind === 'ready',
        );
        if (!pin) return;
        const durable = durablePinFor(get(), pin);
        if (!durable) return;
        set((state) => ({
          durablePins: state.durablePins.map((candidate) =>
            (
              candidate.id === id ||
              (
                candidate.anchor.doc === durable.anchor.doc &&
                candidate.anchor.text === durable.anchor.text &&
                candidate.anchor.chars.start === durable.anchor.chars.start &&
                candidate.anchor.chars.end === durable.anchor.chars.end
              )
            )
              ? { ...candidate, note: normalized }
              : candidate),
        }));
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
            { reader: DEFAULT_READER_MODE },
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

      setReaderMode(mode) {
        if (!READER_MODES.includes(mode)) return;
        const layer = get().layers.at(-1);
        if (layer?.kind !== 'reader' || layer.ui?.reader === mode) return;
        get().setLayerUI(layer.id, { reader: mode });
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
        const nextPlace: ReaderPlace = { ...place, cursor: { ...cursor } };
        const readerLayer = get().layers.at(-1);
        if (readerLayer?.kind !== 'reader') return;
        const nextLayer: Layer = {
          ...readerLayer,
          target: Object.freeze(nextPlace),
        };
        const layers = [...get().layers.slice(0, -1), nextLayer];
        rememberLayer(nextLayer, layers);
        writeNavigation(
          'replace',
          get().place,
          layers,
          { preserveReaderNavigation: true },
        );
        get().runReader();
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
        if (dead.length > 0) {
          const deadIds = new Set(dead.map((pin) => pin.id));
          set({
            pins: state.pins.filter((pin) => !deadIds.has(pin.id)),
            focusedPinId: deadIds.has(state.focusedPinId ?? '') ? null : state.focusedPinId,
            pinError: null,
            pinAnnouncement: dead.length > 0 ? 'Cleared pins from the replaced snapshot.' : state.pinAnnouncement,
          });
        }
        if (!readerLive && state.readerPlace !== null) {
          const readerIndex = state.layers.findIndex((layer) => layer.kind === 'reader');
          const layers = readerIndex < 0
            ? state.layers
            : state.layers.slice(0, readerIndex);
          // Snapshot invalidation is store-driven, not a user Back intent:
          // consume the now-unresolvable current entry in place.
          writeNavigation('replace', state.place, layers);
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
          passagePending = { target: scrub, resetKwicOnFailure: true };
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
            pageA: { ...state.keynessView.pageA, offset: 0 },
            pageB: { ...state.keynessView.pageB, offset: 0 },
          },
          keynessEvidence: null,
        });
        keynessEvidenceLane.supersede();
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
            pageA: { ...view.pageA, offset: 0 },
            pageB: { ...view.pageB, offset: 0 },
          },
          keynessEvidence: null,
        });
        keynessEvidenceLane.supersede();
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
            pageA: { ...view.pageA, offset: 0 },
            pageB: { ...view.pageB, offset: 0 },
          };
        } else if (view.restOn === 'b') {
          const focus = view.documentA;
          next = {
            ...view,
            restOn: 'a',
            documentB: focus,
            documentA: ready.find((doc) => doc !== focus) ?? null,
            pageA: { ...view.pageA, offset: 0 },
            pageB: { ...view.pageB, offset: 0 },
          };
        } else {
          const focus = view.documentB;
          next = {
            ...view,
            restOn: 'b',
            documentA: focus,
            documentB: ready.find((doc) => doc !== focus) ?? null,
            pageA: { ...view.pageA, offset: 0 },
            pageB: { ...view.pageB, offset: 0 },
          };
        }
        set({ keynessView: next, keynessEvidence: null });
        keynessEvidenceLane.supersede();
        get().runKeyness();
      },

      setKeynessFilter(minCountTotal, minDocFreqTotal, classes) {
        const unique = [...new Set(classes)].filter(
          (value): value is FrequencyTokenClassV1 =>
            value === 'lexical' || value === 'numeral',
        );
        if (
          !Number.isSafeInteger(minCountTotal) ||
          minCountTotal < 1 ||
          !Number.isSafeInteger(minDocFreqTotal) ||
          minDocFreqTotal < 1 ||
          unique.length === 0
        ) {
          return;
        }
        const view = get().keynessView;
        set({
          keynessView: {
            ...view,
            minCountTotal,
            minDocFreqTotal,
            classes: unique,
            pageA: { ...view.pageA, offset: 0 },
            pageB: { ...view.pageB, offset: 0 },
          },
        });
        runKeynessTable('a');
        runKeynessTable('b');
      },

      setKeynessSort(side, by) {
        if (!['logRatio', 'g2', 'countA', 'countB'].includes(by)) return;
        const view = get().keynessView;
        const current = side === 'a' ? view.sortA : view.sortB;
        const dir = current.by === by
          ? (current.dir === 1 ? -1 : 1)
          : (by === 'logRatio' && side === 'b' ? 1 : -1);
        const next: KeynessViewV1 = side === 'a'
          ? {
              ...view,
              sortA: { by, dir },
              pageA: { ...view.pageA, offset: 0 },
            }
          : {
              ...view,
              sortB: { by, dir },
              pageB: { ...view.pageB, offset: 0 },
            };
        set({ keynessView: next });
        runKeynessTable(side);
      },

      setKeynessPage(side, offset) {
        const view = get().keynessView;
        const page = side === 'a' ? view.pageA : view.pageB;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset + page.limit > FREQUENCY_WINDOW_MAX
        ) {
          return;
        }
        set({
          keynessView: side === 'a'
            ? { ...view, pageA: { ...page, offset } }
            : { ...view, pageB: { ...page, offset } },
        });
        runKeynessTable(side);
      },

      setKeynessPageSize(side, limit) {
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > FREQUENCY_PAGE_MAX
        ) {
          return;
        }
        const view = get().keynessView;
        set({
          keynessView: side === 'a'
            ? { ...view, pageA: { offset: 0, limit } }
            : { ...view, pageB: { offset: 0, limit } },
        });
        runKeynessTable(side);
      },

      openKeynessEvidence(key, side) {
        keynessEvidenceLane.supersede();
        const { snapshot, keynessView } = get();
        const pair = snapshot
          ? keynessSelections(keynessView, snapshot.readyDocs)
          : null;
        if (!snapshot || !pair) {
          set({ keynessEvidence: null });
          return;
        }
        const label = key.normalize('NFC');
        const group = {
          id: 'keyness-evidence',
          name: label,
          members: [{
            id: 'keyness-evidence-member',
            kind: 'token' as const,
            surface: label,
            match: {
              case: 'sensitive' as const,
              diacritics: 'sensitive' as const,
            },
          }],
          countOverlaps: false,
        };
        try {
          validateNotebookGroup(group);
        } catch {
          return;
        }
        const issuedKey = snapKey(snapshot);
        const issuedView = keynessView;
        const issuedSelection = keynessSideSelectionKey(
          issuedView,
          snapshot.readyDocs,
          side,
        );
        const lease = keynessEvidenceLane.ops.begin(
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
        set({
          keynessEvidence: {
            snapshot: snapshot.snapshot,
            side,
            key: label,
            state: { status: 'pending' },
          },
        });
        issueOn(
          keynessEvidenceLane,
          snapshot.snapshot,
          {
            op: 'kwic',
            selection: pair[side],
            tracks: [{
              seriesId: `keyness-${side}`,
              group: coreGroupOf(group),
            }],
            request: {
              contextTokens: 6,
              sort: [{ at: 'doc', dir: 1 }, { at: 'pos', dir: 1 }],
              page: { offset: 0, limit: 50 },
            },
          },
          lease,
          (data) => {
            if (data.op !== 'kwic') return;
            set({
              keynessEvidence: {
                snapshot: snapshot.snapshot,
                side,
                key: label,
                state: {
                  status: 'ready',
                  total: data.total,
                  rows: data.rows,
                },
              },
            });
          },
          (message) => set({
            keynessEvidence: {
              snapshot: snapshot.snapshot,
              side,
              key: label,
              state: { status: 'error', message },
            },
          }),
        );
      },

      closeKeynessEvidence() {
        keynessEvidenceLane.supersede();
        set({ keynessEvidence: null });
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
        let queryIntentChanged = false;
        // A DELIBERATE click outside the active range clears the range first
        // (visibly — the shading and overlays drop) so the clicked evidence
        // can appear in the range-scoped concordance (ruling §2).
        const sel = state.linkedSelection;
        if (sel !== null && (doc !== sel.doc || token < sel.tokens.start || token >= sel.tokens.end)) {
          set({ linkedSelection: null });
          runSelected();
          queryIntentChanged = true;
        }
        // The activated track must be able to appear in the result: a
        // disabled chip is re-enabled (visible state change, not a silent
        // override) before the reissue (review-D HIGH).
        if (state.series.some((s) => s.id === seriesId) && !state.kwicEnabledSeries.has(seriesId)) {
          const next = new Set(state.kwicEnabledSeries);
          next.add(seriesId);
          set({ kwicEnabledSeries: next });
          queryIntentChanged = true;
        }
        // IMMEDIATE evidence: cancel any pending debounce and adopt the
        // position as the concordance center (like the chip toggle path).
        if (kwicCenterTimer !== null) { clearTimeout(kwicCenterTimer); kwicCenterTimer = null; }
        kwicCenter = origin ? { doc, token, origin: 'bucket', bucketCount: origin.count } : { doc, token };
        // A collocate order is independent of reading position. Reissue only
        // when activation also changed the range or enabled-track intent.
        if (state.concordanceView.sort === 'proximity' || queryIntentChanged) runKwic();
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
      saveNamedSelection(name) {
        selectionLane.supersede();
        const normalized = name.trim().normalize('NFC');
        const state = get();
        if (normalized.length < 1 || normalized.length > 256) {
          set({ selectionError: 'A saved selection needs a name of at most 256 characters.' });
          return;
        }
        if (state.savedSelections.length >= RESEARCH_MAX_SELECTIONS) {
          set({ selectionError: `Saved selections are limited to ${RESEARCH_MAX_SELECTIONS}.` });
          return;
        }
        const selection = state.linkedSelection;
        const snapshot = state.snapshot;
        if (!selection || !snapshot || selection.snapshot !== snapshot.snapshot) {
          set({ selectionError: 'Select a token range before saving it.' });
          return;
        }
        const issuedKey = snapKey(snapshot);
        const lease = selectionLane.ops.begin(
          () => snapKey(get().snapshot) === issuedKey,
          () => get().linkedSelection === selection,
        );
        set({ selectionError: null });
        issueOn(
          selectionLane,
          snapshot.snapshot,
          {
            op: 'anchor-tokens',
            request: {
              method: 'anchor-tokens/1',
              doc: selection.doc,
              tokens: selection.tokens,
            },
          },
          lease,
          (data) => {
            if (data.op !== 'anchor-tokens') return;
            set((live) => ({
              savedSelections: [
                ...live.savedSelections,
                {
                  id: newId(),
                  name: normalized,
                  anchor: data.result.anchor,
                },
              ],
              selectionError: null,
            }));
          },
          (message) => set({ selectionError: message }),
        );
      },
      applyNamedSelection(id) {
        selectionLane.supersede();
        const state = get();
        const saved = state.savedSelections.find((candidate) => candidate.id === id);
        const snapshot = state.snapshot;
        if (!saved || !snapshot) return;
        const issuedKey = snapKey(snapshot);
        const lease = selectionLane.ops.begin(
          () => snapKey(get().snapshot) === issuedKey,
          () => get().savedSelections.some((candidate) => candidate.id === id),
        );
        issueOn(
          selectionLane,
          snapshot.snapshot,
          {
            op: 'compile-anchor',
            request: { method: 'compile-anchor/1', anchors: [saved.anchor] },
          },
          lease,
          (data) => {
            if (data.op !== 'compile-anchor') return;
            const row = data.result.rows[0];
            if (row?.status !== 'ok') {
              set({
                selectionError: row?.status === 'text-mismatch'
                  ? 'The document text changed; this selection needs review.'
                  : row?.status === 'missing-doc'
                    ? 'This selection’s document is unavailable.'
                    : 'This saved selection is empty under the current index recipe.',
              });
              return;
            }
            get().setLinkedSelection({
              snapshot: snapshot.snapshot,
              doc: row.anchor.doc,
              tokens: row.tokens,
            });
            set({ selectionError: null });
          },
          (message) => set({ selectionError: message }),
        );
      },
      removeNamedSelection(id) {
        set((state) => ({
          savedSelections: state.savedSelections.filter(
            (selection) => selection.id !== id,
          ),
          selectionError: null,
        }));
      },
      reloadResearch() {
        const project = get().projectSession?.project.id;
        if (project) loadResearchForProject(project);
      },
      overwriteResearch() {
        saveResearchNow(true);
      },
      createShareUrl(baseUrl) {
        const state = get();
        const research = researchStateFromApp(state, 1);
        const groupIndex = new Map(
          research.notebook.groups.map((group, index) => [group.id, index]),
        );
        const share: ShareLinkV1 = {
          s: 1,
          n: research.notebook,
          a: research.active.map((id) => groupIndex.get(id)!).filter(
            (index) => index !== undefined,
          ),
          k: research.kwicEnabled.map((id) => groupIndex.get(id)!).filter(
            (index) => index !== undefined,
          ),
          v: {
            t: research.views.trend,
            i: research.views.inventory,
            y: research.views.keyness,
          },
          x: projectTextRows(state).map((row) => ({
            d: row.doc,
            h: row.text,
            ...(row.title === '' ? {} : { t: row.title.normalize('NFC').slice(0, 256) }),
          })),
          ...(research.selections.length === 0
            ? {}
            : { r: research.selections.map((selection) => selection.anchor) }),
        };
        const fallback = historyPort?.url ?? 'https://texttrends.invalid/';
        return shareUrlFor(share, baseUrl ?? fallback);
      },
      importShareLink(value) {
        try {
          const share = decodeShareLink(value);
          const state = get();
          const current = researchStateFromApp(state, 1);
          const rows = projectTextRows(state);
          const matched = matchShareDocuments(share, rows);
          const groupId = (index: number): string | null =>
            share.n.groups[index]?.id ?? null;
          const active = share.a.flatMap((index) => {
            const id = groupId(index);
            return id === null ? [] : [id];
          });
          const kwicEnabled = share.k.flatMap((index) => {
            const id = groupId(index);
            return id === null ? [] : [id];
          });
          const focusedSender = share.v.t?.focusedDoc ?? null;
          const focusedHash = share.x.find((doc) => doc.d === focusedSender)?.h;
          const focusedDoc = focusedHash === undefined
            ? null
            : rows.find((row) => row.text === focusedHash)?.doc ?? null;
          const imported: ResearchStateV1 = {
            ...current,
            notebook: share.n,
            active,
            kwicEnabled,
            selections: matched.anchors.map((anchor, index) => ({
              id: newId(),
              name: `Shared selection ${index + 1}`,
              anchor,
            })),
            views: {
              trend: share.v.t === undefined
                ? current.views.trend
                : { ...share.v.t, focusedDoc },
              inventory: share.v.i ?? current.views.inventory,
              keyness: share.v.y ?? current.views.keyness,
            },
          };
          get().restoreResearch(imported);
          if (historyPort !== null && historyHash(historyPort.url).startsWith('#s=')) {
            const routed = urlWithRoute(historyPort.url, {
              place: get().place,
              evidence: get().evidenceTier,
            });
            historyPort.replace(historyPort.state, withoutHistoryHash(routed));
          }
          set({
            shareNotice: matched.unmatchedDocuments.length === 0
              ? `Imported shared research state; ${matched.matchedDocuments} document${matched.matchedDocuments === 1 ? '' : 's'} matched.`
              : `Imported shared research state; ${matched.unmatchedDocuments.length} document${matched.unmatchedDocuments.length === 1 ? '' : 's'} did not match: ${matched.unmatchedDocuments.join(', ')}`,
          });
        } catch (error) {
          set({ shareNotice: `Could not import share link: ${msg(error)}` });
        }
      },
      clearResearchNotice() {
        set({ selectionError: null, shareNotice: null });
      },
      restoreResearch(research) {
        const state = get();
        const rows = projectTextRows(state);
        const docsByHash = new Map(rows.map((row) => [row.text, row.doc]));
        const a = research.views.keyness.a.flatMap((hash) => {
          const doc = docsByHash.get(hash);
          return doc === undefined ? [] : [doc];
        });
        const b = research.views.keyness.b.flatMap((hash) => {
          const doc = docsByHash.get(hash);
          return doc === undefined ? [] : [doc];
        });
        const keyness = research.views.keyness;
        const restOn = keyness.mode === 'document-rest' && b.length === 1
          ? 'a'
          : 'b';
        const documentA = keyness.mode === 'document-rest' && restOn === 'a'
          ? a.find((doc) => doc !== b[0]) ?? null
          : a[0] ?? null;
        const documentB = keyness.mode === 'document-rest' && restOn === 'b'
          ? b.find((doc) => doc !== a[0]) ?? null
          : b[0] ?? null;
        set({
          trendView: research.views.trend.mode,
          sectionMarks: research.views.trend.sectionMarks,
          focusedDoc: research.views.trend.focusedDoc,
          frequencyView: {
            schema: 'texttrends/frequency-view/1',
            minCount: research.views.inventory.minCount,
            minDocFreq: research.views.inventory.minDocFreq,
            classes: research.views.inventory.classes,
            ...(research.views.inventory.prefixNfc === undefined
              ? {}
              : { prefixNfc: research.views.inventory.prefixNfc }),
            sort: research.views.inventory.sort,
            page: { offset: 0, limit: research.views.inventory.pageSize },
          },
          keynessView: {
            schema: 'texttrends/keyness-view/1',
            mode: keyness.mode,
            documentA,
            documentB,
            restOn,
            minCountTotal: keyness.filter.minCountTotal,
            minDocFreqTotal: keyness.filter.minDocFreqTotal,
            classes: keyness.filter.classes,
            sortA: { by: keyness.sort.by, dir: keyness.sort.dirA },
            sortB: { by: keyness.sort.by, dir: keyness.sort.dirB },
            pageA: { offset: 0, limit: keyness.pageSize },
            pageB: { offset: 0, limit: keyness.pageSize },
          },
          savedSelections: research.selections,
          durablePins: research.pins,
          pinRestoreIssues: [],
          pins: [],
          focusedPinId: null,
          selectionError: null,
        });
        adoptNotebook(
          {
            notebook: research.notebook,
            activeGroupIds: new Set(research.active),
            kwicEnabledGroupIds: new Set(research.kwicEnabled),
            soloGroupId: null,
          },
          { reissue: true },
        );
        get().runInventory();
        get().runFrequency();
        get().runKeyness();
        restoreDurablePins();
      },
    };
  });

  const reconcileHistory = (): void => {
    if (historyPort === null || disposed) return;
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
    const evidenceTier = evidenceForLayers(layers);
    const readerChanged = !sameReaderPlace(previous.readerPlace, readerPlace);
    if (readerChanged) readerLane.supersede();
    store.setState((state) => ({
      place: route.place,
      evidenceTier,
      layers,
      notebookError: route.place === state.place ? state.notebookError : null,
      readerPlace,
      readerPage: readerChanged ? null : state.readerPage,
      readerNavigation: readerChanged ? null : state.readerNavigation,
    }));
    const normalizedUrl = urlWithRoute(historyPort.url, {
      place: route.place,
      evidence: evidenceTier,
    });
    if (
      !parsed.valid
      || reconciled.truncated
      || staleReader
      || route.evidence !== evidenceTier
      || relativeHistoryUrl(historyPort.url) !== normalizedUrl
    ) {
      historyPort.replace(historyStateFor(layers), normalizedUrl);
    }
    const removed = previous.layers.find(
      (candidate) => !layers.some((layer) => layer.id === candidate.id),
    );
    if (removed) {
      restoreFocusTo(removed.returnFocusTo);
    }
    if (readerPlace !== null && readerChanged) {
      store.getState().runReader();
    }
  };
  const unsubscribeHistory = historyPort?.subscribe(reconcileHistory) ?? (() => undefined);

  const clearResearchTimer = (): void => {
    if (researchSaveTimer !== null) {
      clearTimeout(researchSaveTimer);
      researchSaveTimer = null;
    }
  };

  const scheduleResearchSave = (): void => {
    if (
      disposed ||
      !researchHydrated ||
      researchProject === null ||
      conflictRevision !== null
    ) {
      return;
    }
    if (researchScheduling) return;
    researchScheduling = true;
    clearResearchTimer();
    if (store.getState().researchPersistence.phase !== 'dirty') {
      store.setState({ researchPersistence: { phase: 'dirty' } });
    }
    researchSaveTimer = setTimeout(() => {
      researchSaveTimer = null;
      saveResearchNow(false);
    }, 1_500);
    researchScheduling = false;
  };

  restoreDurablePins = (): void => {
    pinRestoreLane.supersede();
    const state = store.getState();
    const snapshot = state.snapshot;
    if (!snapshot || state.durablePins.length === 0) {
      if (state.durablePins.length === 0) {
        store.setState({ pinRestoreIssues: [] });
      }
      return;
    }
    const issuedPins = state.durablePins;
    const issuedKey = snapKey(snapshot);
    const lease = pinRestoreLane.ops.begin(
      () => snapKey(store.getState().snapshot) === issuedKey,
      () => store.getState().durablePins === issuedPins,
    );
    const handle = client.query(snapshot.snapshot, {
      op: 'compile-anchor',
      request: {
        method: 'compile-anchor/1',
        anchors: issuedPins.map((pin) => pin.anchor),
      },
    });
    pinRestoreLane.track(handle.cancel);
    void handle.result.then((data) => {
      if (!lease.isCurrent() || data.op !== 'compile-anchor') return;
      const issues: PinRestoreIssue[] = [];
      for (let index = 0; index < issuedPins.length; index++) {
        const pin = issuedPins[index]!;
        const row = data.result.rows[index];
        if (row?.status === 'ok') {
          store.getState().pinPassage(row.anchor.doc, row.tokens.start);
          continue;
        }
        const reason = row?.status ?? 'error';
        issues.push({
          pin,
          reason,
          message: reason === 'text-mismatch'
            ? 'document text changed'
            : reason === 'missing-doc'
              ? 'document is unavailable'
              : reason === 'empty'
                ? 'no current token overlaps this character anchor'
                : 'anchor restoration failed',
        });
      }
      store.setState({ pinRestoreIssues: issues });
    }).catch((error: unknown) => {
      if (isCancelled(error) || !lease.isCurrent()) return;
      store.setState({
        pinRestoreIssues: issuedPins.map((pin) => ({
          pin,
          reason: 'error',
          message: msg(error),
        })),
      });
    });
  };

  loadResearchForProject = (project: string): void => {
    if (!session || disposed) return;
    const replacingProject = researchProject !== null && researchProject !== project;
    clearResearchTimer();
    pinRestoreLane.supersede();
    researchLoadCancel?.();
    researchSaveCancel?.();
    researchLoadCancel = null;
    researchSaveCancel = null;
    const token = ++researchLoadToken;
    researchSaveToken += 1;
    researchHydrated = false;
    researchProject = project;
    researchRevision = 0;
    researchLastKey = null;
    conflictRevision = null;
    researchPausedKey = null;
    if (replacingProject) {
      store.setState({
        savedSelections: [],
        durablePins: [],
        pinRestoreIssues: [],
      });
    }
    const startKey = researchSemanticKey(store.getState());
    store.setState({ researchPersistence: { phase: 'loading' } });
    const handle = session.loadResearch();
    researchLoadCancel = handle.cancel;
    void handle.result.then((result) => {
      if (
        disposed ||
        token !== researchLoadToken ||
        store.getState().projectSession?.project.id !== project
      ) {
        return;
      }
      researchLoadCancel = null;
      if (result.kind === 'loaded') {
        researchRevision = result.state.revision;
        store.getState().restoreResearch(result.state);
        researchHydrated = true;
        researchLastKey = researchSemanticKey(store.getState());
        store.setState({ researchPersistence: { phase: 'saved' } });
        return;
      }
      researchHydrated = true;
      researchRevision = 0;
      researchLastKey = researchSemanticKey(store.getState());
      store.setState({ researchPersistence: { phase: 'saved' } });
      if (researchLastKey !== startKey) scheduleResearchSave();
    }).catch((error: unknown) => {
      if (isCancelled(error) || token !== researchLoadToken || disposed) return;
      researchLoadCancel = null;
      store.setState({
        researchPersistence: {
          phase: 'error',
          message: `Research state could not be loaded: ${msg(error)}`,
        },
      });
    });
  };

  saveResearchNow = (overwrite = false): void => {
    if (
      !session ||
      disposed ||
      !researchHydrated ||
      researchProject === null
    ) {
      return;
    }
    const expected = overwrite && conflictRevision !== null
      ? conflictRevision
      : researchRevision;
    if (conflictRevision !== null && !overwrite) return;
    clearResearchTimer();
    researchSaveCancel?.();
    const token = ++researchSaveToken;
    const state = researchStateFromApp(store.getState(), expected + 1);
    const issuedKey = researchSemanticKey(store.getState());
    // Publishing the transport-only phase must not look like another durable
    // edit to the store subscriber. Real semantic edits made while the request
    // is in flight still schedule normally and are reconciled on completion.
    researchScheduling = true;
    try {
      store.setState({ researchPersistence: { phase: 'saving' } });
    } finally {
      researchScheduling = false;
    }
    const handle = session.saveResearch(state, expected);
    researchSaveCancel = handle.cancel;
    void handle.result.then((result) => {
      if (disposed || token !== researchSaveToken) return;
      researchSaveCancel = null;
      researchRevision = result.revision;
      conflictRevision = null;
      researchPausedKey = null;
      researchLastKey = issuedKey;
      const liveKey = researchSemanticKey(store.getState());
      if (liveKey === issuedKey) {
        store.setState({ researchPersistence: { phase: 'saved' } });
      } else {
        scheduleResearchSave();
      }
    }).catch((error: unknown) => {
      if (isCancelled(error) || disposed || token !== researchSaveToken) return;
      researchSaveCancel = null;
      if (
        error instanceof UserDataClientError &&
        error.code === 'REVISION_CONFLICT' &&
        error.currentRevision !== undefined
      ) {
        conflictRevision = error.currentRevision;
        store.setState({
          researchPersistence: {
            phase: 'conflict',
            currentRevision: error.currentRevision,
            message: 'Research state was edited in another tab.',
          },
        });
        return;
      }
      researchPausedKey = researchSemanticKey(store.getState());
      store.setState({
        researchPersistence: {
          phase: 'error',
          message: `Research state could not be saved: ${msg(error)}`,
        },
      });
    });
  };

  const unsubscribeResearch = store.subscribe((state) => {
    if (!researchHydrated || state.projectSession?.project.id !== researchProject) {
      return;
    }
    const key = researchSemanticKey(state);
    if (key === researchPausedKey) return;
    if (researchPausedKey !== null) researchPausedKey = null;
    if (key !== researchLastKey) scheduleResearchSave();
  });

  const flushResearch = (): void => {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden' &&
      researchSaveTimer !== null
    ) {
      saveResearchNow(false);
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', flushResearch);
  }

  /** One-way bridge: mirror the session view for the query flow and reissue
   *  queries ONLY when the (generation, snapshot) identity changes (including a
   *  transition to null). It must never issue a session command in response to
   *  a publication — commands originate from bootstrap or UI actions. */
  const acceptSessionState = (next: SessionState) => {
    const prevKey = snapKey(store.getState().snapshot);
    const prevProject = store.getState().projectSession?.project.id ?? null;
    const nextKey = snapKey(next.snapshot);
    // Resolve the focused doc against the incoming snapshot: keep the current
    // one while it stays ready, else the first ready doc in declared order.
    // Snapshot ids are unique per publication, so an unchanged key means the
    // ready set (and thus the focus) is stable — the outline never churns on an
    // unrelated (sources/save) publication.
    const focusedDoc = resolveFocusedDoc(store.getState().focusedDoc, next);
    const keynessView = reconcileKeynessView(
      store.getState().keynessView,
      next.snapshot?.readyDocs ?? [],
    );
    store.setState({
      bootstrap: { phase: 'attached' },
      projectSession: next,
      snapshot: next.snapshot,
      loadingPhase: describeAnalysis(next.analysis),
      loadError: next.analysis.phase === 'error' ? next.analysis.message : null,
      focusedDoc,
      keynessView,
    });
    if (prevProject !== next.project.id) {
      loadResearchForProject(next.project.id);
    }
    if (prevKey !== nextKey) {
      // The on-demand authoring intents are bound to the old snapshot's
      // artifacts — cancel and clear them before the outline reissues.
      editContextLane.supersede();
      lineExcerptLane.supersede();
      readerLane.supersede();
      selectionLane.supersede();
      pinRestoreLane.supersede();
      if (store.getState().editContext !== null || store.getState().lineExcerpt !== null) {
        store.setState({ editContext: null, lineExcerpt: null });
      }
      store.getState().revalidatePins();
      store.getState().runQueries();
      store.getState().runStructure();
      store.getState().runInventory();
      store.getState().runFrequency();
      store.getState().runTfidf();
      store.getState().runKeyness();
      if (researchHydrated && researchProject === next.project.id) {
        restoreDurablePins();
      }
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
      keynessALane.supersede();
      keynessBLane.supersede();
      keynessInventoryALane.supersede();
      keynessInventoryBLane.supersede();
      keynessEvidenceLane.supersede();
      editContextLane.supersede();
      lineExcerptLane.supersede();
      readerLane.supersede();
      const state = store.getState();
      const readerIndex = state.layers.findIndex((layer) => layer.kind === 'reader');
      if (readerIndex >= 0 || state.readerPlace !== null) {
        const layers = readerIndex < 0
          ? state.layers
          : state.layers.slice(0, readerIndex);
        const evidenceTier = evidenceForLayers(layers);
        if (historyPort !== null) {
          historyPort.replace(
            historyStateFor(layers),
            urlWithRoute(historyPort.url, {
              place: state.place,
              evidence: evidenceTier,
            }),
          );
        }
        store.setState({
          layers,
          evidenceTier,
          readerPlace: null,
          readerPage: null,
          readerNavigation: null,
        });
      }
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
      clearResearchTimer();
      researchLoadCancel?.();
      researchSaveCancel?.();
      researchLoadCancel = null;
      researchSaveCancel = null;
      unsubscribeHistory();
      unsubscribeResearch();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', flushResearch);
      }
      unsubscribe?.();
      unsubscribe = null;
      session?.dispose();
      session = null;
    },
  };
}
