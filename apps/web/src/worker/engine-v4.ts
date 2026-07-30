import {
  dispersionTransferBuffers,
  inventoryTransferBuffers,
  INVENTORY_MAX_SECTIONS,
  type InventorySectionInputV1,
} from '@texttrends/core';
import { QueryExecutor } from './query-executor.ts';
/**
 * WorkerEngineV4 — the ingest/structure worker lifecycle (contract §12.8;
 * "Commit 6 design of record" and the "6b/6c boundary ruling" in
 * docs/design/ingest-structure-plan.md). This is the PRODUCTION analysis
 * engine: index.worker.ts constructs it (6c wire cutover), and the v3 engine
 * has been removed. It landed first (6b) as an unused, isolated module so the
 * new state machine could be reviewed on its own before the atomic cutover.
 *
 * What v4 added over the retired v3 engine:
 * - a resolved, immutable per-document PLAN computed once at generation start,
 *   with every caller-supplied hash RECOMPUTED (a hash is an admission check
 *   and a lookup accelerator, never authority);
 * - a three-stage artifact pipeline (extraction → index → structure) with deep
 *   admission of every cached record crossing the `unknown` boundary;
 * - honest decode/extract/segment/index/structure/compose progress;
 * - per-document work CLAIMS (generation-object identity + a monotonic epoch),
 *   because a `ReadyDocument`-identity guard is insufficient while warm probing,
 *   extraction, indexing, and structure building overlap BEFORE any ready
 *   document exists;
 * - a snapshot-bound `structure` query echoing both bound artifact identities;
 * - a SEPARATE user-data lane (project load/save, source persist) over an
 *   injected access provider, emitting only user-data acknowledgements/errors.
 *
 * The M4/M5 lifecycle guarantees are preserved across the longer pipeline:
 * generation replacement is synchronous and IS invalidation; publication is a
 * single guarded path serialized through a composition mutex; queries carry the
 * snapshot identity; cache writes are best-effort AFTER publication; a durable
 * source is never repair-deleted.
 */

import {
  CapError,
  DependencyError,
  INGEST_CAPS_V0,
  bindSectionId,
  hashSourceBytes,
  bindShardsIncremental,
  bindTextsVerified,
  createBindingSession,
  buildDetectedSections,
  composeSnapshot,
  composeStructure,
  createDocumentIndexVerified,
  deriveCandidatesFromText,
  emptyOverride,
  lineWindowAround,
  fingerprint,
  firstSelectionOverlap,
  hashExtractionRecipe,
  hashIndexRecipe,
  hashSegmenterFingerprint,
  hashStructureOverride,
  hashStructureRecipe,
  makeReadyDocument,
  projectSections,
  resolveSelection,
  segmentVerified,
  tokenEndChar,
  validateExtractionArtifactVerified,
  validateExtractionRecipe,
  validateShardStructure,
  validateStructureArtifactV2,
  verifiedHashOf,
  verifiedTextOf,
  verifyText,
  type BindingSession,
  type BoundShards,
  type BoundTexts,
  type CandidateBundle,
  type IngestCapsV0,
  type CorpusSnapshotV1,
  type DocumentIndexV1,
  type ExtractionArtifactV1,
  type ExtractionRecipeProvisional,
  type IndexRecipeProvisional,
  type ReadyDocument,
  StructureCapError,
  StructureError,
  type SourceDescriptorV1,
  type StructureArtifactV2,
  type StructureOverrideV1,
  type StructureRecipeProvisional,
  type StructureSectionRecordV2,
  type TextHash,
  type TokenRange,
  type VerifiedText,
} from '@texttrends/core';
import {
  PROTOCOL_VERSION_V4,
  type BuildPhaseV4,
  type FromWorkerV4,
  type GenerationDocSpecV4,
  type MissingWarmDocV4,
  type OverrideInputV4,
  type EditSectionRow,
  type QueryOpV4,
  type StorageWarningCodeV4,
  type WarmMissReasonV4,
  type WireSection,
  type WorkerErrorCodeV4,
} from './protocol-v4.ts';
import { parseToWorkerV4 } from './protocol-v4-schema.ts';
import { extractSource, ExtractionFailure, type ExtractionLimits } from '@texttrends/extractors';
import type { ArtifactStore, DocumentIndexCacheKey, ExtractionCacheKey, StructureCacheKey } from './store.ts';

type EmitV4 = (message: FromWorkerV4, transfers?: readonly Transferable[]) => void;
type Yield = () => Promise<void>;

// The durable user-data seam types live with the extracted handler; re-export
// so the worker shell and tests keep one engine import.
export type { UserDataAccess, UserDataProvider } from './user-data-handler.ts';
import { UserDataHandler, type UserDataProvider } from './user-data-handler.ts';

/** Bail-out sentinels caught at the dispatch boundary and swallowed:
 *  CANCELLED aborts the whole job (a `cancelled`/error was already emitted);
 *  SUPERSEDED aborts one document's work because a newer owner claimed it. */
const CANCELLED = Symbol('cancelled');
const SUPERSEDED = Symbol('superseded');

/** A precise terminal identity failure (maps to EXTRACTION_MISMATCH): a
 *  deterministic candidate reconstruction contradicts an asserted identity, so
 *  refetching bytes cannot repair it. */
class ExtractionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionMismatchError';
  }
}

/** The document's frozen meaning within a generation — set once a source/text/
 *  candidate identity is accepted, and it SURVIVES epoch increments: the epoch
 *  says which async task may act; accepted identity says what the document IS. */
interface AcceptedIdentity {
  readonly source?: string; // SourceHash, only from a real source extraction
  readonly text: string; // TextHash
  readonly candidates: string; // StructureCandidateHash
}

interface DocWorkSlot {
  /** Monotonic within this generation; bumped when a new task claims the doc. */
  epoch: number;
  accepted?: AcceptedIdentity;
}

/** A per-document work claim: generation OBJECT identity (never its string) +
 *  the epoch at claim time. Ownership is lost when either changes. */
interface DocWorkToken {
  readonly generation: GenerationStateV4;
  readonly doc: string;
  readonly epoch: number;
}

/** The resolved, immutable per-document plan. Recipes/hashes/expected
 *  identities are fixed after resolution; the maps below stay engine-private. */
interface ResolvedDocPlan {
  readonly spec: GenerationDocSpecV4;
  readonly doc: string;
  readonly effectiveLocale: string;
  readonly extractionRecipe: ExtractionRecipeProvisional;
  readonly extractionRecipeHash: string;
  readonly structureRecipe: StructureRecipeProvisional;
  readonly structureRecipeHash: string;
  readonly override: OverrideInputV4;
  readonly expectedText?: string | undefined;
  readonly expectedCandidates?: string | undefined;
  readonly expectedSourceHash?: string | undefined;
  readonly sourcePersisted: boolean;
}

interface GenerationStateV4 {
  readonly generation: string;
  readonly docs: readonly string[];
  readonly indexRecipe: IndexRecipeProvisional;
  indexRecipeHash: string | null;
  readonly segmenterHashes: Map<string, string>;
  readonly plans: Map<string, ResolvedDocPlan>;
  readonly work: Map<string, DocWorkSlot>;
  ready: Map<string, ReadyDocument>;
  /** Per-doc resident text as its VerifiedText capability — the ONE per-doc
   *  text-identity proof retained for the generation (Phase D / D2). */
  texts: Map<string, VerifiedText>;
  snapshot: CorpusSnapshotV1 | null;
  bound: BoundShards | null;
  boundTexts: BoundTexts | null;
  /** Generation-owned incremental binding session (Phase D workstream D1):
   *  the publication path's `bindShardsIncremental` memoizes per-document
   *  clone+validation on it, so publication K+1 with one new document pays
   *  for one document. Opaque and WeakMap-authenticated inside core's
   *  binding module; dropped with the generation. */
  readonly binding: BindingSession;
  /** The generation-bound query executor (slice-2 ruling §B): owns trend/
   *  kwic/passage execution, resolver reuse, and the shared occurrence cache.
   *  Fed a fresh read-only view at every publication; dies with the
   *  generation. The engine keeps job/cancel/emission authority. */
  readonly executor: QueryExecutor;
  /** Doc-independent section→token projections, keyed [StructureHash, IndexArtifactHash]. */
  readonly tokenViews: Map<string, readonly TokenRange[]>;
  /** Bounded ephemeral DETECTED-table cache for the edit-context query, keyed
   *  [TextHash, CandidateHash, StructureRecipeHash] — never persisted (ruling §2). */
  readonly detectedTables: Map<string, readonly StructureSectionRecordV2[]>;
  /** Per-generation SectionId binding cache (Phase D ruling, workstream D4).
   *  Section ids depend only on (doc, lineageKey) and are DELIBERATELY stable
   *  across snapshots within a generation, so both structure query paths share
   *  one cache dropped with the generation. NESTED maps, doc → lineage key —
   *  neither identifier contract forbids '\0', so a delimiter-joined string
   *  key would not be collision-free. The value is the PENDING promise, stored
   *  synchronously on first request so concurrent queries deduplicate the same
   *  digest; a rejection evicts exactly that promise (identity-compared) so a
   *  later request retries without clobbering a concurrent replacement.
   *  Unbounded on purpose: the section cap is 2,048/doc and the map dies with
   *  the generation (ruling: no LRU, no semaphore). */
  readonly sectionIds: Map<string, Map<string, Promise<string>>>;
  /** Incremented only on a successful commit — an explicit staged-base guard. */
  publicationEpoch: number;
  /** Running ACTUAL totals (not just declared) enforced against the project
   *  caps: transferred source bytes across cold ingests, so a document that
   *  over-delivers relative to its declared byteLength cannot slip the §12.9
   *  aggregate guard. Resident text is summed from `texts` on demand. */
  transferredSourceBytes: number;
}

/** A fully prepared document ready for the single publication path, plus the
 *  disposable cache keys/artifacts to persist AFTER it commits. */
interface PreparedDocument {
  readonly doc: string;
  readonly text: string;
  /** The capability proving `text`'s identity — consumed by the verified
   *  binding path at commit and retained on `gen.texts`. */
  readonly verified: VerifiedText;
  readonly ready: ReadyDocument;
  readonly shard: DocumentIndexV1;
  readonly shardKey: DocumentIndexCacheKey;
  readonly structureKey: StructureCacheKey;
  readonly structureArtifact: StructureArtifactV2;
  /** Only present when THIS build performed a real source extraction. */
  readonly extraction?: { readonly artifact: ExtractionArtifactV1; readonly key: ExtractionCacheKey } | undefined;
}

/** Everything a warm probe admitted from the cache for one document. */
interface AdmittedParts {
  readonly candidates?: CandidateBundle;
  readonly extraction?: { readonly artifact: ExtractionArtifactV1; readonly key: ExtractionCacheKey };
  readonly shard?: DocumentIndexV1;
  readonly structure?: StructureArtifactV2;
}

/** The verified inputs prepareFromText builds the remaining artifacts from.
 *  The text travels ONLY as its VerifiedText capability — minted exactly once
 *  per document (cold: at extraction; warm: at the stored-text check). */
interface PrepareInput {
  readonly verified: VerifiedText;
  readonly candidateHash: string;
  readonly parts: AdmittedParts;
}

type WarmProbe =
  | { readonly kind: 'prepare'; readonly cheap: boolean; readonly input: PrepareInput }
  | { readonly kind: 'needs-bytes'; readonly reason: WarmMissReasonV4 }
  | { readonly kind: 'mismatch'; readonly message: string };

/**
 * EXPLICIT transfer list for a trend result — an enumerated switch, never a
 * recursive buffer walk (M6 consult): the enumeration keeps a future result
 * field from accidentally transferring a view backed by resident shard storage.
 */
function trendTransferList(t: import('@texttrends/core').NumericTrend): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const view of [t.docOrdinal, t.binIndex, t.binStartToken, t.binTokens, t.count, t.ratePer10k]) {
    if (view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
  }
  return [...buffers];
}

/** One effective locale per document: a fixed-mode recipe pins every doc; the
 *  document-metadata mode uses the doc's language, falling back when absent. */
function effectiveLocale(recipe: IndexRecipeProvisional, language: string): string {
  if (recipe.locale.mode === 'fixed') return recipe.locale.value;
  return language !== '' ? language : recipe.locale.fallback;
}

/** The composite key for a doc-independent section→token projection. */
const tokenViewKey = (structure: string, index: string): string => `${structure}\u0000${index}`;



/** Hard ceiling on a line-excerpt window so a caller cannot request an
 *  unbounded slice of a pathological physical line (§4). */
const LINE_EXCERPT_MAX_CHARS = 4096;

export class WorkerEngineV4 {
  private readonly store: ArtifactStore;
  private readonly userData: UserDataProvider;
  private readonly userDataHandler: UserDataHandler;
  private readonly emit: EmitV4;
  private readonly yieldControl: Yield;
  private generation: GenerationStateV4 | null = null;
  private readonly activeJobs = new Set<number>();
  private readonly cancelledJobs = new Set<number>();
  private composing: Promise<unknown> = Promise.resolve();
  private readonly envWarned = new Set<StorageWarningCodeV4>();
  /** The ingest caps — INGEST_CAPS_V0 in production; a test may inject smaller
   *  values to exercise the aggregate-cap paths without near-limit buffers. */
  private readonly caps: IngestCapsV0;

  constructor(store: ArtifactStore, userData: UserDataProvider, emit: EmitV4, yieldControl: Yield, caps: IngestCapsV0 = INGEST_CAPS_V0) {
    this.store = store;
    this.userData = userData;
    this.emit = emit;
    this.yieldControl = yieldControl;
    this.caps = caps;
    // The user-data lane is a separate subsystem (own error channel, no
    // generation state) — the engine keeps only job bookkeeping and dispatch.
    this.userDataHandler = new UserDataHandler({
      provider: userData,
      maxSourceBytesPerFile: caps.maxSourceBytesPerFile,
      isCancelled: (job) => this.cancelledJobs.has(job),
      emit: (m) => this.emit(m),
    });
  }

  /** The per-document extraction limits `extractSource` enforces — the output
   *  text cap (all formats) and the decompressed-archive input cap (epub). */
  private extractionLimits(): ExtractionLimits {
    return {
      maxTextUtf16PerDoc: this.caps.maxTextUtf16PerDoc,
      maxArchiveInflatedBytesPerDoc: this.caps.maxArchiveInflatedBytesPerDoc,
    };
  }

  async handle(raw: unknown): Promise<void> {
    if (raw === null || typeof raw !== 'object' || typeof (raw as { t?: unknown }).t !== 'string') {
      this.emitError('PARSE_FAILED', { message: 'malformed envelope', recoverable: true });
      return;
    }
    const rec = raw as Record<string, unknown>;
    const job = typeof rec.job === 'number' ? rec.job : undefined;
    if (rec.v !== PROTOCOL_VERSION_V4) {
      this.emitError('PROTOCOL_VERSION', { job, message: `expected protocol ${PROTOCOL_VERSION_V4}`, recoverable: false });
      return;
    }
    const message = parseToWorkerV4(raw);
    if (message === null) {
      this.emitError('PARSE_FAILED', { job, message: `malformed '${String(rec.t)}' payload`, recoverable: true });
      return;
    }
    if (job !== undefined && message.t !== 'cancel') this.activeJobs.add(job);
    try {
      switch (message.t) {
        case 'begin-generation':
          await this.beginGeneration(message.job, message.generation, message.docs, message.indexRecipe);
          return;
        case 'ingest':
          await this.ingest(message.job, message.generation, message.doc, message.bytes);
          return;
        case 'query':
          await this.query(message.job, message.snapshot, message.query);
          return;
        case 'cancel':
          if (this.activeJobs.has(message.job)) this.cancelledJobs.add(message.job);
          return;
        case 'project-load':
        case 'project-save':
        case 'research-load':
        case 'research-save':
        case 'source-persist':
          await this.userDataHandler.handle(message);
          return;
        default: {
          // Unreachable: parseToWorkerV4 maps every unknown tag to null and
          // handle() emits PARSE_FAILED before dispatch. Kept for compile-time
          // exhaustiveness only.
          const unknown: never = message;
          void unknown;
          return;
        }
      }
    } catch (e) {
      if (e === CANCELLED || e === SUPERSEDED) return;
      const m = mapError(e);
      this.emitError(m.code, { ...(job === undefined ? {} : { job }), message: m.message, recoverable: true });
    } finally {
      if (job !== undefined && message.t !== 'cancel') {
        this.activeJobs.delete(job);
        this.cancelledJobs.delete(job);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 1. Generation plan resolution and document claims
  // -------------------------------------------------------------------------

  private async beginGeneration(
    job: number,
    generation: string,
    docs: readonly GenerationDocSpecV4[],
    indexRecipe: IndexRecipeProvisional,
  ): Promise<void> {
    // Synchronously replace the generation FIRST — replacement IS invalidation.
    // Old jobs/snapshots become stale at receipt of begin-generation, never
    // after hashing happens to finish (engine-v4 consult §Recommended start).
    const gen: GenerationStateV4 = {
      generation,
      docs: docs.map((d) => d.doc),
      indexRecipe,
      indexRecipeHash: null,
      segmenterHashes: new Map(),
      plans: new Map(),
      work: new Map(),
      ready: new Map(),
      texts: new Map(),
      snapshot: null,
      bound: null,
      boundTexts: null,
      binding: createBindingSession(),
      executor: new QueryExecutor(indexRecipe),
      tokenViews: new Map(),
      detectedTables: new Map(),
      sectionIds: new Map(),
      publicationEpoch: 0,
      transferredSourceBytes: 0,
    };
    for (const d of docs) gen.work.set(d.doc, { epoch: 0 });
    this.generation = gen;

    // Resolve + validate immutable per-doc plans under this job/generation.
    await this.resolvePlans(job, gen, docs);
    this.gate(job, gen);

    // Warm resolution: classify every doc, batch exact + cheap into ONE
    // snapshot, stream expensive rebuilds, then fire the barrier.
    const misses: MissingWarmDocV4[] = [];
    const cheapBatch: { prepared: PreparedDocument; token: DocWorkToken }[] = [];
    const expensive: { plan: ResolvedDocPlan; input: PrepareInput; token: DocWorkToken }[] = [];

    for (const doc of gen.docs) {
      await this.checkpoint(job, gen);
      if (gen.ready.has(doc)) continue; // committed by a concurrent ingest
      const plan = gen.plans.get(doc)!;
      const token = this.claim(gen, doc);
      try {
        const probe = await this.probeWarmDocument(job, plan, token);
        this.gate(job, gen);
        if (!this.owns(token)) continue; // an ingest superseded this warm claim
        if (probe.kind === 'needs-bytes') {
          misses.push({ doc, need: 'source-bytes', reason: probe.reason });
        } else if (probe.kind === 'mismatch') {
          // A terminal identity failure — bytes cannot repair it; report and
          // do NOT list it as a byte miss (no refetch loop).
          this.emitError('EXTRACTION_MISMATCH', { job, generation, message: probe.message, recoverable: true });
        } else if (probe.cheap) {
          const prepared = await this.prepareFromText(job, plan, probe.input, token);
          this.gate(job, gen);
          if (this.owns(token)) cheapBatch.push({ prepared, token });
        } else {
          expensive.push({ plan, input: probe.input, token });
        }
      } catch (e) {
        if (e === SUPERSEDED) continue; // an ingest claimed this doc mid-probe
        if (e === CANCELLED) throw e;
        if (!this.emitTerminalWarmFailure(e, job, generation)) {
          // A failed warm attempt falls back to the byte path; a real fault
          // will surface with full context on the cold ingest.
          misses.push({ doc, need: 'source-bytes', reason: 'rehydrate-failed' });
        }
      }
    }

    // All exact + cheap hits publish as ONE snapshot (no N-snapshot churn).
    if (cheapBatch.length > 0) {
      const committed = await this.commitDocuments(job, gen, cheapBatch);
      for (const prepared of committed) this.writeArtifacts(gen, prepared);
    }

    // Stream expensive rebuilds (segment/index) with incremental publication.
    for (const work of expensive) {
      try {
        await this.checkpoint(job, gen);
        if (gen.ready.has(work.plan.doc) || !this.owns(work.token)) continue;
        const prepared = await this.prepareFromText(job, work.plan, work.input, work.token);
        this.gate(job, gen);
        if (!this.owns(work.token)) continue;
        this.progress(job, generation, 'compose', work.plan.doc);
        const committed = await this.commitDocuments(job, gen, [{ prepared, token: work.token }]);
        for (const p of committed) this.writeArtifacts(gen, p);
      } catch (e) {
        if (e === SUPERSEDED) continue;
        if (e === CANCELLED) throw e;
        if (!this.emitTerminalWarmFailure(e, job, generation)) {
          misses.push({ doc: work.plan.doc, need: 'source-bytes', reason: 'rehydrate-failed' });
        }
      }
    }

    // The barrier fires even when everything (or nothing) rehydrated. A doc a
    // concurrent ingest committed OR accepted-in-flight must NOT appear in
    // `missing` — the invariant is "exactly the docs that still need bytes".
    this.gate(job, gen);
    const outstanding = misses.filter((m) => !gen.ready.has(m.doc) && gen.work.get(m.doc)?.accepted === undefined);
    this.emit({
      v: PROTOCOL_VERSION_V4,
      t: 'generation-ready',
      job,
      generation,
      snapshot: gen.snapshot?.id ?? null,
      readyDocs: gen.snapshot === null ? [] : gen.snapshot.docs.map((d) => d.doc),
      missing: outstanding,
    });
  }

  /** Resolve and semantically validate every doc spec once, recomputing all
   *  claimed hashes and enforcing the ingest caps. A caller-provided hash is an
   *  assertion; the recomputed value is the cache key. */
  private async resolvePlans(job: number, gen: GenerationStateV4, docs: readonly GenerationDocSpecV4[]): Promise<void> {
    if (new Set(gen.docs).size !== gen.docs.length) throw new RangeError('duplicate document ids in the generation');
    if (docs.length > this.caps.maxDocsPerProject) {
      throw new CapError(`generation has ${docs.length} documents, over the ${this.caps.maxDocsPerProject} cap`);
    }
    gen.indexRecipeHash = await hashIndexRecipe(gen.indexRecipe);
    this.gate(job, gen);

    let sourceBytesTotal = 0;
    let textUtf16Total = 0;
    for (const spec of docs) {
      const extractionRecipe = await validateExtractionRecipe(spec.extraction.recipe);
      this.gate(job, gen);
      // Recompute each claimed hash, but re-check ownership AFTER the await and
      // BEFORE acting on it — a replaced begin job must never emit a stale error.
      const extractionRecipeHash = await hashExtractionRecipe(extractionRecipe);
      this.gate(job, gen);
      if (extractionRecipeHash !== spec.extraction.recipeHash) {
        throw new RangeError(`document '${spec.doc}' extraction recipeHash does not match its recipe`);
      }
      if (spec.source.format !== extractionRecipe.format) {
        throw new RangeError(`document '${spec.doc}' source format disagrees with its extraction recipe`);
      }
      const structureRecipe = spec.structure.recipe; // narrowed to a valid provisional by parseToWorkerV4
      const structureRecipeHash = await hashStructureRecipe(structureRecipe);
      this.gate(job, gen);
      if (structureRecipeHash !== spec.structure.recipeHash) {
        throw new RangeError(`document '${spec.doc}' structure recipeHash does not match its recipe`);
      }
      if (spec.structure.override.kind === 'active') {
        // The override value was narrowed by parseToWorkerV4; recompute its
        // hash now (base-identity agreement waits until text/candidates exist).
        const overrideHash = await hashStructureOverride(spec.structure.override.value);
        this.gate(job, gen);
        if (overrideHash !== spec.structure.override.hash) {
          throw new RangeError(`document '${spec.doc}' active override hash does not match its value`);
        }
        if (spec.structure.override.value.baseRecipe !== spec.structure.recipeHash) {
          throw new RangeError(`document '${spec.doc}' active override baseRecipe disagrees with the structure recipe`);
        }
      }
      if (spec.source.byteLength > this.caps.maxSourceBytesPerFile) {
        throw new CapError(`document '${spec.doc}' source of ${spec.source.byteLength} bytes exceeds the per-file cap`);
      }
      sourceBytesTotal += spec.source.byteLength;
      // A fresh import has no `expectedTextLengthUtf16` yet, so `byteLength`
      // stands in — a sound bound for byte-decoded/markup formats (txt/md/html)
      // but an UNDERESTIMATE for a compressed epub. This preflight is a
      // best-effort declared-total guard; the AUTHORITATIVE text-cap check runs
      // on the ACTUAL decoded length at ingest (below / at publish), where an
      // over-large doc fails CAP_EXCEEDED and degrades to a missing doc
      // (contract §12.9).
      const declaredTextUtf16 = spec.extraction.expectedTextLengthUtf16 ?? spec.source.byteLength;
      if (declaredTextUtf16 > this.caps.maxTextUtf16PerDoc) {
        throw new CapError(`document '${spec.doc}' declared text exceeds the per-document UTF-16 cap`);
      }
      textUtf16Total += declaredTextUtf16;
      gen.plans.set(spec.doc, {
        spec,
        doc: spec.doc,
        effectiveLocale: effectiveLocale(gen.indexRecipe, spec.language),
        extractionRecipe,
        extractionRecipeHash: spec.extraction.recipeHash,
        structureRecipe,
        structureRecipeHash: spec.structure.recipeHash,
        override: spec.structure.override,
        expectedText: spec.extraction.expectedText,
        expectedCandidates: spec.extraction.expectedCandidates,
        expectedSourceHash: spec.source.expectedHash,
        sourcePersisted: spec.source.availability === 'persisted',
      });
    }
    if (sourceBytesTotal > this.caps.maxProjectSourceBytes) {
      throw new CapError('generation declared source bytes exceed the project cap');
    }
    if (textUtf16Total > this.caps.maxProjectTextUtf16) {
      throw new CapError('generation declared text exceeds the project UTF-16 cap');
    }
  }

  /** Claim a document for a new async task, bumping its epoch so any prior
   *  owner (a warm probe, a slower ingest) loses ownership at its next gate. */
  private claim(gen: GenerationStateV4, doc: string): DocWorkToken {
    const slot = gen.work.get(doc)!;
    slot.epoch += 1;
    return { generation: gen, doc, epoch: slot.epoch };
  }

  private owns(token: DocWorkToken): boolean {
    return this.generation === token.generation && token.generation.work.get(token.doc)?.epoch === token.epoch;
  }

  // -------------------------------------------------------------------------
  // 2. Warm probe / admission
  // -------------------------------------------------------------------------

  /**
   * Classify a document for warm reopen WITHOUT building anything: verify any
   * cached text against its asserted identity, discover the candidate identity
   * (from `expectedCandidates`, a valid extraction record, or a deterministic
   * rescan), and admit any valid cached shard/structure. A structurally valid
   * artifact whose identity contradicts an assertion is a terminal `mismatch`,
   * not corruption — never deleted, never refetched.
   */
  private async probeWarmDocument(job: number, plan: ResolvedDocPlan, token: DocWorkToken): Promise<WarmProbe> {
    const gen = token.generation;
    if (plan.expectedText === undefined) {
      // No text identity to rehydrate from — the only warm source is persisted
      // bytes (re-extracted below); otherwise bytes are required.
      return this.probeFromSource(job, plan, token, 'extraction-miss');
    }
    const read = await this.store.getText(plan.expectedText);
    this.docGate(job, token);
    if (read.kind === 'miss') return this.probeFromSource(job, plan, token, 'extraction-miss');
    if (read.kind === 'corrupt') {
      this.warnStorage('CACHE_CORRUPT', `stored text for '${plan.doc}' is corrupt (${read.reason}); deleted`, gen.generation);
      await this.store.deleteText(plan.expectedText).catch(() => undefined);
      this.docGate(job, token);
      return this.probeFromSource(job, plan, token, 'extraction-miss');
    }
    // The stored text must HASH to its asserted identity — a record under the
    // right key proves nothing about its content. The warm path's ONE text
    // digest: verifyText mints the capability while checking the stored text
    // against the expected hash; every later stage consumes the proof.
    const text = read.value;
    let verified: VerifiedText | null = null;
    try {
      verified = await verifyText(text, plan.expectedText as TextHash);
    } catch {
      verified = null; // ill-formed UTF-16 or a hash mismatch is corruption
    }
    this.docGate(job, token);
    if (verified === null) {
      this.warnStorage('CACHE_CORRUPT', `stored text for '${plan.doc}' does not hash to its key; deleted`, gen.generation);
      await this.store.deleteText(plan.expectedText).catch(() => undefined);
      this.docGate(job, token);
      return this.probeFromSource(job, plan, token, 'extraction-miss');
    }
    const textHash = plan.expectedText;

    // Discover the candidate identity + (when needed) the candidate list.
    const parts: { -readonly [K in keyof AdmittedParts]?: AdmittedParts[K] } = {};
    let candidateHash: string;
    if (plan.expectedCandidates !== undefined) {
      candidateHash = plan.expectedCandidates;
      // A valid cached extraction record can carry the candidate LIST (avoids a
      // rescan when structure must be composed). It is evidence, not required —
      // BUT a genuine extraction whose candidate identity contradicts the
      // asserted `expectedCandidates` is a TERMINAL manifest mismatch, not a
      // reason to fall through and rebuild (which would loop on a byte refetch).
      if (plan.expectedSourceHash !== undefined) {
        const admitted = await this.admitCachedExtraction(job, plan, token, plan.expectedSourceHash, verified);
        if (admitted) {
          if (admitted.artifact.candidateHash !== candidateHash) {
            return { kind: 'mismatch', message: `document '${plan.doc}' extracted candidates do not match the asserted identity` };
          }
          parts.extraction = admitted;
          parts.candidates = { candidates: admitted.artifact.candidates, candidateHash: admitted.artifact.candidateHash };
        }
      }
    } else {
      // No asserted candidate identity — reconstruct it deterministically from
      // the verified text (the current recipes define candidates as a pure
      // function of decoded text + recipe).
      const bundle = await deriveCandidatesFromText(text, plan.extractionRecipe);
      this.docGate(job, token);
      candidateHash = bundle.candidateHash;
      parts.candidates = bundle;
    }

    // Admit a cached structure artifact for the exact identity tuple.
    const { overrideHash } = await this.resolveOverride(plan, textHash, candidateHash);
    this.docGate(job, token);
    const structureKey: StructureCacheKey = {
      schema: 'texttrends/structure/2',
      text: textHash,
      candidates: candidateHash,
      recipe: plan.structureRecipeHash,
      override: overrideHash,
    };
    const structure = await this.admitCachedStructure(job, plan, token, structureKey, text.length);
    if (structure) parts.structure = structure;

    // Admit a cached shard for the full identity tuple.
    const shardKey = await this.shardKeyFor(gen, plan.effectiveLocale, textHash);
    this.docGate(job, token);
    const shard = await this.admitCachedShard(job, plan, token, shardKey, text);
    if (shard) parts.shard = shard;

    // A source-reconstructed recipe (epub/html) CANNOT rebuild its candidates
    // from the joined text. If the candidate list is unavailable (the extraction
    // artifact was not admitted) AND structure still needs composing, re-extract
    // the persisted source rather than fall into prepareFromText's text-only
    // reconstructor, which rejects source recipes (Codex review). With structure
    // admitted the list is not needed, so a text-only prepare is still correct.
    if (
      plan.extractionRecipe.candidateReconstruction === 'source' &&
      parts.candidates === undefined && parts.structure === undefined
    ) {
      return this.probeFromSource(job, plan, token, 'extraction-miss');
    }

    // A text-only path with no candidate list defers the identity check to
    // prepareFromText, which reconstructs candidates and throws a terminal
    // ExtractionMismatchError if they contradict `expectedCandidates`.
    // Cheap = no index rebuild required (the shard was admitted). An exact hit
    // (shard + structure) and a structure-only reconstruction are both cheap.
    return { kind: 'prepare', cheap: parts.shard !== undefined, input: { verified, candidateHash, parts } };
  }

  /** Warm resolution from a PERSISTED source only: re-extract the durable bytes
   *  (never a network fetch), then prepare from the extracted text. A corrupt
   *  durable source is reported and RETAINED (it may be the user's only copy). */
  private async probeFromSource(
    job: number,
    plan: ResolvedDocPlan,
    token: DocWorkToken,
    missReason: WarmMissReasonV4,
  ): Promise<WarmProbe> {
    const gen = token.generation;
    // Not a persisted source (external/bundled) — the client must supply bytes;
    // the reason is why the disposable extraction/text cache could not serve it.
    if (!plan.sourcePersisted || plan.expectedSourceHash === undefined) {
      return { kind: 'needs-bytes', reason: missReason };
    }
    const access = await this.userData();
    this.docGate(job, token);
    // Durable store unavailable — still need bytes, for the disposable reason.
    if (access.kind !== 'ok') return { kind: 'needs-bytes', reason: missReason };
    let read;
    try {
      read = await access.store.getSource(plan.expectedSourceHash);
    } catch {
      return { kind: 'needs-bytes', reason: 'source-not-persisted' };
    }
    this.docGate(job, token);
    if (read.kind === 'miss') return { kind: 'needs-bytes', reason: 'source-miss' };
    if (read.kind === 'corrupt') {
      // Durable damage is CLASS-1 user data needing repair — it is reported
      // through the warm-miss reason (→ the session's SourceRepairReason),
      // NEVER through the artifact-CACHE warning vocabulary, whose contract
      // says "disposable; recompute" (pass-2 Track S2). The record is retained.
      return { kind: 'needs-bytes', reason: 'source-corrupt' };
    }
    // AUTHENTICATE BEFORE EXTRACTING (track-S review): the envelope check
    // proves schema/length only. Hash the stored bytes now, so EVERY content
    // mismatch — including one that would make decoding/parsing fail or blow
    // an extraction cap — reaches the repairable persisted-corrupt path
    // instead of degrading to rehydrate-failed or a terminal error.
    // `rehydrate-failed` is reserved for an AUTHENTIC source the current
    // extractor can no longer reproduce.
    const storedHash = await hashSourceBytes(new Uint8Array(read.value.bytes));
    this.docGate(job, token);
    if (storedHash !== plan.expectedSourceHash) {
      return { kind: 'needs-bytes', reason: 'source-corrupt' };
    }
    // Re-extract the durable bytes as if freshly ingested. A source-dependent
    // (epub/html) recipe re-runs the CONTAINER/markup extractor — the joined
    // text alone cannot rebuild its spine/heading candidates — while a literal
    // recipe decodes. Determinism means the re-extraction reproduces the
    // manifest's TextHash + candidate hash; a mismatch surfaces downstream as
    // EXTRACTION_MISMATCH.
    // Same ONE extraction runtime the cold path uses; only the FAILURE POLICY
    // differs here (warm re-extraction of an already-hash-verified source): a cap
    // becomes a CapError the warm loop maps to CAP_EXCEEDED, while a decode/parse
    // failure downgrades to a byte miss (the warm loop's rehydrate-failed
    // fallback) rather than a terminal error. The afterPhase hook runs this doc's
    // generation/ownership gate at the phase boundary.
    let extracted;
    try {
      extracted = await extractSource(new Uint8Array(read.value.bytes), plan.extractionRecipe, this.extractionLimits(), {
        onPhaseStart: (phase) => this.progress(job, gen.generation, phase, plan.doc),
        afterPhase: () => this.docGate(job, token),
      });
    } catch (e) {
      if (e instanceof ExtractionFailure) {
        if (e.code === 'CAP_EXCEEDED') throw new CapError(`persisted source for '${plan.doc}' extracts past a cap`);
        // Decode/parse failure on a persisted source is NOT terminal — a plain
        // error routes the warm loop to its rehydrate-failed byte-miss fallback.
        throw new Error(`persisted source for '${plan.doc}' failed to re-extract: ${e.message}`);
      }
      throw e; // SUPERSEDED / CANCELLED from the gate
    }
    this.docGate(job, token);
    const identity = { source: extracted.artifact.source, text: extracted.artifact.text, candidates: extracted.artifact.candidateHash };
    // The source bytes were hash-authenticated BEFORE extraction, so a
    // text/candidate drift here is a terminal EXTRACTION_MISMATCH
    // (deterministic re-extraction contradiction), never a byte miss.
    this.assertAssertedIdentity(plan, identity, true);
    // A re-extracted persisted source performed NO main-thread transfer.
    this.freezeAccepted(token, identity, 0);
    this.emitSourceReady(job, gen.generation, plan, extracted);
    const key: ExtractionCacheKey = { schema: 'texttrends/extraction/1', source: extracted.artifact.source, recipe: plan.extractionRecipeHash };
    return {
      kind: 'prepare',
      cheap: false,
      input: {
        verified: extracted.verified,
        candidateHash: extracted.artifact.candidateHash,
        parts: {
          extraction: { artifact: extracted.artifact, key },
          candidates: { candidates: extracted.artifact.candidates, candidateHash: extracted.artifact.candidateHash },
        },
      },
    };
  }

  /** Admit a cached extraction record against its key + the verified text. A
   *  record that fails deep admission is genuinely corrupt storage (its own ABI
   *  is broken, or it does not describe the verified text): warn and repair-
   *  delete the exact record under the document gate. The candidate identity is
   *  then reconstructed from the verified text; a manifest-level candidate
   *  contradiction is judged by the caller, not here. */
  private async admitCachedExtraction(
    job: number,
    plan: ResolvedDocPlan,
    token: DocWorkToken,
    sourceHash: string,
    verified: VerifiedText,
  ): Promise<{ artifact: ExtractionArtifactV1; key: ExtractionCacheKey } | undefined> {
    const key: ExtractionCacheKey = { schema: 'texttrends/extraction/1', source: sourceHash, recipe: plan.extractionRecipeHash };
    const read = await this.store.getExtraction(key);
    this.docGate(job, token);
    if (read.kind === 'miss') return undefined;
    if (read.kind === 'corrupt') {
      this.warnStorage('CACHE_CORRUPT', `cached extraction for '${plan.doc}' failed the envelope check (${read.reason}); deleted`, token.generation.generation);
      await this.store.deleteExtraction(key).catch(() => undefined);
      return undefined;
    }
    try {
      const artifact = await validateExtractionArtifactVerified(read.value, key, plan.extractionRecipe, verified);
      return { artifact, key };
    } catch (e) {
      // Ownership FIRST — a supersession during deep admission must not warn or
      // delete a record the new owner may have replaced.
      this.docGate(job, token);
      this.warnStorage('CACHE_CORRUPT', `cached extraction for '${plan.doc}' failed deep admission (${e instanceof Error ? e.message : String(e)}); deleted`, token.generation.generation);
      await this.store.deleteExtraction(key).catch(() => undefined);
      return undefined;
    }
  }

  /** Admit a cached structure artifact for the exact key against the text length. */
  private async admitCachedStructure(
    job: number,
    plan: ResolvedDocPlan,
    token: DocWorkToken,
    key: StructureCacheKey,
    textLength: number,
  ): Promise<StructureArtifactV2 | undefined> {
    const read = await this.store.getStructure(key);
    this.docGate(job, token);
    if (read.kind === 'miss') return undefined;
    if (read.kind === 'corrupt') {
      this.warnStorage('CACHE_CORRUPT', `cached structure for '${plan.doc}' failed the envelope check (${read.reason}); deleted`, token.generation.generation);
      await this.store.deleteStructure(key).catch(() => undefined);
      return undefined;
    }
    try {
      return await validateStructureArtifactV2(read.value, { text: key.text, candidates: key.candidates, recipe: key.recipe, override: key.override }, textLength);
    } catch (e) {
      // Ownership FIRST — a supersession during the (awaited) deep admission
      // must not warn or delete a record the new owner may have replaced.
      this.docGate(job, token);
      this.warnStorage('CACHE_CORRUPT', `cached structure for '${plan.doc}' failed deep admission (${e instanceof Error ? e.message : String(e)}); deleted`, token.generation.generation);
      await this.store.deleteStructure(key).catch(() => undefined);
      return undefined;
    }
  }

  /** Admit a cached shard: verify the full ABI, identity tuple, and that
   *  resident geometry fits THIS verified text (in-domain spans can still point
   *  past its end). Failure reports, deletes the exact record, and returns
   *  undefined so the caller rebuilds. */
  private async admitCachedShard(
    job: number,
    plan: ResolvedDocPlan,
    token: DocWorkToken,
    key: DocumentIndexCacheKey,
    text: string,
  ): Promise<DocumentIndexV1 | undefined> {
    const read = await this.store.getShard(key);
    this.docGate(job, token);
    if (read.kind === 'miss') return undefined;
    if (read.kind === 'corrupt') {
      this.warnStorage('CACHE_CORRUPT', `cached shard for '${plan.doc}' failed the envelope check (${read.reason}); rebuilding`, token.generation.generation);
      await this.store.deleteShard(key).catch(() => undefined);
      return undefined;
    }
    try {
      const candidate = read.value as DocumentIndexV1;
      validateShardStructure(candidate);
      const n = candidate.tokenTypeIds.length;
      if (n > 0 && tokenEndChar(candidate, n - 1) > text.length) {
        throw new RangeError('resident token spans exceed the verified text length');
      }
      const hitSegmenter = await hashSegmenterFingerprint(candidate.segmenter);
      if (candidate.text !== key.text || candidate.recipe !== key.recipe || hitSegmenter !== key.segmenter) {
        throw new RangeError('cached shard does not match its key');
      }
      return candidate;
    } catch (e) {
      // Ownership FIRST — the segmenter-hash await above could have overlapped a
      // supersession; a stale owner must not warn or delete the new owner's write.
      this.docGate(job, token);
      this.warnStorage('CACHE_CORRUPT', `cached shard for '${plan.doc}' failed verification (${e instanceof Error ? e.message : String(e)}); rebuilding`, token.generation.generation);
      await this.store.deleteShard(key).catch(() => undefined);
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // 3. Text preparation / build
  // -------------------------------------------------------------------------

  /**
   * Build the remaining artifacts for a verified text: the shard (segment +
   * index) if not admitted, and the structure (compose) if not admitted,
   * deriving candidates on demand for a text-only path. Emits only the phases
   * whose work it actually performs. Returns a fully prepared document plus the
   * disposable cache keys to persist AFTER it commits.
   */
  private async prepareFromText(job: number, plan: ResolvedDocPlan, input: PrepareInput, token: DocWorkToken): Promise<PreparedDocument> {
    const gen = token.generation;
    const { verified, candidateHash } = input;
    const text = verifiedTextOf(verified);
    const textHash: string = verifiedHashOf(verified);

    // Shard — built through the VERIFIED lanes: the capability's proof is the
    // text identity, so no pipeline stage re-digests the text.
    const shardKey = await this.shardKeyFor(gen, plan.effectiveLocale, textHash);
    this.docGate(job, token);
    let shard = input.parts.shard;
    if (!shard) {
      this.progress(job, gen.generation, 'segment', plan.doc);
      const batch = await segmentVerified(verified, plan.effectiveLocale);
      await this.docCheckpoint(job, token);
      this.progress(job, gen.generation, 'index', plan.doc);
      shard = await createDocumentIndexVerified(verified, batch, gen.indexRecipe);
      await this.docCheckpoint(job, token);
    }

    // Structure.
    const { override, overrideHash } = await this.resolveOverride(plan, textHash, candidateHash);
    this.docGate(job, token);
    const structureKey: StructureCacheKey = {
      schema: 'texttrends/structure/2',
      text: textHash,
      candidates: candidateHash,
      recipe: plan.structureRecipeHash,
      override: overrideHash,
    };
    let structure = input.parts.structure;
    if (!structure) {
      let candidates = input.parts.candidates;
      if (!candidates) {
        // A text-only path with no candidate list: reconstruct it (honest
        // `extract` work) and hold it to the asserted identity.
        this.progress(job, gen.generation, 'extract', plan.doc);
        candidates = await deriveCandidatesFromText(text, plan.extractionRecipe);
        await this.docCheckpoint(job, token);
        if (candidates.candidateHash !== candidateHash) {
          throw new ExtractionMismatchError(`document '${plan.doc}' reconstructed candidates do not match the asserted identity`);
        }
      }
      this.progress(job, gen.generation, 'structure', plan.doc);
      structure = composeStructure(text, candidates.candidates, plan.structureRecipe, override, {
        text: textHash,
        candidates: candidateHash,
        recipe: plan.structureRecipeHash,
        override: overrideHash,
      });
    }

    const ready = await makeReadyDocument(plan.doc as Parameters<typeof makeReadyDocument>[0], shard, structure);
    this.docGate(job, token);
    return {
      doc: plan.doc,
      text,
      verified,
      ready,
      shard,
      shardKey,
      structureKey,
      structureArtifact: structure,
      extraction: input.parts.extraction,
    };
  }

  /** Resolve the effective override + its hash once text/candidate identities
   *  are known. `none` derives the canonical empty override; `active` verifies
   *  its base identities agree with the now-known text/candidates. */
  private async resolveOverride(plan: ResolvedDocPlan, textHash: string, candidateHash: string): Promise<{ override: StructureOverrideV1; overrideHash: string }> {
    if (plan.override.kind === 'none') {
      const override = emptyOverride(textHash, candidateHash, plan.structureRecipeHash);
      return { override, overrideHash: await hashStructureOverride(override) };
    }
    const value = plan.override.value;
    if (value.text !== textHash || value.candidates !== candidateHash || value.baseRecipe !== plan.structureRecipeHash) {
      throw new RangeError(`document '${plan.doc}' active override base identities do not match the extracted text/candidates`);
    }
    return { override: value, overrideHash: plan.override.hash };
  }

  private async shardKeyFor(gen: GenerationStateV4, language: string, textHash: string): Promise<DocumentIndexCacheKey> {
    if (gen.indexRecipeHash === null) gen.indexRecipeHash = await hashIndexRecipe(gen.indexRecipe);
    let segmenter = gen.segmenterHashes.get(language);
    if (segmenter === undefined) {
      segmenter = await hashSegmenterFingerprint(await fingerprint(language));
      gen.segmenterHashes.set(language, segmenter);
    }
    return { schema: 'texttrends/document-index/1', text: textHash, recipe: gen.indexRecipeHash, segmenter };
  }

  /**
   * Freeze the first accepted source/text/candidate identity for a document
   * (a later same-generation attempt with a DIFFERENT identity is rejected —
   * it must not change what the document means in place) AND, atomically, charge
   * its transferred source bytes against the project transfer cap. This runs
   * SYNCHRONOUSLY (no await since the document was claimed), so two interleaved
   * ingests cannot both observe a pre-charge total and both slip the cap — the
   * second sees the first's charge. `transferredBytes` is 0 for a warm re-
   * extraction of a persisted source (no main-thread transfer occurred). An
   * idempotent re-accept of the SAME identity returns false and re-charges
   * nothing. Throws CapError if the charge would cross the project cap.
   */
  private freezeAccepted(token: DocWorkToken, identity: AcceptedIdentity, transferredBytes: number): boolean {
    const slot = token.generation.work.get(token.doc)!;
    if (slot.accepted) {
      // Compare the FULL identity including source — two byte streams that
      // decode to identical text (e.g. UTF-8 with and without a BOM) still have
      // different source bytes and must not silently replace one another.
      if (slot.accepted.source !== identity.source || slot.accepted.text !== identity.text || slot.accepted.candidates !== identity.candidates) {
        throw new IdentityConflictError(`document '${token.doc}' was already accepted with a different identity in this generation`);
      }
      return false; // idempotent re-accept of the same identity — no re-charge
    }
    const gen = token.generation;
    if (gen.transferredSourceBytes + transferredBytes > this.caps.maxProjectSourceBytes) {
      throw new CapError(`document '${token.doc}' would exceed the project source-byte cap`);
    }
    slot.accepted = identity;
    gen.transferredSourceBytes += transferredBytes;
    return true;
  }

  /** A delivered/extracted identity must agree with any asserted expectation.
   *  `sourceVerified` is true on a WARM re-extraction from persisted bytes,
   *  where the source hash has ALREADY matched its key. There, a text/candidate
   *  drift is extraction nondeterminism / recipe drift — a terminal
   *  EXTRACTION_MISMATCH — NOT a different source (Codex review). On a COLD
   *  ingest of fresh user bytes, a text drift means wrong bytes → SOURCE_MISMATCH. */
  private assertAssertedIdentity(plan: ResolvedDocPlan, identity: AcceptedIdentity, sourceVerified: boolean): void {
    if (plan.expectedSourceHash !== undefined && identity.source !== undefined && identity.source !== plan.expectedSourceHash) {
      throw new SourceMismatchError(`document '${plan.doc}' source hashed to ${identity.source.slice(0, 16)}… but the generation asserted ${plan.expectedSourceHash.slice(0, 16)}…`);
    }
    if (plan.expectedText !== undefined && identity.text !== plan.expectedText) {
      const message = `document '${plan.doc}' text hashed to ${identity.text.slice(0, 16)}… but the generation asserted ${plan.expectedText.slice(0, 16)}…`;
      throw sourceVerified ? new ExtractionMismatchError(message) : new SourceMismatchError(message);
    }
    if (plan.expectedCandidates !== undefined && identity.candidates !== plan.expectedCandidates) {
      throw new ExtractionMismatchError(`document '${plan.doc}' candidates hashed to ${identity.candidates.slice(0, 16)}… but the generation asserted ${plan.expectedCandidates.slice(0, 16)}…`);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Cold ingest
  // -------------------------------------------------------------------------

  private async ingest(job: number, generation: string, doc: string, bytes: ArrayBuffer): Promise<void> {
    const gen = this.generation;
    if (!gen || gen.generation !== generation) {
      this.emitError('GENERATION_STALE', { job, generation, message: 'unknown or replaced generation', recoverable: true });
      return;
    }
    const plan = gen.plans.get(doc);
    if (!plan) {
      this.emitError('PARSE_FAILED', { job, generation, message: `document '${doc}' is not in this generation`, recoverable: true });
      return;
    }
    if (bytes.byteLength > this.caps.maxSourceBytesPerFile) {
      this.emitError('CAP_EXCEEDED', { job, generation, message: `document '${doc}' source of ${bytes.byteLength} bytes exceeds the per-file cap`, recoverable: true });
      return;
    }
    // Claim the document — supersede any warm probe or slower ingest. The ACTUAL
    // aggregate source/text caps are enforced atomically at freeze (transfer
    // bytes) and in the single commit path (resident text), so an interleaved
    // pair of under-declared ingests cannot both slip the project caps.
    const token = this.claim(gen, doc);

    // ONE extraction runtime (literal decode→finalize or transformed adapter),
    // with progress phases and the per-document cap folded in; the afterPhase
    // hook runs this doc's ownership gate at the phase boundary so a cancel or
    // supersession during extraction aborts cleanly (throws, caught below).
    let extracted;
    try {
      extracted = await extractSource(new Uint8Array(bytes), plan.extractionRecipe, this.extractionLimits(), {
        onPhaseStart: (phase) => this.progress(job, generation, phase, doc),
        afterPhase: () => this.docGate(job, token),
      });
    } catch (e) {
      if (e instanceof ExtractionFailure) {
        // Re-check ownership after the async failure: a cancel/supersession must
        // surface as cancelled/superseded, never as a domain error.
        this.docGate(job, token);
        this.emitError(e.code, { job, generation, message: e.message, recoverable: true });
        return;
      }
      throw e; // SUPERSEDED / CANCELLED from the gate, or an internal fault
    }
    this.docGate(job, token);

    const identity = { source: extracted.artifact.source, text: extracted.artifact.text, candidates: extracted.artifact.candidateHash };
    // Assert against declared identities BEFORE freezing/emitting, then freeze —
    // a second same-generation ingest with different bytes is rejected, and the
    // transferred bytes are charged atomically against the project transfer cap.
    // Cold ingest of fresh bytes: a text mismatch means wrong bytes (SOURCE_MISMATCH).
    this.assertAssertedIdentity(plan, identity, false);
    this.freezeAccepted(token, identity, bytes.byteLength);
    this.emitSourceReady(job, generation, plan, extracted);

    const key: ExtractionCacheKey = { schema: 'texttrends/extraction/1', source: extracted.artifact.source, recipe: plan.extractionRecipeHash };
    const prepared = await this.prepareFromText(job, plan, {
      verified: extracted.verified,
      candidateHash: extracted.artifact.candidateHash,
      parts: {
        extraction: { artifact: extracted.artifact, key },
        candidates: { candidates: extracted.artifact.candidates, candidateHash: extracted.artifact.candidateHash },
      },
    }, token);
    this.docGate(job, token);
    this.progress(job, generation, 'compose', doc);
    const committed = await this.commitDocuments(job, gen, [{ prepared, token }]);
    for (const p of committed) this.writeArtifacts(gen, p);
  }

  private emitSourceReady(job: number, generation: string, plan: ResolvedDocPlan, extracted: { artifact: ExtractionArtifactV1 }): void {
    const a = extracted.artifact;
    // The artifact descriptor IS the wire descriptor (the wire emits core's
    // SourceDescriptorV1) — emit it as-is, no re-shaping.
    const source: SourceDescriptorV1 = a.descriptor;
    this.emit({
      v: PROTOCOL_VERSION_V4,
      t: 'source-ready',
      job,
      generation,
      doc: plan.doc,
      source,
      extractionRecipe: plan.extractionRecipeHash,
      text: a.text,
      textLengthUtf16: a.textLengthUtf16,
      candidates: a.candidateHash,
      decoderReplacementCount: a.evidence.decoderReplacementCount,
      suspiciousControlCount: a.evidence.suspiciousControlCount,
    });
  }

  // -------------------------------------------------------------------------
  // 5. Serialized composition / publication
  // -------------------------------------------------------------------------

  /**
   * The single publication path (ingest AND warm reopen): serialized through
   * the composition mutex. Candidate documents whose token is no longer owned
   * are discarded; if a candidate is superseded WHILE composing (an ingest
   * bumped its epoch), the staged snapshot is discarded and recomposed around
   * the still-owned candidates — a stale item can never be filtered out AFTER a
   * snapshot was composed around it.
   */
  private commitDocuments(job: number, gen: GenerationStateV4, items: readonly { prepared: PreparedDocument; token: DocWorkToken }[]): Promise<readonly PreparedDocument[]> {
    const run = this.composing.then<readonly PreparedDocument[]>(async () => {
      this.gate(job, gen);
      // Recompose loop: converges because each iteration drops at least one
      // superseded candidate, and a candidate never re-enters.
      for (;;) {
        const owned = items.filter((i) => this.owns(i.token));
        if (owned.length === 0) return []; // nothing left to publish
        const stagedBase = gen.publicationEpoch;

        // ACTUAL project text (memory) cap on the SHARED publication path — the
        // one place ALL resident text (cold, warm, persisted) passes, and it is
        // synchronous under the composition mutex, so the total is authoritative
        // and race-free. Select the fitting subset in DECLARED order: the
        // document that crosses the cumulative limit fails while prior (and
        // already-committed) documents stand (§12.9 crossing-document rule).
        const ownedByDoc = new Map(owned.map((i) => [i.prepared.doc, i]));
        let running = 0;
        for (const [id, vt] of gen.texts) if (!ownedByDoc.has(id)) running += verifiedTextOf(vt).length;
        const included: { prepared: PreparedDocument; token: DocWorkToken }[] = [];
        const rejected: string[] = [];
        for (const doc of gen.docs) {
          const item = ownedByDoc.get(doc);
          if (!item) continue;
          if (running + item.prepared.text.length > this.caps.maxProjectTextUtf16) {
            rejected.push(doc);
            continue; // a later, smaller document may still fit
          }
          running += item.prepared.text.length;
          included.push(item);
        }
        if (included.length === 0) {
          for (const doc of rejected) this.emitError('CAP_EXCEEDED', { job, generation: gen.generation, message: `document '${doc}' would exceed the project text cap`, recoverable: true });
          return [];
        }

        const nextReady = new Map(gen.ready);
        const nextTexts = new Map(gen.texts);
        for (const item of included) {
          nextReady.set(item.prepared.doc, item.prepared.ready);
          nextTexts.set(item.prepared.doc, item.prepared.verified);
        }
        const expected = gen.docs;
        const snapshot = await composeSnapshot(
          gen.generation as Parameters<typeof composeSnapshot>[0],
          expected as unknown as Parameters<typeof composeSnapshot>[1],
          nextReady as unknown as Parameters<typeof composeSnapshot>[2],
        );
        const shards = new Map<string, DocumentIndexV1>();
        for (const [id, r] of nextReady) shards.set(id, r.shard);
        // Generation-scoped incremental binding (D1): unchanged per-doc clone/
        // ABI-validation for documents this generation has not bound before
        // (keyed by source-object identity + expected descriptor hash), reuse
        // of the already-owned clones otherwise. The full cross-artifact
        // validateSnapshot pass still runs for every composed snapshot.
        const bound = await bindShardsIncremental(gen.binding, snapshot, shards);
        // The verified binding path: proofs minted at extraction / stored-text
        // admission — no per-commit re-digest of resident texts. Cheap per
        // publication post-D2 (per doc: WeakMap proof lookup, hash string
        // compare, O(1) geometry bound) — no session caching needed for texts.
        const boundTexts = await bindTextsVerified(snapshot, bound, nextTexts);

        // SYNCHRONOUS commit gate: recheck job, generation, the staged base,
        // and EVERY currently-owned candidate token — INCLUDING cap-rejected
        // ones. If a concurrent ingest claimed a rejected document during
        // composition, recompose: the next iteration drops that token before
        // reselecting, so a stale owner never emits a duplicate CAP_EXCEEDED for
        // a document the live ingest now owns.
        this.gate(job, gen);
        if (gen.publicationEpoch !== stagedBase || owned.some((i) => !this.owns(i.token))) {
          continue; // recompose around whatever is still owned
        }
        gen.ready = nextReady;
        gen.texts = nextTexts;
        gen.snapshot = snapshot;
        gen.bound = bound;
        gen.boundTexts = boundTexts;
        gen.publicationEpoch += 1;
        // Hand the executor the fresh read-only view; committed documents
        // drop their resolver maps (a retained map holds resolvers bound to
        // a replaced shard).
        gen.executor.publish(
          { snapshot, ready: nextReady, bound, boundTexts },
          included.map((i) => i.prepared.doc),
        );
        this.emit({
          v: PROTOCOL_VERSION_V4,
          t: 'snapshot-published',
          generation: gen.generation,
          snapshot: snapshot.id,
          readyDocs: snapshot.docs.map((d) => d.doc),
          missingDocs: snapshot.missingDocs,
        });
        // Report the crossing document(s) ONCE, after the surviving subset has
        // committed (never on a recompose that will be retried).
        for (const doc of rejected) this.emitError('CAP_EXCEEDED', { job, generation: gen.generation, message: `document '${doc}' would exceed the project text cap`, recoverable: true });
        // Only the documents that ACTUALLY committed may have their disposable
        // artifacts persisted — a candidate dropped during composition or by the
        // cap must not leave cache records for an unpublished build.
        return included.map((i) => i.prepared);
      }
    });
    this.composing = run.catch(() => []);
    return run;
  }

  /** Best-effort disposable cache writes AFTER a document has passed the commit
   *  gate — a cancelled half-pipeline must never look like a completed build. */
  private writeArtifacts(gen: GenerationStateV4, prepared: PreparedDocument): void {
    const writes: Promise<unknown>[] = [
      this.store.putText(prepared.ready.shard.text, prepared.text),
      this.store.putShard(prepared.shardKey, prepared.shard),
      this.store.putStructure(prepared.structureKey, prepared.structureArtifact),
    ];
    // Only persist a COMPLETE extraction artifact from a real source extraction
    // — never fabricate one from a text-only candidate reconstruction.
    if (prepared.extraction) writes.push(this.store.putExtraction(prepared.extraction.key, prepared.extraction.artifact));
    void Promise.all(writes).catch(() => {
      // A write that fails after the generation was replaced must not emit a
      // warning attributed to the current (different) generation.
      if (this.generation === gen) this.warnStorage('CACHE_WRITE_FAILED', 'cache write failed (results unaffected)', gen.generation);
    });
  }

  // -------------------------------------------------------------------------
  // 6. Queries / resolver caches
  // -------------------------------------------------------------------------

  private async queryCheckpoint(job: number, gen: GenerationStateV4, snapshotId: string): Promise<void> {
    await this.yieldControl();
    this.queryGate(job, gen, snapshotId);
  }

  private queryGate(job: number, gen: GenerationStateV4, snapshotId: string): void {
    if (this.cancelledJobs.has(job)) {
      this.emit({ v: PROTOCOL_VERSION_V4, t: 'cancelled', job });
      throw CANCELLED;
    }
    if (this.generation !== gen || gen.snapshot?.id !== snapshotId) {
      this.emitError('SNAPSHOT_UNKNOWN', { job, message: 'query is bound to an unknown or superseded snapshot', recoverable: true });
      throw CANCELLED;
    }
  }

  private async query(job: number, snapshotId: string, q: QueryOpV4): Promise<void> {
    const gen = this.generation;
    if (!gen?.snapshot || gen.snapshot.id !== snapshotId || !gen.bound || !gen.boundTexts) {
      this.emitError('SNAPSHOT_UNKNOWN', { job, message: 'query is bound to an unknown or superseded snapshot', recoverable: true });
      return;
    }
    const snapshot = gen.snapshot;

    if (q.op === 'structure') {
      await this.queryStructure(job, gen, snapshot, q.request.doc);
      return;
    }

    if (q.op === 'structure-edit-context') {
      await this.queryStructureEditContext(job, gen, snapshot, q.request.doc);
      return;
    }

    if (q.op === 'line-excerpt') {
      this.queryLineExcerpt(job, gen, snapshot, q.request.doc, q.request.anchor, q.request.maxChars);
      return;
    }

    // The generation-bound executor runs the analysis ops (slice-2 ruling §B);
    // this engine keeps job ownership, the injected checkpoint (yield + gate),
    // and a FINAL gate immediately before every emit.
    const checkpoint = () => this.queryCheckpoint(job, gen, snapshotId);

    if (q.op === 'passage') {
      const passage = await gen.executor.passage(q.request, checkpoint);
      this.queryGate(job, gen, snapshotId);
      this.emit({ v: PROTOCOL_VERSION_V4, t: 'result', job, snapshot: snapshot.id, data: { op: 'passage', passage } });
      return;
    }

    if (q.op === 'reader-page') {
      // Like passage, the reader is a CONTEXT surface rather than an
      // analytical-detail selection consumer. The wire has no selection
      // degree of freedom: build the canonical base selection here so a
      // linked range can never silently filter reader marks.
      const selection = await resolveSelection(snapshot, {
        docs: snapshot.docs.map((d) => d.doc),
      });
      await this.queryCheckpoint(job, gen, snapshotId);
      const page = await gen.executor.readerPage(
        selection,
        q.tracks,
        { doc: q.request.doc, cursor: q.request.cursor, maxTokens: q.request.maxTokens },
        checkpoint,
      );
      this.queryGate(job, gen, snapshotId);
      this.emit({
        v: PROTOCOL_VERSION_V4, t: 'result', job, snapshot: snapshot.id,
        data: {
          op: 'reader-page',
          page: {
            method: 'reader-page/1',
            doc: page.doc, tokens: page.tokens, docCharsUtf16: page.docCharsUtf16,
            text: page.text,
            tokenStartsUtf16: page.tokenStartsUtf16, tokenEndsUtf16: page.tokenEndsUtf16,
            anchor: page.anchor, previous: page.previous, next: page.next,
            atStart: page.atStart, atEnd: page.atEnd, docTokenCount: page.docTokenCount,
            cappedBy: page.cappedBy, marks: page.marks, marksTruncated: page.marksTruncated,
          },
        },
      });
      return;
    }

    if (q.op === 'tfidf-sections') {
      const sections = await this.analysisSectionInputs(
        job,
        gen,
        snapshot,
        q.request.doc,
        'TF-IDF query',
      );
      if (!sections) return;
      await checkpoint();
      const tfidf = await gen.executor.tfidfSections(
        q.request,
        sections,
        checkpoint,
      );
      this.queryGate(job, gen, snapshotId);
      this.emit({
        v: PROTOCOL_VERSION_V4,
        t: 'result',
        job,
        snapshot: snapshot.id,
        data: { op: 'tfidf-sections', tfidf },
      });
      return;
    }

    if (q.op === 'keyness') {
      let selectionA;
      let selectionB;
      try {
        selectionA = await resolveSelection(
          snapshot,
          q.request.a as Parameters<typeof resolveSelection>[1],
        );
        selectionB = await resolveSelection(
          snapshot,
          q.request.b as Parameters<typeof resolveSelection>[1],
        );
      } catch (e) {
        this.emitError('SELECTION_INVALID', {
          job,
          message: e instanceof Error ? e.message : String(e),
          recoverable: true,
        });
        return;
      }
      const overlap = firstSelectionOverlap(snapshot, selectionA, selectionB);
      if (overlap !== null) {
        this.emitError('SELECTION_INVALID', {
          job,
          message: `keyness sides overlap in document '${overlap}'`,
          recoverable: true,
        });
        return;
      }
      await this.queryCheckpoint(job, gen, snapshotId);
      const { a: _a, b: _b, ...request } = q.request;
      const keyness = await gen.executor.keyness(
        selectionA,
        selectionB,
        request,
        checkpoint,
      );
      this.queryGate(job, gen, snapshotId);
      this.emit({
        v: PROTOCOL_VERSION_V4,
        t: 'result',
        job,
        snapshot: snapshot.id,
        data: { op: 'keyness', keyness },
      });
      return;
    }

    let selection;
    try {
      selection = await resolveSelection(snapshot, q.selection as Parameters<typeof resolveSelection>[1]);
    } catch (e) {
      this.emitError('SELECTION_INVALID', { job, message: e instanceof Error ? e.message : String(e), recoverable: true });
      return;
    }
    await this.queryCheckpoint(job, gen, snapshotId);

    if (q.op === 'trend') {
      const data = await gen.executor.trend(selection, q.group, q.request, checkpoint);
      this.queryGate(job, gen, snapshotId);
      this.emit({ v: PROTOCOL_VERSION_V4, t: 'result', job, snapshot: snapshot.id, data: { op: 'trend', trend: data } }, trendTransferList(data));
      return;
    }

    if (q.op === 'dispersion') {
      const dispersion = await gen.executor.dispersion(selection, q.tracks, checkpoint);
      this.queryGate(job, gen, snapshotId);
      this.emit(
        { v: PROTOCOL_VERSION_V4, t: 'result', job, snapshot: snapshot.id, data: { op: 'dispersion', dispersion } },
        dispersionTransferBuffers(dispersion),
      );
      return;
    }

    if (q.op === 'inventory') {
      const sections: InventorySectionInputV1[] = [];
      if (q.request.sections) {
        for (const doc of selection.spec.docs) {
          const rows = await this.analysisSectionInputs(
            job,
            gen,
            snapshot,
            doc,
            'inventory query',
          );
          if (!rows) return;
          // Keep at most cap+1 inputs: core uses the sentinel row to disclose
          // truncation, while the engine stops hashing/binding later docs.
          const remaining = INVENTORY_MAX_SECTIONS + 1 - sections.length;
          sections.push(...rows.slice(0, remaining));
          await checkpoint();
          if (sections.length > INVENTORY_MAX_SECTIONS) break;
        }
      }
      const data = await gen.executor.inventory(
        selection,
        q.request,
        sections,
        checkpoint,
      );
      this.queryGate(job, gen, snapshotId);
      this.emit(
        {
          v: PROTOCOL_VERSION_V4,
          t: 'result',
          job,
          snapshot: snapshot.id,
          data: { op: 'inventory', inventory: data },
        },
        inventoryTransferBuffers(data),
      );
      return;
    }

    if (q.op === 'freq-list') {
      const frequency = await gen.executor.frequencyList(
        selection,
        q.request,
        checkpoint,
      );
      this.queryGate(job, gen, snapshotId);
      this.emit({
        v: PROTOCOL_VERSION_V4,
        t: 'result',
        job,
        snapshot: snapshot.id,
        data: { op: 'freq-list', frequency },
      });
      return;
    }

    const { total, rows } = await gen.executor.kwic(selection, q.tracks, q.request, checkpoint);
    this.queryGate(job, gen, snapshotId);
    this.emit({ v: PROTOCOL_VERSION_V4, t: 'result', job, snapshot: snapshot.id, data: { op: 'kwic', total, rows } });
  }

  /**
   * Resolve a structure-bearing document for a snapshot-bound query: the
   * snapshot ref, the resident ready document (whose identities must still be
   * the ones the ref names), and its V2 artifact. Emits the appropriate typed
   * error and returns null when the binding cannot be served — the ONE copy of
   * this correctness-sensitive prologue for both structure queries.
   */
  private resolveStructureDoc(
    job: number,
    gen: GenerationStateV4,
    snapshot: CorpusSnapshotV1,
    doc: string,
    what: string,
  ): { ref: CorpusSnapshotV1['docs'][number]; ready: ReadyDocument; artifact: StructureArtifactV2 } | null {
    const ref = snapshot.docs.find((r) => r.doc === doc);
    if (!ref) {
      this.emitError('REQUEST_INVALID', { job, message: `'${doc}' is not a member of the snapshot`, recoverable: true });
      return null;
    }
    const ready = gen.ready.get(doc);
    if (!ready) throw new DependencyError('shard', doc);
    // The resident document must still be the one the snapshot ref names.
    if (ready.index !== ref.index || ready.structure !== ref.structure) {
      this.emitError('SNAPSHOT_UNKNOWN', { job, message: `${what} is bound to a superseded document`, recoverable: true });
      return null;
    }
    const artifact = ready.structureArtifact;
    if (artifact.schema !== 'texttrends/structure/2') {
      this.emitError('REQUEST_INVALID', { job, message: `document '${doc}' has no chapter structure`, recoverable: true });
      return null;
    }
    return { ref, ready, artifact };
  }

  /** The memoized token-range projection for a resolved structure doc. */
  private tokenRangesFor(
    gen: GenerationStateV4,
    ref: CorpusSnapshotV1['docs'][number],
    ready: ReadyDocument,
    artifact: StructureArtifactV2,
  ): readonly TokenRange[] {
    const viewKey = tokenViewKey(ref.structure, ref.index);
    let ranges = gen.tokenViews.get(viewKey);
    if (!ranges) {
      ranges = projectSections(artifact.sections, ready.shard.startsUtf16);
      gen.tokenViews.set(viewKey, ranges);
    }
    return ranges;
  }

  /** The (doc, lineageKey) → SectionId binding, memoized on `gen.sectionIds`
   *  (see the field's contract). The pending promise is installed BEFORE any
   *  await so overlapping structure/edit-context queries share one digest. */
  private cachedSectionId(gen: GenerationStateV4, doc: string, lineageKey: string): Promise<string> {
    let byKey = gen.sectionIds.get(doc);
    if (!byKey) {
      byKey = new Map();
      gen.sectionIds.set(doc, byKey);
    }
    const hit = byKey.get(lineageKey);
    if (hit) return hit;
    const scope = byKey;
    const pending: Promise<string> = bindSectionId(doc, lineageKey).catch((e: unknown) => {
      // Evict ONLY this promise so a later request retries; a concurrent
      // replacement (installed after this one was evicted) must survive.
      if (scope.get(lineageKey) === pending) scope.delete(lineageKey);
      throw e;
    });
    scope.set(lineageKey, pending);
    return pending;
  }

  /** Bind lineage keys → project-scoped SectionIds and materialize the keyed
   *  section rows (parents translated). All missing bindings are launched in
   *  parallel (ruling D4: ~345 ms sequential vs ~35 ms parallel at the 2,048
   *  section cap; WebCrypto schedules its own work — no concurrency bound).
   *  Gates after the awaited bindings; the caller gates again before emitting. */
  private async bindSectionRows(
    job: number,
    gen: GenerationStateV4,
    snapshotId: string,
    doc: string,
    artifact: StructureArtifactV2,
    ranges: readonly TokenRange[],
  ): Promise<{ key: string; section: WireSection; tokens: TokenRange }[]> {
    const ids = await Promise.all(artifact.sections.map((s) => this.cachedSectionId(gen, doc, s.key)));
    const idByKey = new Map<string, string>();
    artifact.sections.forEach((s, i) => idByKey.set(s.key, ids[i]!));
    this.queryGate(job, gen, snapshotId);
    return artifact.sections.map((s, i) => ({
      key: s.key,
      section: {
        id: idByKey.get(s.key)!,
        doc,
        origin: s.origin,
        ...(s.parent === undefined ? {} : { parent: idByKey.get(s.parent)! }),
        level: s.level,
        ...(s.title === undefined ? {} : { title: s.title }),
        chars: { start: s.chars.start, end: s.chars.end },
      },
      tokens: ranges[i]!,
    }));
  }

  /** Project a structure into the shared section-input shape consumed by the
   * vocabulary-wide inventory and selection-independent TF-IDF operations. */
  private async analysisSectionInputs(
    job: number,
    gen: GenerationStateV4,
    snapshot: CorpusSnapshotV1,
    doc: string,
    what: string,
  ): Promise<InventorySectionInputV1[] | null> {
    const resolved = this.resolveStructureDoc(job, gen, snapshot, doc, what);
    if (!resolved) return null;
    const { ref, ready, artifact } = resolved;
    const ranges = this.tokenRangesFor(gen, ref, ready, artifact);
    const rows = await this.bindSectionRows(
      job,
      gen,
      snapshot.id,
      doc,
      artifact,
      ranges,
    );
    return rows.map((row) => ({
      id: row.section.id,
      doc,
      level: row.section.level,
      ...(row.section.title === undefined ? {} : { title: row.section.title }),
      tokens: row.tokens,
    }));
  }

  /**
   * The snapshot-bound structure query (§12.7, engine-v4 consult §Q5.4). Bound
   * to the current snapshot OBJECT — a successful generation gate alone is
   * insufficient because an incremental publication can supersede the snapshot
   * within the same generation. Requires the ready document's identities to
   * still equal the snapshot ref's, projects sections to token ranges (cached
   * doc-independently by [StructureHash, IndexArtifactHash]), binds section ids
   * deterministically from doc + lineage key, and echoes both bound identities.
   */
  private async queryStructure(job: number, gen: GenerationStateV4, snapshot: CorpusSnapshotV1, doc: string): Promise<void> {
    const resolved = this.resolveStructureDoc(job, gen, snapshot, doc, 'structure query');
    if (!resolved) return;
    const { ref, ready, artifact } = resolved;
    const ranges = this.tokenRangesFor(gen, ref, ready, artifact);
    await this.queryCheckpoint(job, gen, snapshot.id);

    const keyed = await this.bindSectionRows(job, gen, snapshot.id, doc, artifact, ranges);
    const rows = keyed.map(({ section, tokens }) => ({ section, tokens }));

    this.queryGate(job, gen, snapshot.id);
    this.emit({
      v: PROTOCOL_VERSION_V4,
      t: 'result',
      job,
      snapshot: snapshot.id,
      data: { op: 'structure', structure: { doc, structure: ref.structure, index: ref.index, rows } },
    });
  }

  /**
   * The authoring-context query (§12.3, ruling §2). Unlike the cheap structure
   * read, this re-derives the DETECTED baseline the correction UI diffs against
   * — candidate values from resident text + the extraction recipe, verified
   * against the admitted candidate identity, then `buildDetectedSections` — and
   * memoizes it per [TextHash, CandidateHash, StructureRecipeHash] (bounded,
   * never persisted). Echoes the base identities + effective override hash and
   * both artifact identities, and carries the current composed rows (bound id +
   * lineage key + token range) so the UI can render while it edits.
   */
  private async queryStructureEditContext(job: number, gen: GenerationStateV4, snapshot: CorpusSnapshotV1, doc: string): Promise<void> {
    const resolved = this.resolveStructureDoc(job, gen, snapshot, doc, 'edit context');
    if (!resolved) return;
    const { ref, ready, artifact } = resolved;
    const plan = gen.plans.get(doc);
    const residentText = gen.texts.get(doc);
    if (!plan || residentText === undefined) throw new DependencyError('text', doc);
    const text = verifiedTextOf(residentText);

    // Detected baseline: reconstruct candidates from resident text and verify
    // they still hash to the admitted identity (a nondeterminism/corruption
    // guard), then build the detected table. Memoized per identity triple.
    const cacheKey = `${artifact.text}\u0000${artifact.candidates}\u0000${artifact.recipe}`;
    let detected = gen.detectedTables.get(cacheKey);
    if (!detected) {
      const bundle = await deriveCandidatesFromText(text, plan.extractionRecipe);
      if (bundle.candidateHash !== artifact.candidates) {
        this.emitError('EXTRACTION_MISMATCH', { job, message: `document '${doc}' reconstructed candidates do not match the artifact`, recoverable: false });
        return;
      }
      detected = buildDetectedSections(text, bundle.candidates, plan.structureRecipe);
      // Bound the ephemeral cache (at most one entry per project doc).
      if (gen.detectedTables.size >= this.caps.maxDocsPerProject) {
        const oldest = gen.detectedTables.keys().next().value;
        if (oldest !== undefined) gen.detectedTables.delete(oldest);
      }
      gen.detectedTables.set(cacheKey, detected);
    }
    await this.queryCheckpoint(job, gen, snapshot.id);

    // Token ranges for the CURRENT composed sections (same projection + cache
    // as the plain structure query).
    const ranges = this.tokenRangesFor(gen, ref, ready, artifact);
    this.queryGate(job, gen, snapshot.id);

    const current = await this.bindSectionRows(job, gen, snapshot.id, doc, artifact, ranges);
    const detectedRows: EditSectionRow[] = detected.map((s) => ({
      key: s.key,
      origin: s.origin,
      ...(s.parent === undefined ? {} : { parent: s.parent }),
      level: s.level,
      ...(s.title === undefined ? {} : { title: s.title }),
      chars: { start: s.chars.start, end: s.chars.end },
    }));

    this.queryGate(job, gen, snapshot.id);
    this.emit({
      v: PROTOCOL_VERSION_V4,
      t: 'result',
      job,
      snapshot: snapshot.id,
      data: {
        op: 'structure-edit-context',
        context: {
          doc,
          structure: ref.structure,
          index: ref.index,
          base: { text: artifact.text, candidates: artifact.candidates, baseRecipe: artifact.recipe },
          override: artifact.override,
          detected: detectedRows,
          current,
        },
      },
    });
  }

  /** The bounded source line around a char anchor (§4). Synchronous and cheap —
   *  a `maxChars`-bounded window (hard-capped so a caller cannot request an
   *  unbounded slice), never splitting a surrogate pair. */
  private queryLineExcerpt(job: number, gen: GenerationStateV4, snapshot: CorpusSnapshotV1, doc: string, anchor: number, maxChars: number): void {
    const ref = snapshot.docs.find((r) => r.doc === doc);
    if (!ref) {
      this.emitError('REQUEST_INVALID', { job, message: `'${doc}' is not a member of the snapshot`, recoverable: true });
      return;
    }
    const residentText = gen.texts.get(doc);
    if (residentText === undefined) {
      this.emitError('DEPENDENCY_MISSING', { job, message: `text for '${doc}' is not resident`, recoverable: true });
      return;
    }
    const text = verifiedTextOf(residentText);
    if (!Number.isInteger(anchor) || anchor < 0 || anchor > text.length) {
      this.emitError('REQUEST_INVALID', { job, message: `invalid line anchor ${anchor}`, recoverable: true });
      return;
    }
    if (!Number.isFinite(maxChars)) {
      // Defence in depth: the schema already rejects a non-finite budget, but a
      // NaN budget here would defeat the window's stopping comparisons.
      this.emitError('REQUEST_INVALID', { job, message: `invalid line-excerpt budget ${maxChars}`, recoverable: true });
      return;
    }
    const bounded = Math.min(Math.max(1, Math.floor(maxChars)), LINE_EXCERPT_MAX_CHARS);
    const w = lineWindowAround(text, anchor, bounded);
    this.emit({
      v: PROTOCOL_VERSION_V4,
      t: 'result',
      job,
      snapshot: snapshot.id,
      data: {
        op: 'line-excerpt',
        excerpt: { doc, chars: { start: w.start, end: w.end }, text: w.text, truncatedStart: w.truncatedStart, truncatedEnd: w.truncatedEnd },
      },
    });
  }

  // -------------------------------------------------------------------------
  // 7. Gates, checkpoints, and emission
  // -------------------------------------------------------------------------

  /** Yielding checkpoint: parks on the task queue so queued cancels run, then
   *  checks job cancellation and generation OBJECT identity. */
  private async checkpoint(job: number, gen: GenerationStateV4): Promise<void> {
    await this.yieldControl();
    this.gate(job, gen);
  }

  /** Job + generation gate (aborts the whole job on cancel/replacement). */
  private gate(job: number, gen: GenerationStateV4): void {
    if (this.cancelledJobs.has(job)) {
      this.emit({ v: PROTOCOL_VERSION_V4, t: 'cancelled', job });
      throw CANCELLED;
    }
    if (this.generation !== gen) {
      this.emitError('GENERATION_STALE', { job, generation: gen.generation, message: 'generation was replaced during the job', recoverable: true });
      throw CANCELLED;
    }
  }

  /** Yielding checkpoint bound to a document CLAIM: also throws SUPERSEDED when
   *  a newer task has taken the document. */
  private async docCheckpoint(job: number, token: DocWorkToken): Promise<void> {
    await this.yieldControl();
    this.docGate(job, token);
  }

  /** Synchronous document-claim gate: job/generation, then work ownership. */
  private docGate(job: number, token: DocWorkToken): void {
    this.gate(job, token.generation);
    if (!this.owns(token)) throw SUPERSEDED;
  }

  /**
   * The ONE classification of a warm-path failure as TERMINAL (emitted, never
   * listed as a byte miss — a refetch cannot repair a candidate contradiction,
   * a cap violation, or a malformed override). Returns false for everything
   * else, which the caller degrades to a `rehydrate-failed` byte miss — that
   * DELIBERATELY includes RangeError, unlike `mapError` (a warm attempt may
   * fall back to the byte path; the cold ingest surfaces the real fault with
   * full context).
   */
  private emitTerminalWarmFailure(e: unknown, job: number, generation: string): boolean {
    if (e instanceof ExtractionMismatchError) {
      this.emitError('EXTRACTION_MISMATCH', { job, generation, message: e.message, recoverable: true });
      return true;
    }
    if (e instanceof CapError || e instanceof StructureCapError) {
      this.emitError('CAP_EXCEEDED', { job, generation, message: e.message, recoverable: true });
      return true;
    }
    if (e instanceof StructureError) {
      // A malformed override / invalid table is TERMINAL — bytes cannot
      // repair it, so it is never downgraded to a rehydrate miss.
      this.emitError('REQUEST_INVALID', { job, generation, message: e.message, recoverable: true });
      return true;
    }
    return false;
  }

  private progress(job: number, generation: string, phase: BuildPhaseV4, doc: string): void {
    this.emit({ v: PROTOCOL_VERSION_V4, t: 'progress', job, generation, phase, doc });
  }

  private warnStorage(code: StorageWarningCodeV4, message: string, generation?: string): void {
    if (code !== 'CACHE_CORRUPT') {
      if (this.envWarned.has(code)) return;
      this.envWarned.add(code);
    }
    this.emit({ v: PROTOCOL_VERSION_V4, t: 'warning', ...(generation === undefined ? {} : { generation }), code, message });
  }

  private emitError(code: WorkerErrorCodeV4, opts: { job?: number | undefined; generation?: string | undefined; message: string; recoverable: boolean }): void {
    this.emit({
      v: PROTOCOL_VERSION_V4,
      t: 'error',
      ...(opts.job === undefined ? {} : { job: opts.job }),
      ...(opts.generation === undefined ? {} : { generation: opts.generation }),
      code,
      message: opts.message,
      recoverable: opts.recoverable,
    });
  }
}

class SourceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceMismatchError';
  }
}
class IdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConflictError';
  }
}

/** Deterministic error → analysis code mapping by TYPE, never message text. */
function mapError(e: unknown): { code: WorkerErrorCodeV4; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof DependencyError) return { code: 'DEPENDENCY_MISSING', message };
  if (e instanceof CapError) return { code: 'CAP_EXCEEDED', message };
  if (e instanceof SourceMismatchError || e instanceof IdentityConflictError) return { code: 'SOURCE_MISMATCH', message };
  if (e instanceof ExtractionMismatchError) return { code: 'EXTRACTION_MISMATCH', message };
  // A section-count violation is a cap; any other structural violation (bad
  // override, over-long key, collision, malformed table) is a request fault.
  // Subclass BEFORE base so a StructureCapError never falls through to REQUEST_INVALID.
  if (e instanceof StructureCapError) return { code: 'CAP_EXCEEDED', message };
  if (e instanceof StructureError) return { code: 'REQUEST_INVALID', message };
  if (e instanceof RangeError) return { code: 'REQUEST_INVALID', message };
  return { code: 'INTERNAL', message };
}
