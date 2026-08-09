/**
 * The project session controller (commit 7b, per the recorded 7b session-
 * controller ruling `claude_7b_consult`). This is the stateful main-thread
 * policy engine that drives a single current project's whole lifecycle against
 * the worker: generation analysis, cold import assembly, CAS save, source
 * persistence, and reattachment. The pure working-copy model + the ONE
 * generation-spec builder live in `./project.ts`; this module is where nearly
 * all the async ordering policy lives.
 *
 * Deliberate contract choices from the ruling:
 * - The composition root (`store-instance.ts`) constructs exactly ONE session
 *   and wires it as the sole owner of the client's generation event lane —
 *   client callbacks are last-wins, so no second component may ever register
 *   for them.
 * - The session OWNS the entire generation event lane (snapshot / progress /
 *   ingest-error / source-ready / restart / openGeneration / ingest). Worker
 *   restart is part of generation ownership, not display state.
 * - Identity-INCOMPLETE imports are staged in a separate `PendingImport` table,
 *   never materialized as a half-true `ProjectDocV1`. A staged import becomes a
 *   real document only when BOTH facts hold: its correlated `source-ready`
 *   (byte/text/candidate identities) AND membership in a current-generation
 *   `snapshot-published.readyDocs` — joined in either arrival order, with no
 *   terminal ingest error. `source-ready` alone is never ingest completion.
 * - Declared order follows SELECTION order, never async completion order.
 * - A revision-0 manifest is never built or sent (unsaved import = baseRevision
 *   0 working copy); the durable revision is materialized only at first save.
 * - Acknowledgements, not optimistic booleans, establish durable truth. A save
 *   or persist ack lost to worker death is an UNCERTAIN commit reconciled by a
 *   fresh load — never auto-replayed and never auto-overwriting durable data.
 */

import {
  canonicalJson,
  DEFAULT_INDEX_RECIPE,
  DEFAULT_STRUCTURE_RECIPE,
  defaultExtractionRecipes,
  hashExtractionRecipe,
  hashIndexRecipe,
  hashStructureOverride,
  hashStructureRecipe,
  INGEST_CAPS_V0,
  SOURCE_FORMATS,
  SOURCE_FORMAT_IDS,
  sourceFormatForFilename,
  stripSourceExtension,
  type DocumentMetaV1,
  type ExtractionRecipeProvisional,
  type IndexRecipeProvisional,
  type ProjectDocV1,
  type ProjectManifestV1,
  type ResearchStateV1,
  type StructureOverrideV1,
  type StructureRecipeProvisional,
} from '@texttrends/core';
import type {
  GenerationDocSpecV4,
  SourceAvailability,
  SourceFormat,
  WarmMissReasonV4,
} from '../shared/analysis-contract.ts';
import type {
  GenerationReady,
  IngestProgress,
  ProjectLoadResult,
  ResearchLoadResult,
  SnapshotInfo,
  SourceReadyInfo,
} from './client.ts';
import { UserDataClientError } from './client.ts';
import { KeyedLatestOperation, LatestOperation, OperationScope, type OwnedOperationLease } from './operation-lease.ts';
import {
  builtinProject,
  generationSpecsFromProject,
  manifestForSave,
  userProjectFromManifest,
  USER_PROJECT_ID,
  type CurrentProject,
  type ProjectDataV1,
} from './project.ts';

// ────────────────────────────────────────────────────────────────────────────
// Injected seams — narrow by design so 7b is testable with a fake and 7c wires
// the real WorkerClient / fetch / crypto without this module importing them.
// ────────────────────────────────────────────────────────────────────────────

/** The subset of `WorkerClient` the session exclusively owns. Query/excerpt
 *  are request/response and stay with the UI store, so they are absent here. */
export interface ProjectSessionClient {
  onSnapshot(listener: (info: SnapshotInfo) => void): void;
  onProgress(listener: (p: IngestProgress) => void): void;
  onIngestError(listener: (generation: string, message: string, doc?: string) => void): void;
  onSourceReady(listener: (info: SourceReadyInfo) => void): void;
  onRestart(listener: (fatal: boolean) => void): void;
  openGeneration(
    generation: string,
    docs: readonly GenerationDocSpecV4[],
    indexRecipe: IndexRecipeProvisional,
  ): { result: Promise<GenerationReady>; cancel: () => void };
  ingest(generation: string, doc: string, bytes: ArrayBuffer): { job: number };
  projectLoad(project: string): { result: Promise<ProjectLoadResult>; cancel: () => void };
  projectSave(manifest: ProjectManifestV1, expectedRevision: number): { result: Promise<{ revision: number }>; cancel: () => void };
  researchLoad(project: string): { result: Promise<ResearchLoadResult>; cancel: () => void };
  researchSave(state: ResearchStateV1, expectedRevision: number): { result: Promise<{ revision: number }>; cancel: () => void };
  sourcePersist(sourceHash: string, bytes: ArrayBuffer): { result: Promise<void>; cancel: () => void };
}

/** A file handle the session can size, name, and re-read. `File` satisfies it;
 *  tests supply a deterministic fake. The bytes are re-readable so a retained
 *  attachment is both the ingest source AND the persistence/retry source. */
export interface FileLike {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Bundled byte acquisition, kept OUT of the session so the discriminated
 *  availability policy (bundled fetch vs external file vs persisted rehydrate)
 *  stays visible here while URL/fetch details stay injectable. The whole doc is
 *  passed so the provider selects the URL and the session verifies the returned
 *  length against the authoritative descriptor before transfer. */
export interface BundledByteProvider {
  get(doc: ProjectDocV1, signal: AbortSignal): Promise<ArrayBuffer>;
}

export interface ProjectSessionDeps {
  readonly client: ProjectSessionClient;
  readonly bundledBytes: BundledByteProvider;
  /** Prevalidated read-only corpora available to the built-in picker. Optional
   *  in focused fixtures that never switch projects. */
  readonly builtinProjects?: ReadonlyMap<string, ProjectDataV1>;
  /** Stable document id allocator (production: `crypto.randomUUID`). A doc id
   *  is not a filename — it survives rename/reorder/save/reload/reattach. */
  readonly newDocId: () => string;
  /** Main-thread source hashing (production: core `hashSourceBytes`). Injected
   *  so a reattach mismatch is testable without constructing colliding bytes. */
  readonly hashBytes: (bytes: Uint8Array) => Promise<string>;
}

// ────────────────────────────────────────────────────────────────────────────
// Published state — every field serializable. The actual File objects, abort
// controllers, request handles, and promises live in private sidecars.
// ────────────────────────────────────────────────────────────────────────────

/** Per-document source runtime status — observable, File-free (the `File`
 *  itself is private). Canonical `sourceAvailability` lives in the manifest;
 *  this is the transient operation view. */
/** WHY a document's source needs user repair (pass-2 Track S2): durable-source
 *  damage is class-1 USER data needing reattachment — it must never be
 *  flattened into a generic "missing" or reported through the disposable
 *  artifact-cache warning vocabulary. Closed union, derived from the warm-miss
 *  reason + the doc's availability. */
export type SourceRepairReason =
  | 'external-not-attached' // external source: the tab has no File — pick it again
  | 'persisted-missing'     // durable copy expected but absent from storage
  | 'persisted-corrupt'     // durable copy present but damaged (envelope or hash)
  | 'rehydrate-failed';     // durable copy read but re-extraction failed

export type SourceStatus =
  | { readonly phase: 'bundled' }
  | { readonly phase: 'external-attached'; readonly name: string; readonly size: number }
  | { readonly phase: 'external-missing'; readonly repair: SourceRepairReason }
  | { readonly phase: 'persist-saving' }
  | { readonly phase: 'persist-failed'; readonly message: string }
  | { readonly phase: 'persisted' };

/** CAS save state — revision, dirtiness, and operation phase are orthogonal;
 *  `dirty` is derived (`editEpoch !== savedEpoch`) and is NOT part of this. */
export type UserSaveState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'saving'; readonly token: number; readonly payloadEpoch: number; readonly targetRevision: number }
  | { readonly phase: 'conflict'; readonly currentRevision: number }
  | { readonly phase: 'error'; readonly code: string; readonly message: string }
  /** Worker death lost the save ack: the write MAY have committed. Reconciled
   *  by a fresh load on restart — never auto-replayed, never auto-overwriting. */
  | { readonly phase: 'reconcile-required'; readonly targetRevision: number };

export type ImportStatus = 'planned' | 'extracting' | 'failed';

/** The observable view of one staged import (the private `PendingImport` holds
 *  the correlation tokens). */
export interface ImportView {
  readonly doc: string;
  readonly sourceName: string;
  readonly status: ImportStatus;
  readonly published: boolean;
}

/** Why a reattachment did not attach — a content identity mismatch (the ruling's
 *  distinct `REATTACH_SOURCE_MISMATCH`) is separable from a cap or read failure. */
export type ReattachFailureCode = 'REATTACH_SOURCE_MISMATCH' | 'CAP_EXCEEDED' | 'READ_FAILED';

export type ReattachStatus =
  | { readonly phase: 'hashing' }
  | { readonly phase: 'mismatch'; readonly code: ReattachFailureCode; readonly message: string }
  | { readonly phase: 'attached' };

export type AnalysisPhase =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading'; readonly detail: string | null }
  | { readonly phase: 'ready' }
  | { readonly phase: 'error'; readonly message: string; readonly fatal: boolean };

export interface ProjectView {
  readonly kind: 'builtin' | 'user';
  readonly id: string;
  readonly data: ProjectDataV1;
  /** null for the built-in (no CAS state). */
  readonly baseRevision: number | null;
  readonly dirty: boolean;
  readonly save: UserSaveState;
  /** Derived: safe to CAS-save right now (never true for the built-in). */
  readonly saveable: boolean;
}

/** Extraction evidence surfaced from a real `source-ready` event this
 *  generation (§12.4): the decoder-inserted replacement count and the
 *  C0/C1 control count. The DURABLE encoding facts (detected encoding,
 *  hadReplacementChars) live on `project.data.docs[].source` and are always
 *  present; these two counts are only known when the document was actually
 *  (re)extracted this session — a warm text/shard reopen leaves them absent
 *  (unknown, never zero). Reset at each generation start. */
export interface SourceEvidence {
  readonly decoderReplacementCount: number;
  readonly suspiciousControlCount: number;
}

/** The async correction (override authoring) status for a doc (commit 8c). The
 *  override hash is Web-Crypto async, so `setStructureOverride` cannot be a
 *  synchronous mutate-then-reopen like `setLanguage`. Absence means idle; only
 *  in-flight hashing and a rejected attempt are tracked. `stale-base` is a
 *  correction whose base identities no longer match the doc's extraction (the
 *  editor result was superseded by a re-extraction) — never sent to the worker. */
export type CorrectionStatus =
  | { readonly phase: 'hashing' }
  | { readonly phase: 'error'; readonly reason: 'stale-base' | 'invalid'; readonly message: string };

export interface SessionState {
  readonly project: ProjectView;
  readonly analysis: AnalysisPhase;
  readonly snapshot: SnapshotInfo | null;
  readonly imports: readonly ImportView[];
  readonly sources: Readonly<Record<string, SourceStatus>>;
  readonly reattach: Readonly<Record<string, ReattachStatus>>;
  readonly sourceEvidence: Readonly<Record<string, SourceEvidence>>;
  readonly corrections: Readonly<Record<string, CorrectionStatus>>;
}

/** Thrown by public commands used against an illegal origin/state — a
 *  programming error the caller (7c UI) prevents, surfaced loudly in 7b tests.
 *  Async policy failures use state (`save`/`sources`/`reattach`), not throws. */
export class SessionCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionCommandError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Private sidecar shapes.
// ────────────────────────────────────────────────────────────────────────────

/** The recipe VALUES + recomputed hashes an import needs to build both its cold
 *  generation spec and (after extraction) its finalized `ProjectDocV1`. */
interface ImportRecipes {
  readonly extraction: ExtractionRecipeProvisional;
  readonly extractionRecipeHash: string;
  readonly structure: StructureRecipeProvisional;
  readonly structureRecipeHash: string;
}

/** Recipe staging state: `hashing` until `finishStaging` computes the real
 *  values + hashes — only then may this import contribute a cold spec — then
 *  `ready` carrying them. A discriminated union: the unhashed state carries NO
 *  recipe fields at all (the previous placeholder object smuggled an
 *  `undefined as unknown as` cast through the identity boundary). */
type ImportStaging =
  | { readonly phase: 'hashing' }
  | { readonly phase: 'ready'; readonly recipes: ImportRecipes };

/** A staged import: an identity-incomplete document awaiting the two-fact join.
 *  Correlation is by (importToken, generation, doc, ingestJob) — a stale event
 *  never mutates the draft even if its hash happens to match. */
interface PendingImport {
  readonly importToken: number;
  readonly doc: string;
  readonly sourceName: string;
  readonly meta: DocumentMetaV1;
  readonly format: SourceFormat;
  readonly byteLength: number;
  readonly staging: ImportStaging;
  /** The generation currently analyzing this import (reset each reopen). */
  generation: string | null;
  ingestJob: number | null;
  sourceReady: SourceReadyInfo | null;
  published: boolean;
  status: ImportStatus;
}

/** The captured immutable payload of an in-flight save — enough to reconcile an
 *  uncertain commit against a freshly loaded record. */
interface PendingSave {
  readonly token: number;
  readonly payloadEpoch: number;
  readonly expectedRevision: number;
  readonly targetRevision: number;
  readonly manifest: ProjectManifestV1;
}

const CAPS = INGEST_CAPS_V0;

/** A correction's base identities agree with a doc's CURRENT extraction — the
 *  precondition for installing it as `active` (§12.6). Checked both synchronously
 *  and again after the async hash, since a re-extraction can change them. */
function overrideMatchesDoc(override: StructureOverrideV1, doc: ProjectDocV1): boolean {
  return (
    override.text === doc.extraction.text &&
    override.candidates === doc.extraction.candidates &&
    override.baseRecipe === doc.structure.recipeHash
  );
}

/** Default document metadata from a filename: the title is the name minus its
 *  known source extension (via the core format catalog); language/tags take
 *  neutral defaults the user edits in 7c. */
function initialMetaFor(name: string): DocumentMetaV1 {
  return { title: stripSourceExtension(name), language: 'en', tags: [] };
}

/**
 * The single current-project session. Construct one per client lifetime; it
 * installs the exclusive generation-lane callbacks in the constructor. All
 * public commands are synchronous entry points that publish immediately and
 * fence their async continuations by monotonic tokens.
 */
/** The one idle save-state object: identity-comparable across publications
 *  (the built-in project reports it always; user projects return to it). */
const IDLE_SAVE: UserSaveState = { phase: 'idle' };

/** Shallow field equality for the published ProjectView (all seven fields are
 *  primitives or immutably-replaced references). */
function sameProjectView(a: ProjectView, b: ProjectView): boolean {
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.data === b.data &&
    a.baseRevision === b.baseRevision &&
    a.dirty === b.dirty &&
    a.save === b.save &&
    a.saveable === b.saveable
  );
}

function sameImports(prev: readonly ImportView[], next: readonly ImportView[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i += 1) {
    const a = prev[i]!;
    const b = next[i]!;
    if (a.doc !== b.doc || a.sourceName !== b.sourceName || a.status !== b.status || a.published !== b.published) {
      return false;
    }
  }
  return true;
}

/** Reuse the previous record when the map holds identical values for the same
 *  key set: equal size plus every map key matching by identity covers
 *  replacement, deletion, clear, and same-size key swaps (a swapped-in key
 *  is not an own property of the old record and fails the check). Own-key
 *  semantics throughout: document IDs are arbitrary strings (the manifest
 *  validator accepts `__proto__`), so lookups must not walk the prototype and
 *  materialization must define own properties — `Object.fromEntries` does;
 *  a plain `record[key] = value` would invoke the legacy `__proto__` setter
 *  and poison the record's prototype. */
function reuseRecord<T>(
  prev: Readonly<Record<string, T>> | undefined,
  map: ReadonlyMap<string, T>,
): Readonly<Record<string, T>> {
  if (prev !== undefined && Object.keys(prev).length === map.size) {
    let same = true;
    for (const [key, value] of map) {
      if (!Object.hasOwn(prev, key) || !Object.is(prev[key], value)) {
        same = false;
        break;
      }
    }
    if (same) return prev;
  }
  return Object.fromEntries(map) as Record<string, T>;
}

export class ProjectSession {
  private readonly deps: ProjectSessionDeps;
  private readonly listeners = new Set<(state: SessionState) => void>();
  private disposed = false;

  // ── Current project (one, materialized on every mutation). ──
  private id: string;
  private kind: 'builtin' | 'user';
  private indexRecipe: IndexRecipeProvisional;
  private indexRecipeHash: string;
  /** All doc ids — finalized AND still-pending — in DECLARED (selection) order.
   *  `data.order` is this filtered to finalized docs, so async finalization can
   *  never reorder the declared sequence. */
  private order: string[] = [];
  private readonly finalized = new Map<string, ProjectDocV1>();
  private data: ProjectDataV1;

  // ── User CAS state (inert for the built-in). ──
  private baseRevision = 0;
  private editEpoch = 0;
  private savedEpoch = 0;
  private saveState: UserSaveState = IDLE_SAVE;

  /** The last built state: `buildState` reuses every slice whose backing data
   *  is unchanged (semantic shallow reconciliation, Phase B ruling W2), so
   *  zustand's narrow selectors stop firing on unrelated publications — an
   *  ingest's per-phase progress publishes no longer re-render every panel.
   *  Nulled on `installProject` so a replacement project can never reuse a
   *  cached slice. Published objects are never mutated. */
  private lastState: SessionState | null = null;

  // ── Generation lane. ──
  private genAttempt = 0;
  private generation: string | null = null;
  private analysis: AnalysisPhase = { phase: 'idle' };
  private snapshot: SnapshotInfo | null = null;
  private activeOpenCancel: (() => void) | null = null;
  private readonly activeFetches = new Set<AbortController>();

  // ── Import staging. ──
  private importCounter = 0;
  private readonly pending = new Map<string, PendingImport>();
  /** Per-generation extraction evidence by doc (§12.4), captured from
   *  `source-ready`; cleared when a new generation begins. */
  private readonly sourceEvidence = new Map<string, SourceEvidence>();
  /** Per-doc correction status (hashing / rejected). Absence = idle. */
  private readonly corrections = new Map<string, CorrectionStatus>();
  private readonly persistIntent = new Set<string>();

  // ── Source runtime + reattach. ──
  // doc -> the retained File. Attach-staleness is owned by the reattach
  // lease lane; nothing else fences here.
  private readonly attached = new Map<string, FileLike>();
  private readonly sourceStatus = new Map<string, SourceStatus>();
  private readonly reattachStatus = new Map<string, ReattachStatus>();

  // ── Ownership fences. ──
  // ONE scope for project ownership: invalidated on every project replacement
  // (create/load install), closed on dispose. Every lease below dies with it.
  private readonly scope = new OperationScope();
  // Latest-wins lanes (unkeyed): one save in flight wins, one load wins.
  private readonly saveOps = new LatestOperation(this.scope);
  private readonly loadOps = new LatestOperation(this.scope);
  // Latest-wins per document: persist, reattach, and correction-hash attempts
  // supersede only their own doc's prior attempt.
  private readonly persistOps = new KeyedLatestOperation<string>(this.scope);
  private readonly reattachOps = new KeyedLatestOperation<string>(this.scope);
  private readonly correctionOps = new KeyedLatestOperation<string>(this.scope);
  private saveAgain = false;
  private pendingSave: PendingSave | null = null;
  /** Bumped by every user MUTATION command. A load that resolves after the fence
   *  advanced is stale (newer local intent exists) and must not install — WITHOUT
   *  staling in-flight save/persist/reattach continuations (those use their own
   *  lanes/scope), which invalidating the scope would wrongly do. */
  private loadFence = 0;

  constructor(initial: CurrentProject, deps: ProjectSessionDeps) {
    this.deps = deps;
    this.id = initial.data.id;
    this.kind = initial.kind;
    this.indexRecipe = initial.data.indexRecipe;
    this.indexRecipeHash = initial.data.indexRecipeHash;
    this.adoptData(initial.data);
    if (initial.kind === 'user') {
      this.baseRevision = initial.baseRevision;
      this.editEpoch = 0;
      this.savedEpoch = 0;
    }
    this.data = this.materialize();
    deps.client.onSnapshot((info) => this.handleSnapshot(info));
    deps.client.onProgress((p) => this.handleProgress(p));
    deps.client.onIngestError((g, m, d) => this.handleIngestError(g, m, d));
    deps.client.onSourceReady((info) => this.handleSourceReady(info));
    deps.client.onRestart((fatal) => this.handleRestart(fatal));
  }

  // ── Public state surface ──────────────────────────────────────────────────

  getState(): SessionState {
    return this.buildState();
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fence every future async completion and drop subscribers. The underlying
   *  client keeps its last-wins callbacks (7c owns one session per client
   *  lifetime), but every guarded continuation checks `disposed` first. */
  dispose(): void {
    this.disposed = true;
    this.scope.close(); // every outstanding lease (save/load/persist/…) dies
    this.abortFetches();
    this.activeOpenCancel?.();
    this.activeOpenCancel = null;
    this.listeners.clear();
  }

  /** Open the analysis generation for the current project (built-in or loaded
   *  user data). The one entry the app calls at boot and after a nonfatal
   *  restart; import/reorder/reattach reopen it internally. */
  start(): void {
    this.assertLive();
    this.startGeneration();
  }

  /** Switch between prevalidated read-only demo corpora. Deliberately refuses
   *  a user project: a demo click must never discard imported or unsaved work. */
  openBuiltinProject(id: string): void {
    this.assertLive();
    if (this.kind !== 'builtin') {
      throw new SessionCommandError('demo corpora can only be switched while a built-in corpus is open');
    }
    if (id === this.id) return;
    const data = this.deps.builtinProjects?.get(id);
    if (data === undefined) throw new SessionCommandError(`unknown built-in corpus '${id}'`);
    this.installProject(builtinProject(data));
    this.startGeneration();
  }

  /** Research state is independently durable even for the read-only built-in
   *  corpus. These narrow delegates keep worker ownership inside the session
   *  while the analysis store owns semantic autosave policy. */
  loadResearch(): { result: Promise<ResearchLoadResult>; cancel: () => void } {
    this.assertLive();
    return this.deps.client.researchLoad(this.id);
  }

  saveResearch(
    state: ResearchStateV1,
    expectedRevision: number,
  ): { result: Promise<{ revision: number }>; cancel: () => void } {
    this.assertLive();
    if (state.project !== this.id) {
      throw new SessionCommandError('research state targets a different project');
    }
    return this.deps.client.researchSave(state, expectedRevision);
  }

  // ── Commands: import ────────────────────────────────────────────────────────

  /** Create a fresh empty USER project from the BUILT-IN origin and stage the
   *  selected files. Only from the built-in: replacing a known `user/default`
   *  must NOT masquerade as a first create (it would reset the CAS base to 0 and
   *  risk overwriting a durable record). A user project grows via `appendFiles`;
   *  an explicit base-preserving replacement is deferred (D4). */
  createUserProject(files: readonly FileLike[], opts: { persist?: boolean } = {}): void {
    this.assertLive();
    if (this.kind === 'user') {
      throw new SessionCommandError('createUserProject is only from the built-in; use appendFiles to add to a user project');
    }
    // Validate the selection BEFORE destroying the current project — an
    // unsupported/oversized selection must not cost the working copy.
    this.preflightImport(files, /* fromEmpty */ true);
    // A distinct user id per this v1 one-project slot. Replacing the project is
    // a new ownership epoch: every prior generation/import/attachment is moot.
    this.scope.invalidate();
    this.resetToEmptyUser();
    this.stage(files, opts.persist ?? false);
  }

  /** Append the selected files to the current USER project, preserving its
   *  baseRevision, existing docs, and declared order. Rejects the built-in. */
  appendFiles(files: readonly FileLike[], opts: { persist?: boolean } = {}): void {
    this.assertLive();
    if (this.kind !== 'user') throw new SessionCommandError('appendFiles requires a user project; use createUserProject from the built-in');
    this.preflightImport(files, /* fromEmpty */ false);
    this.markUserIntent();
    this.stage(files, opts.persist ?? false);
  }

  /** Drop a staged import (typically a failed one). Reopens the generation
   *  without its provisional cold doc. */
  removeImport(doc: string): void {
    this.assertLive();
    if (!this.pending.has(doc)) return;
    this.markUserIntent();
    this.pending.delete(doc);
    this.persistIntent.delete(doc);
    this.attached.delete(doc);
    this.sourceStatus.delete(doc);
    this.order = this.order.filter((id) => id !== doc); // no phantom document-cap usage
    this.touch();
    this.startGeneration();
  }

  /** Remove a finalized document from the active user corpus. Its reusable
   * browser-library copy (if any) is owned by the acquisition library and is
   * deliberately untouched. */
  removeDocument(doc: string): void {
    this.assertUserCommand('removeDocument');
    if (!this.finalized.has(doc)) return;
    this.persistOps.invalidate(doc);
    this.reattachOps.invalidate(doc);
    this.correctionOps.invalidate(doc);
    this.finalized.delete(doc);
    this.order = this.order.filter((id) => id !== doc);
    this.persistIntent.delete(doc);
    this.attached.delete(doc);
    this.sourceStatus.delete(doc);
    this.reattachStatus.delete(doc);
    this.sourceEvidence.delete(doc);
    this.corrections.delete(doc);
    this.touch();
    this.data = this.materialize();
    this.startGeneration();
  }

  // ── Commands: metadata / order ──────────────────────────────────────────────

  /** Edit descriptive metadata (title/author/year/tags). Dirties the project
   *  but does NOT reopen analysis — these never change tokenization or order. */
  editMeta(doc: string, patch: Partial<Pick<DocumentMetaV1, 'title' | 'author' | 'year' | 'tags'>>): void {
    this.assertUserCommand('editMeta');
    const existing = this.finalized.get(doc);
    if (!existing) throw new SessionCommandError(`editMeta: '${doc}' is not a finalized document`);
    const meta: DocumentMetaV1 = { ...existing.meta, ...patch };
    this.finalized.set(doc, { ...existing, meta });
    this.touch();
    this.data = this.materialize();
    this.publish(); // no generation reopen
  }

  /** Change a document's analysis language. Reopens analysis (language can
   *  change tokenization). */
  setLanguage(doc: string, language: string): void {
    this.assertUserCommand('setLanguage');
    const existing = this.finalized.get(doc);
    if (!existing) throw new SessionCommandError(`setLanguage: '${doc}' is not a finalized document`);
    if (existing.meta.language === language) return;
    this.finalized.set(doc, { ...existing, meta: { ...existing.meta, language } });
    this.touch();
    this.startGeneration(); // reopen: tokenization may change
  }

  /**
   * Author (or clear) a document's chapter-structure correction (commit 8c,
   * ruling §4/§5). The override hash is async Web Crypto, so this cannot be a
   * synchronous mutate-then-reopen like `setLanguage`: a per-doc monotonic
   * token supersedes an earlier attempt, `hashing`/`error` status is published,
   * and ONLY the latest hash completion — after RE-checking the base identities
   * against the THEN-current finalized doc — installs an `active` override and
   * reopens analysis. A null or zero-change override installs `none`
   * synchronously and supersedes any pending hash (the needs-review discard).
   */
  setStructureOverride(doc: string, override: StructureOverrideV1 | null): void {
    this.assertUserCommand('setStructureOverride');
    const existing = this.finalized.get(doc);
    if (!existing) throw new SessionCommandError(`setStructureOverride: '${doc}' is not a finalized document`);
    // Supersede any in-flight hash for this doc. The lease's scope covers
    // project replacement (create/load) during the async hash — a stale hash
    // must never mutate the new project even when the reloaded doc is
    // content-identical.
    this.correctionOps.invalidate(doc);

    // Clear: install `none` (and reopen only if the effective override changes).
    if (override === null || override.changes.length === 0) {
      this.corrections.delete(doc);
      if (existing.structure.override.status !== 'none') {
        this.finalized.set(doc, { ...existing, structure: { ...existing.structure, override: { status: 'none' } } });
        this.touch();
        this.startGeneration();
      } else {
        this.publish(); // nothing to reopen — just drop any hashing/error status
      }
      return;
    }

    // Fast reject a correction not authored against the doc's CURRENT extraction
    // (re-checked authoritatively after the async hash).
    if (!overrideMatchesDoc(override, existing)) {
      this.corrections.set(doc, { phase: 'error', reason: 'stale-base', message: 'this correction is stale — re-open the editor' });
      this.publish();
      return;
    }

    this.corrections.set(doc, { phase: 'hashing' });
    this.publish();

    const lease = this.correctionOps.begin(doc);
    void (async () => {
      let hash: string;
      try {
        hash = await hashStructureOverride(override);
      } catch (e) {
        // A project replacement (scope) OR a newer attempt (lane) invalidates
        // this: never publish an error into a project this attempt no longer owns.
        if (!lease.isCurrent()) return;
        this.corrections.set(doc, { phase: 'error', reason: 'invalid', message: e instanceof Error ? e.message : String(e) });
        this.publish();
        return;
      }
      if (!lease.isCurrent()) return; // superseded mid-hash
      const current = this.finalized.get(doc);
      // Re-check against the THEN-current doc: a re-extraction during the await
      // may have changed identities — a stale result is rejected, not sent.
      if (!current || !overrideMatchesDoc(override, current)) {
        this.corrections.set(doc, { phase: 'error', reason: 'stale-base', message: 'the document changed while saving — re-open the editor' });
        this.publish();
        return;
      }
      this.corrections.delete(doc);
      this.finalized.set(doc, { ...current, structure: { ...current.structure, override: { status: 'active', value: override, hash } } });
      this.touch();
      this.startGeneration();
    })();
  }

  /** Reorder the declared sequence. Reopens analysis (declared-sequence
   *  coordinates change). Requires no in-flight import. */
  reorder(newOrder: readonly string[]): void {
    this.assertUserCommand('reorder');
    if (this.pending.size > 0) throw new SessionCommandError('reorder while an import is in flight');
    const finalizedIds = [...this.order].filter((id) => this.finalized.has(id));
    const isPermutation = newOrder.length === finalizedIds.length && new Set(newOrder).size === newOrder.length && newOrder.every((id) => this.finalized.has(id));
    if (!isPermutation) throw new SessionCommandError('reorder must be a permutation of the finalized documents');
    this.order = [...newOrder];
    this.touch();
    this.startGeneration();
  }

  // ── Commands: save ──────────────────────────────────────────────────────────

  /** CAS-save the current user working copy at baseRevision+1. Idempotent while
   *  in flight (coalesces into one follow-up save if edits advanced). No-op with
   *  a surfaced reason when not saveable. */
  save(): void {
    this.assertUserCommand('save');
    if (this.saveState.phase === 'saving') {
      // One CAS save in flight: remember to re-save from the newly acked base if
      // edits advanced past the captured payload.
      this.saveAgain = true;
      return;
    }
    if (!this.computeSaveable()) {
      throw new SessionCommandError('save called when not saveable (clean, importing, conflict, corrupt, reconcile-required, or persistence in flight)');
    }
    void this.runSave();
  }

  private async runSave(): Promise<void> {
    // The lane fence: a newer save's begin() supersedes this one, and the
    // scope covers project replacement. The lease id doubles as the save's
    // correlation token in saveState/pendingSave (posted-commit detection).
    const lease = this.saveOps.begin();
    const token = lease.id;
    const payloadData = this.data;
    const payloadEpoch = this.editEpoch;
    const expectedRevision = this.baseRevision;
    const targetRevision = expectedRevision + 1;
    // A new attempt: drop any captured payload from a prior terminal attempt.
    // pendingSave is set only just before this attempt actually posts.
    this.pendingSave = null;
    this.saveState = { phase: 'saving', token, payloadEpoch, targetRevision };
    this.publish();

    // Cheap SYNCHRONOUS construction invariants only — the WORKER is the one
    // deep-validation authority at its trust boundary (an invalid manifest
    // comes back as a typed REQUEST_INVALID rejection below). There is no
    // longer a pre-post await, so this attempt posts in the same task as
    // save(); a worker restart can only interrupt it after it was posted.
    let manifest: ProjectManifestV1;
    try {
      manifest = manifestForSave({ kind: 'user', data: payloadData, baseRevision: expectedRevision });
    } catch (e) {
      this.saveAgain = false;
      this.saveState = { phase: 'error', code: 'INVALID', message: msg(e) };
      this.publish();
      return;
    }
    this.pendingSave = { token, payloadEpoch, expectedRevision, targetRevision, manifest };
    const { result } = this.deps.client.projectSave(manifest, expectedRevision);
    try {
      const { revision } = await result;
      if (!lease.isCurrent()) return;
      if (revision !== targetRevision) {
        // The record's own revision is the sole authority; a save ack that is
        // not exactly the target is an invariant fault, not a success.
        this.pendingSave = null;
        this.saveAgain = false;
        this.saveState = { phase: 'error', code: 'INVARIANT', message: `save acked revision ${revision}, expected ${targetRevision}` };
        this.publish();
        return;
      }
      this.applySaved(targetRevision, payloadEpoch, manifest);
    } catch (e) {
      if (!lease.isCurrent()) return;
      this.saveAgain = false; // a coalesced request cannot survive a terminal failure
      if (e instanceof UserDataClientError) {
        if (e.code === 'REVISION_CONFLICT') {
          // Retain the draft + files; do NOT adopt currentRevision as the base
          // without loading and validating that revision. This attempt is
          // terminal — clear its captured payload.
          this.pendingSave = null;
          this.saveState = { phase: 'conflict', currentRevision: e.currentRevision ?? expectedRevision };
        } else {
          // DATA_CORRUPT never auto-overwrites; quota/persistence retains the
          // dirty draft with a retry affordance. Both surface as retryable error.
          this.pendingSave = null;
          this.saveState = { phase: 'error', code: e.code, message: e.message };
        }
      } else {
        // A generic rejection HERE is provably pre-delivery — a genuinely
        // uncertain worker-death rejection arrives WITH a restart, whose
        // save-lane invalidation makes this continuation stale (returns above) and is
        // reconciled in handleRestart. So this is retryable, not uncertain.
        this.pendingSave = null;
        this.saveState = { phase: 'error', code: 'SAVE_FAILED', message: msg(e) };
      }
      this.publish();
    }
  }

  private applySaved(targetRevision: number, payloadEpoch: number, acked: ProjectManifestV1): void {
    this.baseRevision = targetRevision;
    this.savedEpoch = payloadEpoch; // edits during the flight leave editEpoch > this ⇒ still dirty
    this.saveState = IDLE_SAVE;
    this.pendingSave = null;
    // File-retention boundary: release a doc's File only when the JUST-ACKED
    // manifest records it `persisted` AND its durable write is CONFIRMED present
    // (runtime status `persisted`). A doc that flipped to persisted after this
    // payload was captured, or whose repair FAILED (`persist-failed`) so the
    // durable source is still missing, keeps its File — the only recovery source
    // (D6 recovery gap). External files stay retained for the tab.
    for (const d of acked.docs) {
      if (d.sourceAvailability === 'persisted' && this.sourceStatus.get(d.doc)?.phase === 'persisted') this.attached.delete(d.doc);
    }
    // Coalesced follow-up save, only if edits genuinely advanced.
    const wantAgain = this.saveAgain && this.editEpoch !== this.savedEpoch;
    this.saveAgain = false;
    this.publish();
    if (wantAgain && this.computeSaveable()) void this.runSave();
  }

  // ── Commands: persistence ───────────────────────────────────────────────────

  /** Mark/unmark a finalized external document for durable source persistence.
   *  Marking a ready external doc kicks off the strict persist ordering. */
  setPersistIntent(doc: string, intent: boolean): void {
    this.assertUserCommand('setPersistIntent');
    if (!this.finalized.has(doc)) throw new SessionCommandError(`setPersistIntent: '${doc}' is not a finalized document`);
    if (!intent) {
      this.persistIntent.delete(doc);
      // Retire any in-flight persist so its late ack cannot flip availability or
      // dirty the project (acceptance invariant 2).
      this.persistOps.invalidate(doc);
      const s = this.sourceStatus.get(doc);
      if (s?.phase === 'persist-saving') {
        this.sourceStatus.set(doc, this.attached.has(doc) ? { phase: 'external-attached', name: this.finalized.get(doc)!.sourceName, size: this.attached.get(doc)!.size } : { phase: 'external-missing', repair: 'external-not-attached' });
        this.publish();
      }
      return;
    }
    this.persistIntent.add(doc);
    const d = this.finalized.get(doc)!;
    if (d.sourceAvailability === 'external' && this.attached.has(doc)) void this.startPersist(doc);
  }

  private async startPersist(doc: string): Promise<void> {
    const attachment = this.attached.get(doc);
    const source = this.finalized.get(doc);
    if (!attachment || !source) return;
    const lease = this.persistOps.begin(doc);
    this.sourceStatus.set(doc, { phase: 'persist-saving' });
    this.publish();
    let bytes: ArrayBuffer;
    try {
      bytes = await attachment.arrayBuffer(); // reread — ingest transferred its buffer
    } catch (e) {
      if (!lease.isCurrent()) return;
      this.sourceStatus.set(doc, { phase: 'persist-failed', message: msg(e) });
      this.publish();
      return;
    }
    if (!lease.isCurrent()) return;
    const { result } = this.deps.client.sourcePersist(source.source.hash, bytes);
    try {
      await result;
      if (!lease.isCurrent()) return;
      // Flip canonical availability external → persisted, dirtying the project,
      // so a subsequent CAS save records the durable reference.
      const current = this.finalized.get(doc);
      if (current && current.sourceAvailability === 'external') {
        this.finalized.set(doc, { ...current, sourceAvailability: 'persisted' });
        this.data = this.materialize();
        this.touch();
      }
      this.sourceStatus.set(doc, { phase: 'persisted' });
      this.publish();
    } catch (e) {
      if (!lease.isCurrent()) return;
      // Availability stays external; the File stays retained for an idempotent,
      // content-addressed retry.
      this.sourceStatus.set(doc, { phase: 'persist-failed', message: msg(e) });
      this.publish();
    }
  }

  // ── Commands: reattachment ──────────────────────────────────────────────────

  /** Reattach an external (or repair a missing/corrupt persisted) source by
   *  hashing on the main thread first and ingesting ONLY on a SourceHash match.
   *  A mismatch is a distinct `REATTACH_SOURCE_MISMATCH` — the bytes are never
   *  sent. Preserves the canonical `sourceName`. */
  reattach(doc: string, file: FileLike): void {
    this.assertUserCommand('reattach');
    const source = this.finalized.get(doc);
    if (!source) throw new SessionCommandError(`reattach: '${doc}' is not a finalized document`);
    if (source.sourceAvailability === 'bundled') throw new SessionCommandError('reattach: a bundled source is fetched from its URL, never reattached');
    // Supersede any prior in-flight digest FIRST — even an early rejection must
    // stale it so its late completion cannot attach a stale File.
    this.reattachOps.invalidate(doc);
    // Cheap early rejections before any read: the cap, and — since SourceHash is
    // over the exact bytes — a byte length that cannot possibly match.
    if (file.size > CAPS.maxSourceBytesPerFile) {
      this.reattachStatus.set(doc, { phase: 'mismatch', code: 'CAP_EXCEEDED', message: `file exceeds ${CAPS.maxSourceBytesPerFile}-byte cap` });
      this.publish();
      return;
    }
    if (file.size !== source.source.byteLength) {
      this.reattachStatus.set(doc, { phase: 'mismatch', code: 'REATTACH_SOURCE_MISMATCH', message: 'selected file content does not match this document' });
      this.publish();
      return;
    }
    void this.runReattach(doc, file, source, this.reattachOps.begin(doc));
  }

  private async runReattach(doc: string, file: FileLike, source: ProjectDocV1, lease: OwnedOperationLease): Promise<void> {
    this.reattachStatus.set(doc, { phase: 'hashing' });
    this.publish();
    let buffer: ArrayBuffer;
    let hash: string;
    try {
      buffer = await file.arrayBuffer();
      if (!lease.isCurrent()) return;
      hash = await this.deps.hashBytes(new Uint8Array(buffer));
    } catch (e) {
      if (!lease.isCurrent()) return;
      this.reattachStatus.set(doc, { phase: 'mismatch', code: 'READ_FAILED', message: msg(e) });
      this.publish();
      return;
    }
    if (!lease.isCurrent()) return;
    if (hash !== source.source.hash) {
      // Never send the bad bytes; the worker's SOURCE_MISMATCH stays as
      // defense in depth for anything that slips past.
      this.reattachStatus.set(doc, { phase: 'mismatch', code: 'REATTACH_SOURCE_MISMATCH', message: 'selected file content does not match this document' });
      this.publish();
      return;
    }
    // Match: attach for the tab, ingest into the current generation with the
    // stable doc id + expected identities. Attaching an identical source does
    // NOT dirty (the manifest is unchanged).
    this.attached.set(doc, file);
    this.sourceStatus.set(doc, source.sourceAvailability === 'persisted' ? { phase: 'persisted' } : { phase: 'external-attached', name: source.sourceName, size: file.size });
    this.reattachStatus.set(doc, { phase: 'attached' });
    if (this.generation) this.deps.client.ingest(this.generation, doc, buffer);
    this.publish();
    // Post-reattach persistence, reading the freshly retained File:
    // - a `persisted` source whose durable record was missing/corrupt is REPAIRED
    //   (content-addressed, availability unchanged, no dirty);
    // - an `external` source the user opted to persist follows the persist
    //   ordering (which flips availability to persisted and dirties).
    if (source.sourceAvailability === 'persisted' || this.persistIntent.has(doc)) void this.startPersist(doc);
  }

  // ── Commands: load ──────────────────────────────────────────────────────────

  /** Load the durable user project, deep-validate it, install it as the current
   *  project, and reopen analysis. A late/corrupt result cannot replace a newer
   *  current project and is never auto-saved. */
  loadUserProject(): void {
    this.assertLive();
    void this.runLoad();
  }

  private async runLoad(): Promise<void> {
    // Do NOT invalidate the ownership scope until a validated install: a load
    // is a read. Superseding current-project ownership up front would silently
    // strand an in-flight save/persist/reattach if the load then fails or the
    // record is missing/corrupt. The scope advances only inside installProject.
    const lease = this.loadOps.begin();
    // Capture the intent fence, the CAS base, AND whether a save was already
    // active. A valid load must NOT clobber newer local intent (append/edit/
    // reorder/persist/reattach/save issued while it validated), regress over a
    // save that ACKNOWLEDGED during the load (base advances without touching
    // loadFence), OR install over a save that was in flight at load start
    // whatever its terminal outcome (success advances base, but conflict/error
    // leave it unchanged and unblock the phase — D5 must retain that draft).
    const fence = this.loadFence;
    const baseAtStart = this.baseRevision;
    const saveActiveAtStart = this.saveState.phase === 'saving' || this.saveState.phase === 'reconcile-required';
    const { result } = this.deps.client.projectLoad(USER_PROJECT_ID);
    let loaded: ProjectLoadResult;
    try {
      loaded = await result;
    } catch (e) {
      if (!lease.isCurrent()) return;
      // The worker is the sole durable-admission authority (it upgrades + deep
      // validates before emitting): a corrupt record arrives as a typed
      // DATA_CORRUPT rejection, never as a value to re-validate here.
      this.analysis =
        e instanceof UserDataClientError && e.code === 'DATA_CORRUPT'
          ? { phase: 'error', message: `the saved project is corrupt: ${msg(e)}`, fatal: false }
          : { phase: 'error', message: 'failed to load the durable project', fatal: false };
      this.publish();
      return;
    }
    if (!lease.isCurrent()) return;
    if (loaded.kind === 'missing') {
      this.analysis = { phase: 'error', message: 'no saved project', fatal: false };
      this.publish();
      return;
    }
    const manifest: ProjectManifestV1 = loaded.manifest;
    // A valid load must yield to newer local intent, an in-flight save, OR a save
    // that acknowledged during the load — rather than silently discard the newer
    // draft or make a save acknowledgement unobservable.
    if (
      this.loadFence !== fence ||
      this.baseRevision !== baseAtStart ||
      saveActiveAtStart ||
      this.saveState.phase === 'saving' ||
      this.saveState.phase === 'reconcile-required'
    ) {
      this.analysis = { phase: 'error', message: 'load superseded by newer local changes', fatal: false };
      this.publish();
      return;
    }
    this.installProject(userProjectFromManifest(manifest));
    this.startGeneration();
  }

  // ── Generation lane ─────────────────────────────────────────────────────────

  private startGeneration(): void {
    // Supersede the prior attempt: abort its bundled fetches, cancel a pending
    // open. Ingest has no cancel handle — a newer begin-generation is its fence.
    this.abortFetches();
    this.activeOpenCancel?.();
    this.activeOpenCancel = null;
    const attempt = ++this.genAttempt;
    const generation = `${this.id}#gen-${attempt}`;
    this.generation = generation;
    // Reflect any doc/order/language mutation that led here before deriving
    // specs and publishing (setLanguage/reorder/removeImport mutate in place).
    this.data = this.materialize();
    // Re-correlate every still-pending import to this new generation: it will be
    // re-ingested and must re-satisfy the two-fact join in THIS generation.
    for (const [doc, p] of this.pending) {
      this.pending.set(doc, { ...p, generation, ingestJob: null, sourceReady: null, published: false, status: p.status === 'failed' ? 'planned' : p.status });
    }
    this.snapshot = null;
    this.analysis = { phase: 'loading', detail: null };
    // Evidence is per-generation: a doc not re-extracted this generation (warm
    // text/shard reopen) has unknown counts, never carried-over stale ones.
    this.sourceEvidence.clear();
    this.publish();

    // Compose specs in DECLARED (`this.order`) sequence — the canonical builder
    // for identity-complete docs, the cold helper for pre-identity imports —
    // never finalized-then-pending, so a partially-finalized batch keeps
    // selection order across a restart's reopen (an out-of-order finalization
    // must not permute the generation's composition order).
    const finalizedSpecs = new Map(generationSpecsFromProject(this.data).map((s) => [s.doc, s] as const));
    const specs: GenerationDocSpecV4[] = [];
    for (const id of this.order) {
      const done = finalizedSpecs.get(id);
      if (done) {
        specs.push(done);
        continue;
      }
      // Only imports whose recipe hashes are computed contribute a cold spec; a
      // still-staging import is picked up when `finishStaging` reopens.
      const p = this.pending.get(id);
      if (p?.staging.phase === 'ready') specs.push(this.coldSpec(p, p.staging.recipes));
    }
    const { result, cancel } = this.deps.client.openGeneration(generation, specs, this.indexRecipe);
    this.activeOpenCancel = cancel;
    result
      .then((ready) => {
        if (this.disposed || attempt !== this.genAttempt) return;
        this.activeOpenCancel = null;
        for (const miss of ready.missing) void this.resolveMiss(generation, attempt, miss.doc, miss.reason);
      })
      .catch((e: unknown) => {
        if (this.disposed || attempt !== this.genAttempt) return;
        this.activeOpenCancel = null;
        this.analysis = { phase: 'error', message: `failed to open the generation: ${msg(e)}`, fatal: false };
        this.publish();
      });
  }

  /** The cold spec for an identity-incomplete staged import: recipe values +
   *  hashes, availability external, and NO expected source/text/candidate
   *  identities (a genuine miss the worker cold-ingests). */
  private coldSpec(p: PendingImport, recipes: ImportRecipes): GenerationDocSpecV4 {
    return {
      doc: p.doc,
      language: p.meta.language,
      source: { byteLength: p.byteLength, format: p.format, availability: 'external' },
      extraction: { recipe: recipes.extraction, recipeHash: recipes.extractionRecipeHash },
      structure: { recipe: recipes.structure, recipeHash: recipes.structureRecipeHash, override: { kind: 'none' } },
    };
  }

  /** Map a warm-miss reason + the doc's availability to the closed repair
   *  vocabulary the UI renders. An external doc always needs its file back;
   *  a persisted doc distinguishes absent / damaged / unre-extractable. */
  private static repairReasonFor(availability: SourceAvailability, reason: WarmMissReasonV4): SourceRepairReason {
    if (availability !== 'persisted') return 'external-not-attached';
    switch (reason) {
      case 'source-miss':
      case 'source-not-persisted':
        return 'persisted-missing';
      case 'source-corrupt':
        return 'persisted-corrupt';
      default:
        return 'rehydrate-failed';
    }
  }

  private async resolveMiss(generation: string, attempt: number, doc: string, reason: WarmMissReasonV4): Promise<void> {
    if (this.disposed || attempt !== this.genAttempt || generation !== this.generation) return;
    const pending = this.pending.get(doc);
    if (pending) {
      // A staged import always has its attached File.
      await this.ingestAttached(generation, attempt, doc, (job) => {
        const p = this.pending.get(doc);
        if (p) this.pending.set(doc, { ...p, ingestJob: job, status: 'extracting' });
      });
      return;
    }
    const finalizedDoc = this.finalized.get(doc);
    if (!finalizedDoc) return; // not a doc this generation declared
    switch (finalizedDoc.sourceAvailability) {
      case 'bundled': {
        const controller = new AbortController();
        this.activeFetches.add(controller);
        try {
          const bytes = await this.deps.bundledBytes.get(finalizedDoc, controller.signal);
          if (this.disposed || attempt !== this.genAttempt) return;
          if (bytes.byteLength !== finalizedDoc.source.byteLength) {
            throw new Error(`expected ${finalizedDoc.source.byteLength} bytes, received ${bytes.byteLength}`);
          }
          this.deps.client.ingest(generation, doc, bytes);
        } catch (e) {
          if (this.disposed || attempt !== this.genAttempt || controller.signal.aborted) return;
          this.analysis = { phase: 'error', message: `failed to fetch '${doc}': ${msg(e)}`, fatal: false };
          this.publish();
        } finally {
          this.activeFetches.delete(controller);
        }
        return;
      }
      case 'external':
      case 'persisted': {
        // A persisted miss means durable rehydration failed: it needs the same
        // matching-file repair path as an external miss.
        if (this.attached.has(doc)) {
          await this.ingestAttached(generation, attempt, doc);
        } else {
          this.sourceStatus.set(doc, {
            phase: 'external-missing',
            repair: ProjectSession.repairReasonFor(finalizedDoc.sourceAvailability, reason),
          });
          this.publish();
        }
        return;
      }
    }
  }

  private async ingestAttached(generation: string, attempt: number, doc: string, onJob?: (job: number) => void): Promise<void> {
    const attachment = this.attached.get(doc);
    if (!attachment) return;
    let bytes: ArrayBuffer;
    try {
      bytes = await attachment.arrayBuffer();
    } catch (e) {
      if (this.disposed || attempt !== this.genAttempt) return;
      this.sourceStatus.set(doc, { phase: 'external-missing', repair: 'external-not-attached' });
      this.analysis = { phase: 'error', message: `failed to read '${doc}': ${msg(e)}`, fatal: false };
      this.publish();
      return;
    }
    if (this.disposed || attempt !== this.genAttempt || generation !== this.generation) return;
    const { job } = this.deps.client.ingest(generation, doc, bytes);
    onJob?.(job);
  }

  private handleSnapshot(info: SnapshotInfo): void {
    if (this.disposed || info.generation !== this.generation) return; // superseded generation
    this.snapshot = info;
    this.analysis = { phase: 'ready' };
    const ready = new Set(info.readyDocs);
    for (const [doc, p] of this.pending) {
      if (!p.published && ready.has(doc)) {
        this.pending.set(doc, { ...p, published: true });
        this.tryFinalize(doc);
      }
    }
    this.publish();
  }

  private handleProgress(p: IngestProgress): void {
    if (this.disposed || p.generation !== this.generation) return; // superseded generation
    if (this.analysis.phase === 'loading') {
      this.analysis = { phase: 'loading', detail: `${p.phase}: ${p.doc.slice(0, 40)}` };
      this.publish();
    }
  }

  private handleSourceReady(info: SourceReadyInfo): void {
    if (this.disposed || info.generation !== this.generation) return;
    // Capture extraction evidence for ANY doc extracted this generation —
    // finalized docs included, whose re-extraction is not an import to assemble.
    this.sourceEvidence.set(info.doc, {
      decoderReplacementCount: info.decoderReplacementCount,
      suspiciousControlCount: info.suspiciousControlCount,
    });
    const p = this.pending.get(info.doc);
    if (!p) {
      this.publish(); // a finalized doc's re-extraction — surface its evidence
      return;
    }
    if (p.generation !== info.generation || p.ingestJob !== info.job) return; // stale (same-doc retry / prior generation)
    this.pending.set(info.doc, { ...p, sourceReady: info });
    this.tryFinalize(info.doc);
    this.publish();
  }

  /** Finalize a staged import once BOTH facts hold — correlated `source-ready`
   *  AND current-generation publication — with no terminal error. Inserts the
   *  new document at its SELECTION position (declared order, not completion). */
  private tryFinalize(doc: string): void {
    const p = this.pending.get(doc);
    if (!p || !p.sourceReady || !p.published || p.status === 'failed') return;
    // Both facts require a generation that carried this import's cold spec,
    // which only a `ready` staging can contribute — now type-enforced.
    if (p.staging.phase !== 'ready') return;
    const { recipes } = p.staging;
    const info = p.sourceReady;
    const finalizedDoc: ProjectDocV1 = {
      doc: p.doc,
      sourceName: p.sourceName,
      meta: p.meta,
      source: info.source,
      sourceAvailability: 'external',
      extraction: {
        recipe: recipes.extraction,
        recipeHash: info.extractionRecipeHash,
        text: info.text,
        textLengthUtf16: info.textLengthUtf16,
        candidates: info.candidates,
      },
      structure: { recipe: recipes.structure, recipeHash: recipes.structureRecipeHash, override: { status: 'none' } },
    };
    this.pending.delete(doc);
    this.finalized.set(doc, finalizedDoc); // `order` already carries `doc` at its selection position
    this.sourceStatus.set(doc, { phase: 'external-attached', name: p.sourceName, size: info.source.byteLength });
    this.touch();
    this.data = this.materialize();
    // Kick off persistence if the user opted in for this source.
    if (this.persistIntent.has(doc)) void this.startPersist(doc);
  }

  private handleIngestError(generation: string, message: string, doc?: string): void {
    if (this.disposed || generation !== this.generation) return;
    if (doc && this.pending.has(doc)) {
      const p = this.pending.get(doc)!;
      this.pending.set(doc, { ...p, status: 'failed' }); // stays unsaveable until removed/retried
      this.publish();
      return;
    }
    // A finalized doc's analysis failed: a retryable analysis error.
    this.analysis = { phase: 'error', message, fatal: false };
    this.publish();
  }

  private handleRestart(fatal: boolean): void {
    if (this.disposed) return;
    this.snapshot = null;
    this.abortFetches();
    this.activeOpenCancel = null;
    // A save in flight when the worker died must have its continuation fenced:
    // invalidate the save lane so the awaiting ack continuation goes stale and
    // cannot settle behind our back. runSave posts SYNCHRONOUSLY with save()
    // (the worker is the validation authority — there is no pre-post await),
    // so a live `saving` phase means the write reached the worker and its
    // outcome is UNCERTAIN: reconcile by load, never guess. The not-posted arm
    // below is pure defense for the zero-width window between saveState
    // assignment and the post (e.g. a synchronous manifestForSave throw path).
    if (this.kind === 'user' && this.saveState.phase === 'saving') {
      const posted = this.pendingSave !== null && this.pendingSave.token === this.saveState.token;
      this.saveOps.invalidate();
      if (posted) {
        this.saveState = { phase: 'reconcile-required', targetRevision: this.pendingSave!.targetRevision };
      } else {
        // Defensive only (see above): abandon cleanly — a stale saveAgain must
        // not auto-fire an unrequested save after a later retry acknowledges.
        this.pendingSave = null;
        this.saveAgain = false;
        this.saveState = { phase: 'error', code: 'WORKER_RESTARTED', message: 'the save did not reach the worker; retry' };
      }
    }
    if (fatal) {
      this.analysis = { phase: 'error', message: 'the analysis worker crashed repeatedly; reload to retry', fatal: true };
      this.publish();
      return; // working copy, files, and pending imports are retained
    }
    // Nonfatal: a replacement worker is live. Reconcile an uncertain save first
    // (load truth before any replay), then reopen analysis from current intent +
    // retained attachments.
    if (this.kind === 'user' && this.saveState.phase === 'reconcile-required') {
      void this.reconcileSave();
    }
    this.startGeneration();
  }

  /** Reconcile an uncertain CAS commit after worker death: load the durable
   *  record, deep-validate it, and adopt the revision ONLY if it is exactly the
   *  captured target manifest. Otherwise surface conflict — never overwrite. */
  private async reconcileSave(): Promise<void> {
    const target = this.pendingSave;
    if (!target) {
      this.saveState = IDLE_SAVE;
      this.publish();
      return;
    }
    // Scope-only fence: reconcile is not a latest-wins lane (the save lane was
    // already invalidated by the restart) — only project replacement/disposal
    // may stale it, plus the explicit reconcile-required phase checks below.
    const scopeLease = this.scope.lease();
    const { result } = this.deps.client.projectLoad(this.id);
    let loaded: ProjectLoadResult;
    try {
      loaded = await result;
    } catch (e) {
      if (!scopeLease.isCurrent()) return;
      this.saveAgain = false; // a lost coalesced request must not auto-fire later
      // A DATA_CORRUPT rejection is the worker's admission verdict on the
      // durable record itself (the former second validation pass here).
      this.saveState =
        e instanceof UserDataClientError && e.code === 'DATA_CORRUPT'
          ? { phase: 'error', code: 'DATA_CORRUPT', message: 'the durable record is corrupt' }
          : { phase: 'error', code: 'RECONCILE_FAILED', message: 'could not load the project to reconcile the save' };
      this.publish();
      return;
    }
    if (!scopeLease.isCurrent() || this.saveState.phase !== 'reconcile-required') return;
    if (loaded.kind === 'loaded') {
      // Worker-validated already — reconcile compares the durable truth to the
      // captured target; no second validation pass on the main thread.
      const manifest = loaded.manifest;
      if (manifest.revision === target.targetRevision && canonicalJson(manifest) === canonicalJson(target.manifest)) {
        // Our write DID commit before the crash: adopt it through the ONE
        // completion path so File retention + any coalesced follow-up save are
        // handled exactly as a normal ack.
        this.applySaved(target.targetRevision, target.payloadEpoch, target.manifest);
        return;
      }
      // Any other durable outcome is non-overwriting conflict/rebase.
      this.saveAgain = false;
      this.saveState = { phase: 'conflict', currentRevision: manifest.revision };
      this.publish();
      return;
    }
    // The record is absent: our save did not commit. Surface a retryable error
    // (NOT a silent success) — base is unchanged, so a retry targets the same
    // revision — and drop the stale coalesced request.
    this.saveAgain = false;
    this.saveState = { phase: 'error', code: 'SAVE_UNCOMMITTED', message: 'the save did not commit; retry' };
    this.pendingSave = null;
    this.publish();
  }

  // ── Staging internals ───────────────────────────────────────────────────────

  /**
   * Whole-PROJECT caps preflight — PURE (no reads, opens, id allocation, or
   * mutation): a violation throws so the caller aborts before any side effect.
   * The RESULTING project is what is bounded: existing finalized docs AND
   * already-pending imports count toward every cap (a second append before the
   * first finalizes must not slip past). This is a BEST-EFFORT early guard, not
   * the final authority: a pending import has no decoded length yet, so its
   * `byteLength` stands in for its text. That is exact for txt/md/html but an
   * UNDERESTIMATE for a compressed epub (decompression can exceed the archive),
   * so the worker re-enforces the real text caps on ACTUAL decoded lengths at
   * ingest (an over-large doc becomes a normal CAP_EXCEEDED missing doc).
   */
  private preflightImport(files: readonly FileLike[], fromEmpty: boolean): void {
    if (files.length === 0) return;
    const existingDocs = fromEmpty ? 0 : this.order.length; // finalized + pending
    if (existingDocs + files.length > CAPS.maxDocsPerProject) {
      throw new SessionCommandError(`import would exceed ${CAPS.maxDocsPerProject} documents`);
    }
    let existingBytes = 0;
    let existingText = 0;
    if (!fromEmpty) {
      for (const d of this.finalized.values()) {
        existingBytes += d.source.byteLength;
        existingText += d.extraction.textLengthUtf16;
      }
      for (const p of this.pending.values()) {
        existingBytes += p.byteLength;
        // No decoded length yet — byteLength is a proxy (exact for txt/md/html,
        // an underestimate for a compressed epub; the worker is authoritative).
        existingText += p.byteLength;
      }
    }
    let newBytes = 0;
    for (const f of files) {
      const format = sourceFormatForFilename(f.name);
      if (format === null) {
        const supported = SOURCE_FORMAT_IDS.flatMap((id) => SOURCE_FORMATS[id].extensions).join(', ');
        throw new SessionCommandError(`unsupported file type: '${f.name}' (${supported})`);
      }
      if (f.size > CAPS.maxSourceBytesPerFile) throw new SessionCommandError(`'${f.name}' exceeds the ${CAPS.maxSourceBytesPerFile}-byte per-file cap`);
      newBytes += f.size;
    }
    if (existingBytes + newBytes > CAPS.maxProjectSourceBytes) throw new SessionCommandError('import would exceed the project source-byte cap');
    if (existingText + newBytes > CAPS.maxProjectTextUtf16) throw new SessionCommandError('import would exceed the project text cap');
  }

  /** Apply a preflighted selection: allocate stable ids and stage each file. The
   *  caller has already run `preflightImport`, so this performs no cap checks. */
  private stage(files: readonly FileLike[], persist: boolean): void {
    if (files.length === 0) return;
    // Allocate ids + tokens up front so each plan CARRIES its own importToken
    // (never reconstructed from `this.pending`, which a duplicate id would
    // corrupt). A collision from the injected allocator is a hard programming
    // error, not a silent overwrite of a live entry.
    const plans = files.map((file) => ({
      doc: this.deps.newDocId(),
      file,
      format: sourceFormatForFilename(file.name)!,
      importToken: ++this.importCounter,
    }));
    const ids = new Set(plans.map((p) => p.doc));
    if (ids.size !== plans.length || plans.some((p) => this.order.includes(p.doc))) {
      throw new SessionCommandError('newDocId returned a duplicate document id');
    }
    for (const { doc, file, format, importToken } of plans) {
      this.order.push(doc);
      this.attached.set(doc, file);
      this.sourceStatus.set(doc, { phase: 'external-attached', name: file.name, size: file.size });
      if (persist) this.persistIntent.add(doc);
      this.pending.set(doc, {
        importToken,
        doc,
        sourceName: file.name,
        meta: initialMetaFor(file.name),
        format,
        byteLength: file.size,
        staging: { phase: 'hashing' },
        generation: null,
        ingestJob: null,
        sourceReady: null,
        published: false,
        status: 'planned',
      });
    }
    this.touch();
    this.publish();
    // Carry each staged import's (doc, importToken) so the async recipe step only
    // updates the SAME pending entry it staged — never a later reuse of that id.
    void this.finishStaging(plans.map((p) => ({ doc: p.doc, importToken: p.importToken })));
  }

  /** Compute recipe hashes (async, memoized in core) then open the generation.
   *  Fenced by the session epoch (project replacement) AND per-entry importToken
   *  (a re-staged id) so stale staging work never mutates a newer pending entry. */
  private async finishStaging(staged: readonly { doc: string; importToken: number }[]): Promise<void> {
    const scopeLease = this.scope.lease();
    // One default recipe per catalog format — select `byFormat[format]`, no
    // per-format switch. Hash every catalog format (derived from
    // SOURCE_FORMAT_IDS so a new format needs no edit here) plus structure/index
    // in parallel.
    const byFormat = await defaultExtractionRecipes();
    const [structureHash, indexHash, formatHashes] = await Promise.all([
      hashStructureRecipe(DEFAULT_STRUCTURE_RECIPE),
      hashIndexRecipe(this.indexRecipe),
      Promise.all(SOURCE_FORMAT_IDS.map((f) => hashExtractionRecipe(byFormat[f]))),
    ]);
    if (!scopeLease.isCurrent()) return;
    const hashByFormat = Object.fromEntries(
      SOURCE_FORMAT_IDS.map((f, i) => [f, formatHashes[i]!]),
    ) as { readonly [F in SourceFormat]: string };
    let matched = 0;
    for (const { doc, importToken } of staged) {
      const p = this.pending.get(doc);
      if (!p || p.importToken !== importToken) continue; // a newer entry / removed
      const chosen = { recipe: byFormat[p.format], hash: hashByFormat[p.format] };
      const recipes: ImportRecipes = {
        extraction: chosen.recipe,
        extractionRecipeHash: chosen.hash,
        structure: DEFAULT_STRUCTURE_RECIPE,
        structureRecipeHash: structureHash,
      };
      this.pending.set(doc, { ...p, staging: { phase: 'ready', recipes } });
      matched++;
    }
    // If every staged import was removed/superseded meanwhile, this stale
    // continuation must NOT reopen the generation or mutate current data.
    if (matched === 0) return;
    // Keep the index recipe hash consistent with the (possibly reset-to-default)
    // recipe so a first save materializes a valid manifest.
    this.indexRecipeHash = indexHash;
    this.data = this.materialize();
    this.startGeneration();
  }

  // ── State materialization + publishing ──────────────────────────────────────

  /** Rebuild the private project index (order + finalized map) from a
   *  ProjectData snapshot — used on construct, install, and empty-reset. */
  private adoptData(data: ProjectDataV1): void {
    this.finalized.clear();
    for (const d of data.docs) this.finalized.set(d.doc, d);
    this.order = [...data.order];
  }

  /** Synchronously retire the CURRENT generation at an ownership boundary
   *  (project replacement/reset): cancel the open, abort fetches, stale-guard
   *  every in-flight attempt-gated continuation, and drop the outgoing
   *  snapshot/analysis — so nothing from the old project can be published
   *  under the new one, and a LATE event carrying the old generation id fails
   *  every `=== this.generation` gate instead of repopulating outgoing facts
   *  (the review-b2b-identity finding). The replacement's own startGeneration
   *  installs fresh values asynchronously. */
  private retireGeneration(): void {
    this.activeOpenCancel?.();
    this.activeOpenCancel = null;
    this.abortFetches();
    this.genAttempt++;
    this.generation = null;
    this.snapshot = null;
    this.analysis = { phase: 'idle' };
  }

  private installProject(project: CurrentProject): void {
    // Replace everything: a new project owns a fresh generation lane, and THIS
    // is where ownership actually changes — invalidate the scope so any
    // still-pending operation on the outgoing project goes stale.
    this.lastState = null; // the replacement must never reuse a cached slice
    this.sourceEvidence.clear(); // generation-local; the outgoing project's evidence must not leak
    this.retireGeneration();
    this.scope.invalidate();
    this.pending.clear();
    this.persistIntent.clear();
    this.attached.clear();
    this.sourceStatus.clear();
    this.reattachStatus.clear();
    this.persistOps.clear();
    this.reattachOps.clear();
    // A pending correction belonged to the OUTGOING project; its status must
    // not leak into the replacement (the scope invalidation above also drops
    // any in-flight hash).
    this.correctionOps.clear();
    this.corrections.clear();
    this.id = project.data.id;
    this.kind = project.kind;
    this.indexRecipe = project.data.indexRecipe;
    this.indexRecipeHash = project.data.indexRecipeHash;
    this.adoptData(project.data);
    this.baseRevision = project.kind === 'user' ? project.baseRevision : 0;
    this.editEpoch = 0;
    this.savedEpoch = 0;
    this.saveState = IDLE_SAVE;
    this.pendingSave = null;
    this.saveAgain = false;
    for (const d of project.data.docs) {
      if (d.sourceAvailability === 'bundled') this.sourceStatus.set(d.doc, { phase: 'bundled' });
      else if (d.sourceAvailability === 'persisted') this.sourceStatus.set(d.doc, { phase: 'persisted' });
      else this.sourceStatus.set(d.doc, { phase: 'external-missing', repair: 'external-not-attached' });
    }
    this.data = this.materialize();
  }

  private resetToEmptyUser(): void {
    // Ownership change: the cached publication, the generation-local
    // evidence, AND the outgoing generation's snapshot/analysis belong to the
    // OUTGOING project — all retired synchronously, before `stage` publishes
    // (the review-b2/b2b findings: waiting for the async generation start
    // leaked the old evidence record, snapshot, and analysis phase under the
    // new project, and late old-generation events could repopulate them).
    this.lastState = null;
    this.sourceEvidence.clear();
    this.retireGeneration();
    this.pending.clear();
    this.persistIntent.clear();
    this.attached.clear();
    this.sourceStatus.clear();
    this.reattachStatus.clear();
    this.persistOps.clear();
    this.reattachOps.clear();
    this.correctionOps.clear();
    this.corrections.clear();
    this.finalized.clear();
    this.order = [];
    this.id = USER_PROJECT_ID;
    this.kind = 'user';
    this.indexRecipe = DEFAULT_INDEX_RECIPE;
    // The empty project's index-recipe hash is recomputed lazily at save; the
    // built-in shares DEFAULT_INDEX_RECIPE so we carry over its known hash.
    this.baseRevision = 0;
    this.editEpoch = 0;
    this.savedEpoch = 0;
    this.saveState = IDLE_SAVE;
    this.pendingSave = null;
    this.saveAgain = false;
    this.data = this.materialize();
  }

  /** Materialize the canonical ProjectDataV1: `order` filtered to finalized
   *  docs, `docs` in that order. Async-finalized imports never reorder it. */
  private materialize(): ProjectDataV1 {
    const order = this.order.filter((id) => this.finalized.has(id));
    return {
      id: this.id,
      order,
      docs: order.map((id) => this.finalized.get(id)!),
      indexRecipe: this.indexRecipe,
      indexRecipeHash: this.indexRecipeHash,
    };
  }

  /** Materialize the published view, reusing the previous publication's slice
   *  identities wherever the backing state is unchanged (Phase B ruling W2:
   *  semantic shallow reconciliation, NOT mutation-site dirty flags — a missed
   *  flag would silently publish stale UI, whereas comparing the actual
   *  backing state here is safe for every future mutation site by default).
   *  All backing values (`data`, `saveState`, map values, `analysis`,
   *  `snapshot`) are replaced immutably at their mutation sites, so identity
   *  comparison is sufficient. */
  private buildState(): SessionState {
    const prev = this.lastState;
    const dirty = this.kind === 'user' && this.editEpoch !== this.savedEpoch;
    const candidate: ProjectView = {
      kind: this.kind,
      id: this.id,
      data: this.data,
      baseRevision: this.kind === 'user' ? this.baseRevision : null,
      dirty,
      // IDLE_SAVE (one stable object) rather than a fresh literal — a fresh
      // `{ phase: 'idle' }` would defeat the shallow reuse on every builtin
      // publication.
      save: this.kind === 'user' ? this.saveState : IDLE_SAVE,
      saveable: this.computeSaveable(),
    };
    const project = prev !== null && sameProjectView(prev.project, candidate) ? prev.project : candidate;

    // Imports in declared (selection) order, not Map/completion order. Fresh
    // ImportView objects each build, so reuse compares the four exposed
    // fields by index — never element identity.
    const importsByDoc = this.pending;
    const candidateImports: ImportView[] = this.order
      .filter((id) => importsByDoc.has(id))
      .map((id) => {
        const p = importsByDoc.get(id)!;
        return { doc: p.doc, sourceName: p.sourceName, status: p.status, published: p.published };
      });
    const imports = prev !== null && sameImports(prev.imports, candidateImports) ? prev.imports : candidateImports;

    const sources = reuseRecord(prev?.sources, this.sourceStatus);
    const reattach = reuseRecord(prev?.reattach, this.reattachStatus);
    const sourceEvidence = reuseRecord(prev?.sourceEvidence, this.sourceEvidence);
    const corrections = reuseRecord(prev?.corrections, this.corrections);

    const next: SessionState =
      prev !== null &&
      prev.project === project &&
      prev.analysis === this.analysis &&
      prev.snapshot === this.snapshot &&
      prev.imports === imports &&
      prev.sources === sources &&
      prev.reattach === reattach &&
      prev.sourceEvidence === sourceEvidence &&
      prev.corrections === corrections
        ? prev
        : { project, analysis: this.analysis, snapshot: this.snapshot, imports, sources, reattach, sourceEvidence, corrections };
    this.lastState = next;
    return next;
  }

  private publish(): void {
    if (this.disposed) return;
    const state = this.buildState();
    for (const listener of this.listeners) listener(state);
  }

  private computeSaveable(): boolean {
    if (this.kind !== 'user') return false;
    if (this.editEpoch === this.savedEpoch) return false; // clean — nothing to save
    if (this.finalized.size === 0) return false; // an empty project is not a valid manifest
    if (this.pending.size > 0) return false; // an import is incomplete or failed
    if (this.saveState.phase === 'saving' || this.saveState.phase === 'conflict' || this.saveState.phase === 'reconcile-required') return false;
    for (const s of this.sourceStatus.values()) if (s.phase === 'persist-saving') return false; // persist intent in flight
    return true;
  }

  private touch(): void {
    if (this.kind === 'user') this.editEpoch++;
  }

  /** Record that newer local user intent exists, so an in-flight load's result
   *  is stale and must not install over it. */
  private markUserIntent(): void {
    this.loadFence++;
  }

  private abortFetches(): void {
    for (const c of this.activeFetches) c.abort();
    this.activeFetches.clear();
  }

  private assertLive(): void {
    if (this.disposed) throw new SessionCommandError('the session is disposed');
  }
  private assertUserCommand(name: string): void {
    this.assertLive();
    if (this.kind !== 'user') throw new SessionCommandError(`${name} requires a user project (the built-in is read-only)`);
    this.markUserIntent(); // every user mutation supersedes an in-flight load
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
