/**
 * Stateful main-thread policy for the one active corpus: generation analysis,
 * cold import assembly, ordering, and cancellation. Durable source bytes are
 * always supplied by either the bundled provider or the local library.
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
 */

import {
  DEFAULT_INDEX_RECIPE,
  defaultExtractionRecipes,
  hashExtractionRecipe,
  hashIndexRecipe,
  INGEST_CAPS_V0,
  SOURCE_FORMATS,
  SOURCE_FORMAT_IDS,
  sourceFormatForFilename,
  stripSourceExtension,
  type DetectedEncoding,
  type ExtractionRecipeProvisional,
  type IndexRecipeProvisional,
  type WorkspaceDocumentMetaV1,
} from '@texttrends/core';
import type {
  GenerationDocSpecV4,
  SourceFormat,
} from '../shared/analysis-contract.ts';
import type {
  GenerationReady,
  IngestProgress,
  SnapshotInfo,
  SourceReadyInfo,
} from './client.ts';
import { OperationScope } from './operation-lease.ts';
import type { LocalLibraryFile } from './local-library.ts';
import {
  builtinProject,
  generationSpecsFromProject,
  LIBRARY_PROJECT_ID,
  type CurrentProject,
  type ProjectDataV1,
  type ProjectDocV1,
} from './project.ts';

// ────────────────────────────────────────────────────────────────────────────
// Injected seams keep the worker, bundled fetch, and library independently
// testable without importing browser infrastructure here.
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
}

/** Bundled byte acquisition, kept OUT of the session so the discriminated
 *  availability policy (bundled fetch vs local-library file)
 *  stays visible here while URL/fetch details stay injectable. The whole doc is
 *  passed so the provider selects the URL and the session verifies the returned
 *  length against the authoritative descriptor before transfer. */
export interface BundledByteProvider {
  get(doc: ProjectDocV1, signal: AbortSignal): Promise<ArrayBuffer>;
}

export interface LibraryFileProvider {
  get(id: string): Promise<LocalLibraryFile>;
}

export interface ProjectSessionDeps {
  readonly client: ProjectSessionClient;
  readonly bundledBytes: BundledByteProvider;
  readonly libraryFiles: LibraryFileProvider;
  /** Prevalidated read-only corpora available to the built-in picker. Optional
   *  in focused fixtures that never switch projects. */
  readonly builtinProjects?: ReadonlyMap<string, ProjectDataV1>;
  /** Stable document id allocator (production: `crypto.randomUUID`). */
  readonly newDocId: () => string;
}

// ────────────────────────────────────────────────────────────────────────────
// Published state — every field serializable. The actual File objects, abort
// controllers, request handles, and promises live in private sidecars.
// ────────────────────────────────────────────────────────────────────────────

/** Per-document source runtime status. Source bytes are either bundled or in
 *  the local library; failures are explicit and retryable by reopening. */
export type SourceStatus =
  | { readonly phase: 'bundled' }
  | { readonly phase: 'library' }
  | { readonly phase: 'error'; readonly message: string };

export type ImportStatus = 'planned' | 'extracting' | 'failed';

/** The observable view of one staged import (the private `PendingImport` holds
 *  the correlation tokens). */
export interface ImportView {
  readonly doc: string;
  readonly sourceName: string;
  readonly library: string;
  readonly status: ImportStatus;
  readonly published: boolean;
}

export type AnalysisPhase =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading'; readonly detail: string | null }
  | { readonly phase: 'ready' }
  | { readonly phase: 'error'; readonly message: string; readonly fatal: boolean };

export interface ProjectView {
  readonly kind: 'builtin' | 'library';
  readonly id: string;
  readonly data: ProjectDataV1;
}

/** Transient decoder diagnostics from extraction in this generation. A warm
 * artifact reopen leaves them absent rather than fabricating zeroes. */
export interface ExtractionDiagnostics {
  readonly detectedEncoding?: DetectedEncoding;
  readonly hadReplacementChars?: boolean;
  readonly decoderReplacementCount: number;
  readonly suspiciousControlCount: number;
}

export interface SessionState {
  readonly project: ProjectView;
  readonly analysis: AnalysisPhase;
  readonly snapshot: SnapshotInfo | null;
  readonly imports: readonly ImportView[];
  readonly sources: Readonly<Record<string, SourceStatus>>;
  readonly extractionDiagnostics: Readonly<Record<string, ExtractionDiagnostics>>;
}

/** Thrown by public commands used against an illegal origin/state — a
 *  programming error the UI prevents and tests surface loudly. */
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
  readonly library: string;
  readonly contentHash: string;
  readonly meta: WorkspaceDocumentMetaV1;
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

const CAPS = INGEST_CAPS_V0;

/** Default document metadata from a filename: the title is the name minus its
 *  known source extension (via the core format catalog); language/tags take
 *  neutral defaults the user may edit. */
function initialMetaFor(name: string): WorkspaceDocumentMetaV1 {
  return { title: stripSourceExtension(name), language: 'en', tags: [] };
}

/**
 * The single current-project session. Construct one per client lifetime; it
 * installs the exclusive generation-lane callbacks in the constructor. All
 * public commands are synchronous entry points that publish immediately and
 * fence their async continuations by monotonic tokens.
 */
/** Shallow field equality for the published ProjectView. */
function sameProjectView(a: ProjectView, b: ProjectView): boolean {
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.data === b.data
  );
}

function sameImports(prev: readonly ImportView[], next: readonly ImportView[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i += 1) {
    const a = prev[i]!;
    const b = next[i]!;
    if (a.doc !== b.doc || a.sourceName !== b.sourceName || a.library !== b.library || a.status !== b.status || a.published !== b.published) {
      return false;
    }
  }
  return true;
}

/** Reuse the previous record when the map holds identical values for the same
 *  key set: equal size plus every map key matching by identity covers
 *  replacement, deletion, clear, and same-size key swaps (a swapped-in key
 *  is not an own property of the old record and fails the check). Own-key
 *  semantics throughout: document IDs are arbitrary strings, so lookups must
 *  not walk the prototype and
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
  private kind: 'builtin' | 'library';
  private indexRecipe: IndexRecipeProvisional;
  private indexRecipeHash: string;
  /** All doc ids — finalized AND still-pending — in DECLARED (selection) order.
   *  `data.order` is this filtered to finalized docs, so async finalization can
   *  never reorder the declared sequence. */
  private order: string[] = [];
  private readonly finalized = new Map<string, ProjectDocV1>();
  private data: ProjectDataV1;

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
  /** Per-generation decoder diagnostics captured from `source-ready`. */
  private readonly extractionDiagnostics = new Map<string, ExtractionDiagnostics>();
  // Pending imports retain their library-backed file until the two-fact join.
  private readonly attached = new Map<string, LocalLibraryFile>();
  private readonly sourceStatus = new Map<string, SourceStatus>();

  // ── Ownership fences. ──
  // ONE scope for corpus ownership, invalidated on replacement and closed on
  // dispose. Async recipe staging leases derive from it.
  private readonly scope = new OperationScope();

  constructor(initial: CurrentProject, deps: ProjectSessionDeps) {
    this.deps = deps;
    this.id = initial.data.id;
    this.kind = initial.kind;
    this.indexRecipe = initial.data.indexRecipe;
    this.indexRecipeHash = initial.data.indexRecipeHash;
    this.adoptData(initial.data);
    for (const doc of initial.data.docs) {
      this.sourceStatus.set(doc.doc, { phase: doc.sourceAvailability === 'bundled' ? 'bundled' : 'library' });
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
   *  client keeps its last-wins callbacks (one session owns one client
   *  lifetime), but every guarded continuation checks `disposed` first. */
  dispose(): void {
    this.disposed = true;
    this.scope.close();
    this.abortFetches();
    this.activeOpenCancel?.();
    this.activeOpenCancel = null;
    this.listeners.clear();
  }

  /** Open the analysis generation for the current project (built-in or loaded
   *  user data). The one entry the app calls at boot and after a nonfatal
   *  restart; import and reorder reopen it internally. */
  start(): void {
    this.assertLive();
    this.startGeneration();
  }

  /** Switch between prevalidated read-only demo corpora. */
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

  // ── Commands: import ────────────────────────────────────────────────────────

  /** Create a fresh empty library-backed corpus and stage selected files. */
  createLibraryCorpus(files: readonly LocalLibraryFile[]): void {
    this.assertLive();
    if (this.kind === 'library') {
      throw new SessionCommandError('createLibraryCorpus is only from a built-in; use appendFiles for the active library corpus');
    }
    // Validate the selection BEFORE destroying the current project — an
    // unsupported/oversized selection must not cost the working copy.
    this.preflightImport(files, /* fromEmpty */ true);
    // Replacing the corpus starts a new ownership epoch.
    this.scope.invalidate();
    this.resetToEmptyUser();
    this.stage(files);
  }

  /** Append selected library files while preserving existing docs and order. */
  appendFiles(files: readonly LocalLibraryFile[]): void {
    this.assertLive();
    if (this.kind !== 'library') throw new SessionCommandError('appendFiles requires a library corpus; use createLibraryCorpus from a built-in');
    this.preflightImport(files, /* fromEmpty */ false);
    this.stage(files);
  }

  /** Drop a staged import (typically a failed one). Reopens the generation
   *  without its provisional cold doc. */
  removeImport(doc: string): void {
    this.assertLive();
    if (!this.pending.has(doc)) return;
    this.pending.delete(doc);
    this.attached.delete(doc);
    this.sourceStatus.delete(doc);
    this.order = this.order.filter((id) => id !== doc); // no phantom document-cap usage
    this.startGeneration();
  }

  /** Remove a finalized document from the active library corpus. Its reusable
   * browser-library copy (if any) is owned by the acquisition library and is
   * deliberately untouched. */
  removeDocument(doc: string): void {
    this.removeDocuments([doc]);
  }

  removeDocuments(docs: readonly string[]): void {
    this.assertUserCommand('removeDocument');
    const removed = new Set(docs.filter((doc) => this.finalized.has(doc) || this.pending.has(doc)));
    if (removed.size === 0) return;
    for (const doc of removed) {
      this.finalized.delete(doc);
      this.pending.delete(doc);
      this.attached.delete(doc);
      this.sourceStatus.delete(doc);
      this.extractionDiagnostics.delete(doc);
    }
    this.order = this.order.filter((id) => !removed.has(id));
    this.data = this.materialize();
    this.startGeneration();
  }

  // ── Commands: metadata / order ──────────────────────────────────────────────

  /** Edit descriptive metadata (title/author/year/tags). Dirties the project
   *  but does NOT reopen analysis — these never change tokenization or order. */
  editMeta(doc: string, patch: Partial<Pick<WorkspaceDocumentMetaV1, 'title' | 'author' | 'year' | 'tags'>>): void {
    this.assertUserCommand('editMeta');
    const existing = this.finalized.get(doc);
    if (!existing) throw new SessionCommandError(`editMeta: '${doc}' is not a finalized document`);
    const meta: WorkspaceDocumentMetaV1 = { ...existing.meta, ...patch };
    this.finalized.set(doc, { ...existing, meta });
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
    this.startGeneration(); // reopen: tokenization may change
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
    // Diagnostics are per-generation: a doc not re-extracted this generation
    // (warm text/shard reopen) has unknown counts, never stale carried-over ones.
    this.extractionDiagnostics.clear();
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
        for (const doc of ready.missingDocs) void this.resolveMiss(generation, attempt, doc);
      })
      .catch((e: unknown) => {
        if (this.disposed || attempt !== this.genAttempt) return;
        this.activeOpenCancel = null;
        this.analysis = { phase: 'error', message: `failed to open the generation: ${msg(e)}`, fatal: false };
        this.publish();
      });
  }

  /** The cold spec for a staged import: recipe values, the verified library
   *  source identity, and no warm text identity. */
  private coldSpec(p: PendingImport, recipes: ImportRecipes): GenerationDocSpecV4 {
    return {
      doc: p.doc,
      language: p.meta.language,
      source: {
        expectedHash: p.contentHash,
        byteLength: p.byteLength,
        format: p.format,
      },
      extraction: { recipe: recipes.extraction, recipeHash: recipes.extractionRecipeHash },
    };
  }

  private async resolveMiss(generation: string, attempt: number, doc: string): Promise<void> {
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
      case 'library': {
        try {
          if (finalizedDoc.library === undefined) throw new Error('document has no library reference');
          const file = await this.deps.libraryFiles.get(finalizedDoc.library);
          if (
            file.contentHash !== finalizedDoc.source.hash
            || file.format !== finalizedDoc.source.format
            || file.size !== finalizedDoc.source.byteLength
          ) {
            throw new Error('library source identity changed');
          }
          const bytes = await file.arrayBuffer();
          if (this.disposed || attempt !== this.genAttempt || generation !== this.generation) return;
          this.deps.client.ingest(generation, doc, bytes);
          this.sourceStatus.set(doc, { phase: 'library' });
        } catch (error) {
          if (this.disposed || attempt !== this.genAttempt) return;
          this.sourceStatus.set(doc, { phase: 'error', message: msg(error) });
          this.analysis = { phase: 'error', message: `failed to read '${doc}' from the library: ${msg(error)}`, fatal: false };
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
      this.sourceStatus.set(doc, { phase: 'error', message: msg(e) });
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
    const encoding = info.source.kind === 'text' || info.source.kind === 'markup'
      ? info.source.encoding
      : undefined;
    this.extractionDiagnostics.set(info.doc, {
      ...(encoding === undefined ? {} : {
        detectedEncoding: encoding.detected,
        hadReplacementChars: encoding.hadReplacementChars,
      }),
      decoderReplacementCount: info.decoderReplacementCount,
      suspiciousControlCount: info.suspiciousControlCount,
    });
    const p = this.pending.get(info.doc);
    if (!p) {
      this.publish(); // a finalized doc's re-extraction — surface diagnostics
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
    if (info.source.hash !== p.contentHash || info.source.format !== p.format) {
      this.pending.set(doc, { ...p, status: 'failed' });
      this.analysis = { phase: 'error', message: `library identity mismatch for '${p.sourceName}'`, fatal: false };
      return;
    }
    const finalizedDoc: ProjectDocV1 = {
      doc: p.doc,
      sourceName: p.sourceName,
      library: p.library,
      meta: p.meta,
      source: {
        hash: info.source.hash,
        byteLength: info.source.byteLength,
        format: info.source.format,
      },
      sourceAvailability: 'library',
      extraction: {
        recipe: recipes.extraction,
        recipeHash: info.extractionRecipeHash,
        text: info.text,
        textLengthUtf16: info.textLengthUtf16,
      },
    };
    this.pending.delete(doc);
    this.attached.delete(doc);
    this.finalized.set(doc, finalizedDoc); // `order` already carries `doc` at its selection position
    this.sourceStatus.set(doc, { phase: 'library' });
    this.data = this.materialize();
  }

  private handleIngestError(generation: string, message: string, doc?: string): void {
    if (this.disposed || generation !== this.generation) return;
    if (doc && this.pending.has(doc)) {
      const p = this.pending.get(doc)!;
      this.pending.set(doc, { ...p, status: 'failed' });
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
    if (fatal) {
      this.analysis = { phase: 'error', message: 'the analysis worker crashed repeatedly; reload to retry', fatal: true };
      this.publish();
      return; // working copy, files, and pending imports are retained
    }
    this.startGeneration();
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
  private preflightImport(files: readonly LocalLibraryFile[], fromEmpty: boolean): void {
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
        existingText += d.extraction.textLengthUtf16 ?? d.source.byteLength;
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
      const filenameFormat = sourceFormatForFilename(f.name);
      if (filenameFormat === null || filenameFormat !== f.format) {
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
  private stage(files: readonly LocalLibraryFile[]): void {
    if (files.length === 0) return;
    // Allocate ids + tokens up front so each plan CARRIES its own importToken
    // (never reconstructed from `this.pending`, which a duplicate id would
    // corrupt). A collision from the injected allocator is a hard programming
    // error, not a silent overwrite of a live entry.
    const plans = files.map((file) => ({
      doc: this.deps.newDocId(),
      file,
      format: file.format,
      importToken: ++this.importCounter,
    }));
    const ids = new Set(plans.map((p) => p.doc));
    if (ids.size !== plans.length || plans.some((p) => this.order.includes(p.doc))) {
      throw new SessionCommandError('newDocId returned a duplicate document id');
    }
    for (const { doc, file, format, importToken } of plans) {
      this.order.push(doc);
      this.attached.set(doc, file);
      this.sourceStatus.set(doc, { phase: 'library' });
      this.pending.set(doc, {
        importToken,
        doc,
        sourceName: file.name,
        library: file.library,
        contentHash: file.contentHash,
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
    // SOURCE_FORMAT_IDS so a new format needs no edit here) plus index in parallel.
    const byFormat = await defaultExtractionRecipes();
    const [indexHash, formatHashes] = await Promise.all([
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
      };
      this.pending.set(doc, { ...p, staging: { phase: 'ready', recipes } });
      matched++;
    }
    // If every staged import was removed/superseded meanwhile, this stale
    // continuation must NOT reopen the generation or mutate current data.
    if (matched === 0) return;
    // Keep the index recipe hash consistent with the active recipe.
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
    this.extractionDiagnostics.clear();
    this.retireGeneration();
    this.scope.invalidate();
    this.pending.clear();
    this.attached.clear();
    this.sourceStatus.clear();
    this.id = project.data.id;
    this.kind = project.kind;
    this.indexRecipe = project.data.indexRecipe;
    this.indexRecipeHash = project.data.indexRecipeHash;
    this.adoptData(project.data);
    for (const d of project.data.docs) {
      if (d.sourceAvailability === 'bundled') this.sourceStatus.set(d.doc, { phase: 'bundled' });
      else this.sourceStatus.set(d.doc, { phase: 'library' });
    }
    this.data = this.materialize();
  }

  private resetToEmptyUser(): void {
    // Ownership change: the cached publication, the generation-local
    // diagnostics, AND the outgoing generation's snapshot/analysis belong to the
    // OUTGOING project — all retired synchronously, before `stage` publishes
    // (the review-b2/b2b findings: waiting for the async generation start
    // leaked the old diagnostics, snapshot, and analysis phase under the
    // new project, and late old-generation events could repopulate them).
    this.lastState = null;
    this.extractionDiagnostics.clear();
    this.retireGeneration();
    this.pending.clear();
    this.attached.clear();
    this.sourceStatus.clear();
    this.finalized.clear();
    this.order = [];
    this.id = LIBRARY_PROJECT_ID;
    this.kind = 'library';
    this.indexRecipe = DEFAULT_INDEX_RECIPE;
    // The built-in shares DEFAULT_INDEX_RECIPE, so its known hash remains valid
    // until finishStaging recomputes it with the import recipes.
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
   *  All backing values (`data`, map values, `analysis`,
   *  `snapshot`) are replaced immutably at their mutation sites, so identity
   *  comparison is sufficient. */
  private buildState(): SessionState {
    const prev = this.lastState;
    const candidate: ProjectView = {
      kind: this.kind,
      id: this.id,
      data: this.data,
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
        return { doc: p.doc, sourceName: p.sourceName, library: p.library, status: p.status, published: p.published };
      });
    const imports = prev !== null && sameImports(prev.imports, candidateImports) ? prev.imports : candidateImports;

    const sources = reuseRecord(prev?.sources, this.sourceStatus);
    const extractionDiagnostics = reuseRecord(prev?.extractionDiagnostics, this.extractionDiagnostics);
    const next: SessionState =
      prev !== null &&
      prev.project === project &&
      prev.analysis === this.analysis &&
      prev.snapshot === this.snapshot &&
      prev.imports === imports &&
      prev.sources === sources &&
      prev.extractionDiagnostics === extractionDiagnostics
        ? prev
        : { project, analysis: this.analysis, snapshot: this.snapshot, imports, sources, extractionDiagnostics };
    this.lastState = next;
    return next;
  }

  private publish(): void {
    if (this.disposed) return;
    const state = this.buildState();
    for (const listener of this.listeners) listener(state);
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
    if (this.kind !== 'library') throw new SessionCommandError(`${name} requires a library corpus (the built-in is read-only)`);
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
