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
  bindShards,
  bindTexts,
  buildDetectedSections,
  buildResolver,
  checkedResolverFor,
  composeSnapshot,
  composeStructure,
  createDocumentIndex,
  decodeDocumentSource,
  deriveCandidatesFromText,
  emptyOverride,
  finalizeExtraction,
  lineWindowAround,
  fingerprint,
  hashExtractionRecipe,
  hashIndexRecipe,
  hashSegmenterFingerprint,
  hashSourceBytes,
  hashStructureOverride,
  hashStructureRecipe,
  hashText,
  kwicPage,
  makeReadyDocument,
  materializeKwicPage,
  materializePassage,
  modeKey,
  occurrences,
  type NumericOccurrences,
  planPassage,
  projectSections,
  resolveSelection,
  segment,
  tokenEndChar,
  trend,
  validateExtractionArtifact,
  validateExtractionRecipe,
  validateProjectManifest,
  validateShardStructure,
  validateStructureArtifactV2,
  type BoundShards,
  type BoundTexts,
  type CandidateBundle,
  type IngestCapsV0,
  type CorpusSnapshotV1,
  type DocumentIndexV1,
  type ExtractionArtifactV1,
  type ExtractionRecipeProvisional,
  type IndexRecipeProvisional,
  type MatchMode,
  type ReadyDocument,
  type Resolver,
  StructureCapError,
  StructureError,
  type StructureArtifactV2,
  type StructureOverrideV1,
  type StructureRecipeProvisional,
  type StructureSectionRecordV2,
  type TokenRange,
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
  type SourceDescriptorV4,
  type StorageWarningCodeV4,
  type ToWorkerV4,
  type UserDataErrorCodeV4,
  type WarmMissReasonV4,
  type WireSection,
  type WorkerErrorCodeV4,
} from './protocol-v4.ts';
import { parseToWorkerV4 } from './protocol-v4-schema.ts';
import { EpubExtractionError, extractEpubDocument } from './epub-extract.ts';
import type { ArtifactStore, DocumentIndexCacheKey, ExtractionCacheKey, StructureCacheKey } from './store.ts';
import { UserDataError, type StoredSourceV1, type UserDataStore } from './user-data-store.ts';

type EmitV4 = (message: FromWorkerV4, transfers?: readonly Transferable[]) => void;
type Yield = () => Promise<void>;

/**
 * The durable user-data access seam (engine-v4 consult §Q2). The engine never
 * requires a durable store to CONSTRUCT — analysis must start without it. Only
 * a user-data command awaits the provider; the provider memoizes the (single,
 * bounded) open so repeated commands do not re-open.
 */
export type UserDataAccess =
  | { readonly kind: 'ok'; readonly store: UserDataStore }
  | { readonly kind: 'blocked'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string };
export type UserDataProvider = () => Promise<UserDataAccess>;

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
  texts: Map<string, string>;
  snapshot: CorpusSnapshotV1 | null;
  bound: BoundShards | null;
  boundTexts: BoundTexts | null;
  readonly resolvers: Map<string, Map<string, Resolver>>;
  /** Doc-independent section→token projections, keyed [StructureHash, IndexArtifactHash]. */
  readonly tokenViews: Map<string, readonly TokenRange[]>;
  /** Bounded ephemeral DETECTED-table cache for the edit-context query, keyed
   *  [TextHash, CandidateHash, StructureRecipeHash] — never persisted (ruling §2). */
  readonly detectedTables: Map<string, readonly StructureSectionRecordV2[]>;
  /** Ephemeral per-track occurrence cache for KWIC re-centering. A re-center
   *  changes only the sort/page (`center`), never the occurrence sets, so the
   *  expensive per-doc match is memoized by [SnapshotId, SelectionHash, GroupId]
   *  — the coordinates that FULLY determine a `NumericOccurrences`. Dropped with
   *  the generation; superseded snapshots key distinctly and never collide. */
  readonly kwicOccCache: Map<string, NumericOccurrences>;
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

/** The verified inputs prepareFromText builds the remaining artifacts from. */
interface PrepareInput {
  readonly text: string;
  readonly textHash: string;
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
        case 'excerpt':
          this.excerpt(message.job, message.snapshot, message.doc, message.charStart, message.charEnd);
          return;
        case 'cancel':
          if (this.activeJobs.has(message.job)) this.cancelledJobs.add(message.job);
          return;
        case 'project-load':
        case 'project-save':
        case 'source-persist':
          await this.handleUserData(message);
          return;
        default: {
          const unknown: never = message;
          this.emitError('UNKNOWN_OP', { job: (unknown as { job?: number }).job, message: 'unknown message type', recoverable: true });
          return;
        }
      }
    } catch (e) {
      if (e === CANCELLED || e === SUPERSEDED) return;
      this.emit({ v: PROTOCOL_VERSION_V4, t: 'error', ...(job === undefined ? {} : { job }), ...mapError(e), recoverable: true });
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
      resolvers: new Map(),
      tokenViews: new Map(),
      detectedTables: new Map(),
      kwicOccCache: new Map(),
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
        if (e instanceof ExtractionMismatchError) {
          // A deterministic candidate contradiction is TERMINAL — bytes cannot
          // repair it, so report it and do NOT list it as a byte miss.
          this.emitError('EXTRACTION_MISMATCH', { job, generation, message: e.message, recoverable: true });
          continue;
        }
        if (e instanceof CapError || e instanceof StructureCapError) {
          this.emitError('CAP_EXCEEDED', { job, generation, message: e.message, recoverable: true });
          continue;
        }
        if (e instanceof StructureError) {
          // A malformed override / invalid table is TERMINAL — bytes cannot
          // repair it, so it is never downgraded to a rehydrate miss.
          this.emitError('REQUEST_INVALID', { job, generation, message: e.message, recoverable: true });
          continue;
        }
        // A failed warm attempt falls back to the byte path; a real fault will
        // surface with full context on the cold ingest.
        misses.push({ doc, need: 'source-bytes', reason: 'rehydrate-failed' });
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
        if (e instanceof ExtractionMismatchError) {
          this.emitError('EXTRACTION_MISMATCH', { job, generation, message: e.message, recoverable: true });
          continue;
        }
        if (e instanceof CapError || e instanceof StructureCapError) {
          this.emitError('CAP_EXCEEDED', { job, generation, message: e.message, recoverable: true });
          continue;
        }
        if (e instanceof StructureError) {
          this.emitError('REQUEST_INVALID', { job, generation, message: e.message, recoverable: true });
          continue;
        }
        misses.push({ doc: work.plan.doc, need: 'source-bytes', reason: 'rehydrate-failed' });
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
      // A fresh import has no `expectedTextLengthUtf16` yet, but every supported
      // encoding decodes to at most `byteLength` UTF-16 units, so the byte count
      // is a sound upper bound on its text — contributing it keeps the project
      // text cap enforced for fresh imports (contract §12.9).
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
    this.gate(job, gen);
    if (!this.owns(token)) throw SUPERSEDED;
    if (read.kind === 'miss') return this.probeFromSource(job, plan, token, 'extraction-miss');
    if (read.kind === 'corrupt') {
      this.warnStorage('CACHE_CORRUPT', `stored text for '${plan.doc}' is corrupt (${read.reason}); deleted`, gen.generation);
      await this.store.deleteText(plan.expectedText).catch(() => undefined);
      this.gate(job, gen);
      if (!this.owns(token)) throw SUPERSEDED;
      return this.probeFromSource(job, plan, token, 'extraction-miss');
    }
    // The stored text must HASH to its asserted identity — a record under the
    // right key proves nothing about its content.
    const text = read.value;
    let actual: string | null = null;
    try {
      actual = await hashText(text);
    } catch {
      actual = null; // ill-formed UTF-16 is corruption
    }
    this.gate(job, gen);
    if (!this.owns(token)) throw SUPERSEDED;
    if (actual !== plan.expectedText) {
      this.warnStorage('CACHE_CORRUPT', `stored text for '${plan.doc}' does not hash to its key; deleted`, gen.generation);
      await this.store.deleteText(plan.expectedText).catch(() => undefined);
      this.gate(job, gen);
      if (!this.owns(token)) throw SUPERSEDED;
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
        const admitted = await this.admitCachedExtraction(job, plan, token, plan.expectedSourceHash, text);
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
      this.gate(job, gen);
      if (!this.owns(token)) throw SUPERSEDED;
      candidateHash = bundle.candidateHash;
      parts.candidates = bundle;
    }

    // Admit a cached structure artifact for the exact identity tuple.
    const { overrideHash } = await this.resolveOverride(plan, textHash, candidateHash);
    this.gate(job, gen);
    if (!this.owns(token)) throw SUPERSEDED;
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
    this.gate(job, gen);
    if (!this.owns(token)) throw SUPERSEDED;
    const shard = await this.admitCachedShard(job, plan, token, shardKey, text);
    if (shard) parts.shard = shard;

    // A text-only path with no candidate list defers the identity check to
    // prepareFromText, which reconstructs candidates and throws a terminal
    // ExtractionMismatchError if they contradict `expectedCandidates`.
    // Cheap = no index rebuild required (the shard was admitted). An exact hit
    // (shard + structure) and a structure-only reconstruction are both cheap.
    return { kind: 'prepare', cheap: parts.shard !== undefined, input: { text, textHash, candidateHash, parts } };
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
    this.gate(job, gen);
    if (!this.owns(token)) throw SUPERSEDED;
    // Durable store unavailable — still need bytes, for the disposable reason.
    if (access.kind !== 'ok') return { kind: 'needs-bytes', reason: missReason };
    let read;
    try {
      read = await access.store.getSource(plan.expectedSourceHash);
    } catch {
      return { kind: 'needs-bytes', reason: 'source-not-persisted' };
    }
    this.gate(job, gen);
    if (!this.owns(token)) throw SUPERSEDED;
    if (read.kind === 'miss') return { kind: 'needs-bytes', reason: 'source-miss' };
    if (read.kind === 'corrupt') {
      this.warnStorage('CACHE_CORRUPT', `persisted source for '${plan.doc}' is corrupt (${read.reason}); retained`, gen.generation);
      return { kind: 'needs-bytes', reason: 'source-corrupt' };
    }
    // Re-extract the durable bytes as if freshly ingested. A source-dependent
    // (epub) recipe re-runs the CONTAINER extractor — the joined text alone
    // cannot rebuild its spine candidates — while a literal recipe decodes.
    // Determinism means the re-extraction reproduces the manifest's TextHash +
    // candidate hash; a mismatch surfaces downstream as EXTRACTION_MISMATCH.
    let extracted;
    if (plan.extractionRecipe.format === 'epub') {
      this.progress(job, gen.generation, 'extract', plan.doc);
      try {
        extracted = await extractEpubDocument(new Uint8Array(read.value.bytes), plan.extractionRecipe, this.caps.maxTextUtf16PerDoc * 4);
      } catch (e) {
        if (e instanceof EpubExtractionError && e.cap) throw new CapError(`persisted source for '${plan.doc}' extracts past a cap`);
        throw e;
      }
      this.gate(job, gen);
      if (!this.owns(token)) throw SUPERSEDED;
      if (extracted.text.length > this.caps.maxTextUtf16PerDoc) {
        throw new CapError(`persisted source for '${plan.doc}' extracts past the per-document UTF-16 cap`);
      }
    } else {
      this.progress(job, gen.generation, 'decode', plan.doc);
      const decoded = await decodeDocumentSource(new Uint8Array(read.value.bytes), plan.extractionRecipe);
      this.gate(job, gen);
      if (!this.owns(token)) throw SUPERSEDED;
      // The same per-document decoded-text cap the cold path enforces (an
      // understated declaration must not bypass it on warm reopen). CapError is
      // caught by the warm loop and reported as CAP_EXCEEDED.
      if (decoded.decoded.text.length > this.caps.maxTextUtf16PerDoc) {
        throw new CapError(`persisted source for '${plan.doc}' decodes past the per-document UTF-16 cap`);
      }
      this.progress(job, gen.generation, 'extract', plan.doc);
      extracted = await finalizeExtraction({ kind: 'literal', decoded }, plan.extractionRecipe);
    }
    this.gate(job, gen);
    if (!this.owns(token)) throw SUPERSEDED;
    const identity = { source: extracted.artifact.source, text: extracted.artifact.text, candidates: extracted.artifact.candidateHash };
    this.assertAssertedIdentity(plan, identity);
    // A re-extracted persisted source performed NO main-thread transfer.
    this.freezeAccepted(token, identity, 0);
    this.emitSourceReady(job, gen.generation, plan, extracted);
    const key: ExtractionCacheKey = { schema: 'texttrends/extraction/1', source: extracted.artifact.source, recipe: plan.extractionRecipeHash };
    return {
      kind: 'prepare',
      cheap: false,
      input: {
        text: extracted.text,
        textHash: extracted.artifact.text,
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
    text: string,
  ): Promise<{ artifact: ExtractionArtifactV1; key: ExtractionCacheKey } | undefined> {
    const key: ExtractionCacheKey = { schema: 'texttrends/extraction/1', source: sourceHash, recipe: plan.extractionRecipeHash };
    const read = await this.store.getExtraction(key);
    this.gate(job, token.generation);
    if (!this.owns(token)) throw SUPERSEDED;
    if (read.kind === 'miss') return undefined;
    if (read.kind === 'corrupt') {
      this.warnStorage('CACHE_CORRUPT', `cached extraction for '${plan.doc}' failed the envelope check (${read.reason}); deleted`, token.generation.generation);
      await this.store.deleteExtraction(key).catch(() => undefined);
      return undefined;
    }
    try {
      const artifact = await validateExtractionArtifact(read.value, key, plan.extractionRecipe, text);
      return { artifact, key };
    } catch (e) {
      // Ownership FIRST — a supersession during deep admission must not warn or
      // delete a record the new owner may have replaced.
      this.gate(job, token.generation);
      if (!this.owns(token)) throw SUPERSEDED;
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
    this.gate(job, token.generation);
    if (!this.owns(token)) throw SUPERSEDED;
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
      this.gate(job, token.generation);
      if (!this.owns(token)) throw SUPERSEDED;
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
    this.gate(job, token.generation);
    if (!this.owns(token)) throw SUPERSEDED;
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
      this.gate(job, token.generation);
      if (!this.owns(token)) throw SUPERSEDED;
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
    const { text, textHash, candidateHash } = input;

    // Shard.
    const shardKey = await this.shardKeyFor(gen, plan.effectiveLocale, textHash);
    this.docGate(job, token);
    let shard = input.parts.shard;
    if (!shard) {
      this.progress(job, gen.generation, 'segment', plan.doc);
      const batch = await segment(text, plan.effectiveLocale);
      await this.docCheckpoint(job, token);
      this.progress(job, gen.generation, 'index', plan.doc);
      shard = await createDocumentIndex(text, batch, gen.indexRecipe);
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

  /** Freeze the first accepted source/text/candidate identity for a document.
   *  A later same-generation attempt with a DIFFERENT identity is rejected —
   *  it must not change what this generation's document means in place. */
  /**
   * Freeze the first accepted identity for a document AND, atomically, charge
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

  /** A delivered/extracted identity must agree with any asserted expectation. */
  private assertAssertedIdentity(plan: ResolvedDocPlan, identity: AcceptedIdentity): void {
    if (plan.expectedSourceHash !== undefined && identity.source !== undefined && identity.source !== plan.expectedSourceHash) {
      throw new SourceMismatchError(`document '${plan.doc}' source hashed to ${identity.source.slice(0, 16)}… but the generation asserted ${plan.expectedSourceHash.slice(0, 16)}…`);
    }
    if (plan.expectedText !== undefined && identity.text !== plan.expectedText) {
      throw new SourceMismatchError(`document '${plan.doc}' text hashed to ${identity.text.slice(0, 16)}… but the generation asserted ${plan.expectedText.slice(0, 16)}…`);
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

    let extracted;
    if (plan.extractionRecipe.format === 'epub') {
      // Container format: unzip + extract → transformed finalize (NO byte-decode
      // phase). A malformed archive/markup is PARSE_FAILED, a size overrun
      // CAP_EXCEEDED — never DECODE_FAILED (the container path never decodes
      // whole-file bytes to text).
      this.progress(job, generation, 'extract', doc);
      try {
        extracted = await extractEpubDocument(new Uint8Array(bytes), plan.extractionRecipe, this.caps.maxTextUtf16PerDoc * 4);
      } catch (e) {
        this.gate(job, gen);
        if (!this.owns(token)) throw SUPERSEDED;
        const cap = e instanceof EpubExtractionError && e.cap;
        this.emitError(cap ? 'CAP_EXCEEDED' : 'PARSE_FAILED', {
          job, generation,
          message: e instanceof Error ? e.message : `document '${doc}' failed to extract`,
          recoverable: true,
        });
        return;
      }
      this.docGate(job, token);
      if (extracted.text.length > this.caps.maxTextUtf16PerDoc) {
        this.emitError('CAP_EXCEEDED', { job, generation, message: `document '${doc}' extracted text exceeds the per-document UTF-16 cap`, recoverable: true });
        return;
      }
    } else {
      this.progress(job, generation, 'decode', doc);
      let decoded;
      try {
        decoded = await decodeDocumentSource(new Uint8Array(bytes), plan.extractionRecipe);
      } catch (e) {
        this.gate(job, gen);
        if (!this.owns(token)) throw SUPERSEDED;
        this.emitError('DECODE_FAILED', { job, generation, message: e instanceof Error ? e.message : `document '${doc}' failed to decode`, recoverable: true });
        return;
      }
      this.docGate(job, token);
      if (decoded.decoded.text.length > this.caps.maxTextUtf16PerDoc) {
        this.emitError('CAP_EXCEEDED', { job, generation, message: `document '${doc}' decoded text exceeds the per-document UTF-16 cap`, recoverable: true });
        return;
      }
      this.progress(job, generation, 'extract', doc);
      extracted = await finalizeExtraction({ kind: 'literal', decoded }, plan.extractionRecipe);
    }
    this.docGate(job, token);

    const identity = { source: extracted.artifact.source, text: extracted.artifact.text, candidates: extracted.artifact.candidateHash };
    // Assert against declared identities BEFORE freezing/emitting, then freeze —
    // a second same-generation ingest with different bytes is rejected, and the
    // transferred bytes are charged atomically against the project transfer cap.
    this.assertAssertedIdentity(plan, identity);
    this.freezeAccepted(token, identity, bytes.byteLength);
    this.emitSourceReady(job, generation, plan, extracted);

    const key: ExtractionCacheKey = { schema: 'texttrends/extraction/1', source: extracted.artifact.source, recipe: plan.extractionRecipeHash };
    const prepared = await this.prepareFromText(job, plan, {
      text: extracted.text,
      textHash: extracted.artifact.text,
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
    const d = a.descriptor;
    const source: SourceDescriptorV4 = d.kind === 'text'
      ? {
          kind: 'text',
          hash: d.hash,
          byteLength: d.byteLength,
          format: d.format,
          encoding: { detected: d.encoding.detected, hadReplacementChars: d.encoding.hadReplacementChars },
        }
      : {
          kind: 'container',
          hash: d.hash,
          byteLength: d.byteLength,
          format: d.format,
          container: { internalDecoding: d.container.internalDecoding, documentCount: d.container.documentCount },
        };
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
        for (const [id, text] of gen.texts) if (!ownedByDoc.has(id)) running += text.length;
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
          nextTexts.set(item.prepared.doc, item.prepared.text);
        }
        const expected = gen.docs;
        const snapshot = await composeSnapshot(
          gen.generation as Parameters<typeof composeSnapshot>[0],
          expected as unknown as Parameters<typeof composeSnapshot>[1],
          nextReady as unknown as Parameters<typeof composeSnapshot>[2],
        );
        const shards = new Map<string, DocumentIndexV1>();
        for (const [id, r] of nextReady) shards.set(id, r.shard);
        const bound = await bindShards(snapshot, shards);
        const boundTexts = await bindTexts(snapshot, bound, nextTexts);

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
        // Replace committed docs' resolver maps — a retained map holds
        // resolvers bound to a replaced shard.
        for (const item of included) gen.resolvers.set(item.prepared.doc, new Map());
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

  private async resolverFor(gen: GenerationStateV4, doc: string, mode: MatchMode): Promise<Resolver> {
    const byMode = gen.resolvers.get(doc);
    const ready = gen.ready.get(doc);
    if (!byMode || !ready) throw new DependencyError('shard', doc);
    const key = modeKey(mode);
    let resolver = byMode.get(key);
    if (!resolver || resolver.shard !== ready.shard) {
      resolver = await buildResolver(ready.shard, gen.indexRecipe, mode);
      byMode.set(key, resolver);
    }
    return resolver;
  }

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
    const bound = gen.bound;
    const boundTexts = gen.boundTexts;

    if (q.op === 'structure') {
      await this.queryStructure(job, gen, snapshot, q.request.doc);
      return;
    }

    if (q.op === 'structure-edit-context') {
      await this.queryStructureEditContext(job, gen, snapshot, q.request.doc);
      return;
    }

    if (q.op === 'line-excerpt') {
      this.queryLineExcerpt(job, snapshot, q.request.doc, q.request.anchor, q.request.maxChars);
      return;
    }

    if (q.op === 'passage') {
      const { doc, centerToken, maxTokens, tracks } = q.request;
      const ready = gen.ready.get(doc);
      if (!ready) throw new DependencyError('shard', doc);
      const ref = snapshot.docs.find((r) => r.doc === doc);
      if (!ref) throw new RangeError(`'${doc}' is not a member of the snapshot`);
      const byMode = new Map<string, Resolver>();
      for (const track of tracks) {
        for (const member of track.group.members) byMode.set(modeKey(member.match), await this.resolverFor(gen, doc, member.match));
      }
      await this.queryCheckpoint(job, gen, snapshotId);
      const resolverFor = checkedResolverFor(doc, ref.index, ready.shard, byMode);
      const plan = planPassage(snapshot, doc, ready.shard, resolverFor, tracks.map((t) => t.group), centerToken, maxTokens);
      await this.queryCheckpoint(job, gen, snapshotId);
      const passage = materializePassage(snapshot, plan, boundTexts, tracks);
      this.emit({ v: PROTOCOL_VERSION_V4, t: 'result', job, snapshot: snapshot.id, data: { op: 'passage', passage } });
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

    const shards = new Map<string, DocumentIndexV1>();
    for (const id of selection.spec.docs) {
      const ready = gen.ready.get(id);
      if (!ready) throw new DependencyError('shard', id);
      shards.set(id, ready.shard);
    }

    if (q.op === 'trend') {
      const resolvers = new Map<string, Map<string, Resolver>>();
      for (const id of selection.spec.docs) {
        const byMode = new Map<string, Resolver>();
        for (const member of q.group.members) byMode.set(modeKey(member.match), await this.resolverFor(gen, id, member.match));
        resolvers.set(id, byMode);
      }
      await this.queryCheckpoint(job, gen, snapshotId);
      const occ = occurrences(snapshot, shards, resolvers, selection, q.group);
      await this.queryCheckpoint(job, gen, snapshotId);
      const data = trend(snapshot, selection, occ, q.request);
      await this.queryCheckpoint(job, gen, snapshotId);
      this.emit({ v: PROTOCOL_VERSION_V4, t: 'result', job, snapshot: snapshot.id, data: { op: 'trend', trend: data } }, trendTransferList(data));
      return;
    }

    // kwic/2: UNION every track's required match modes per doc (never rebuild a
    // duplicate resolver), then compute occurrences PER track and merge in the
    // numeric kernel. Checkpoint after resolver prep, after each track, after
    // numeric planning, and after materialization.
    const resolvers = new Map<string, Map<string, Resolver>>();
    for (const id of selection.spec.docs) {
      const byMode = new Map<string, Resolver>();
      for (const track of q.tracks) {
        for (const member of track.group.members) {
          const mk = modeKey(member.match);
          if (!byMode.has(mk)) byMode.set(mk, await this.resolverFor(gen, id, member.match));
        }
      }
      resolvers.set(id, byMode);
    }
    await this.queryCheckpoint(job, gen, snapshotId);

    const trackOccs: NumericOccurrences[] = [];
    for (const track of q.tracks) {
      // Re-centering the concordance re-issues this query with the same
      // snapshot/selection/tracks and only a new `center`; the occurrence sets
      // are identical, so memoize them and let the re-center pay only for the
      // top-K ordering + text slicing below.
      const key = `${snapshot.id}\u0000${selection.hash}\u0000${track.group.id}`;
      let occ = gen.kwicOccCache.get(key);
      if (!occ) {
        occ = occurrences(snapshot, shards, resolvers, selection, track.group);
        gen.kwicOccCache.set(key, occ);
        await this.queryCheckpoint(job, gen, snapshotId);
      }
      trackOccs.push(occ);
    }
    const page = kwicPage(snapshot, bound, selection, trackOccs, q.request);
    await this.queryCheckpoint(job, gen, snapshotId);
    const trackTable = q.tracks.map((t) => ({ seriesId: t.seriesId, groupId: t.group.id }));
    const rows = materializeKwicPage(snapshot, page, boundTexts, trackTable);
    await this.queryCheckpoint(job, gen, snapshotId);
    this.emit({ v: PROTOCOL_VERSION_V4, t: 'result', job, snapshot: snapshot.id, data: { op: 'kwic', total: page.total, rows } });
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
    const ref = snapshot.docs.find((r) => r.doc === doc);
    if (!ref) {
      this.emitError('REQUEST_INVALID', { job, message: `'${doc}' is not a member of the snapshot`, recoverable: true });
      return;
    }
    const ready = gen.ready.get(doc);
    if (!ready) throw new DependencyError('shard', doc);
    // The resident document must still be the one the snapshot ref names.
    if (ready.index !== ref.index || ready.structure !== ref.structure) {
      this.emitError('SNAPSHOT_UNKNOWN', { job, message: 'structure query is bound to a superseded document', recoverable: true });
      return;
    }
    const artifact = ready.structureArtifact;
    if (artifact.schema !== 'texttrends/structure/2') {
      this.emitError('REQUEST_INVALID', { job, message: `document '${doc}' has no chapter structure`, recoverable: true });
      return;
    }
    const viewKey = tokenViewKey(ref.structure, ref.index);
    let ranges = gen.tokenViews.get(viewKey);
    if (!ranges) {
      ranges = projectSections(artifact.sections, ready.shard.startsUtf16);
      gen.tokenViews.set(viewKey, ranges);
    }
    await this.queryCheckpoint(job, gen, snapshot.id);

    // Bind lineage keys → project-scoped SectionIds, then translate parents.
    const idByKey = new Map<string, string>();
    for (const s of artifact.sections) idByKey.set(s.key, await bindSectionId(doc, s.key));
    this.queryGate(job, gen, snapshot.id);
    const rows: { section: WireSection; tokens: TokenRange }[] = artifact.sections.map((s, i) => ({
      section: {
        id: idByKey.get(s.key)!,
        doc,
        origin: s.origin,
        ...(s.parent === undefined ? {} : { parent: idByKey.get(s.parent)! }),
        level: s.level,
        ...(s.title === undefined ? {} : { title: s.title }),
        chars: { start: s.chars.start, end: s.chars.end },
      },
      tokens: ranges![i]!,
    }));

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
    const ref = snapshot.docs.find((r) => r.doc === doc);
    if (!ref) {
      this.emitError('REQUEST_INVALID', { job, message: `'${doc}' is not a member of the snapshot`, recoverable: true });
      return;
    }
    const ready = gen.ready.get(doc);
    if (!ready) throw new DependencyError('shard', doc);
    if (ready.index !== ref.index || ready.structure !== ref.structure) {
      this.emitError('SNAPSHOT_UNKNOWN', { job, message: 'edit context is bound to a superseded document', recoverable: true });
      return;
    }
    const artifact = ready.structureArtifact;
    if (artifact.schema !== 'texttrends/structure/2') {
      this.emitError('REQUEST_INVALID', { job, message: `document '${doc}' has no chapter structure`, recoverable: true });
      return;
    }
    const plan = gen.plans.get(doc);
    const text = gen.texts.get(doc);
    if (!plan || text === undefined) throw new DependencyError('text', doc);

    // Detected baseline: reconstruct candidates from resident text and verify
    // they still hash to the admitted identity (a nondeterminism/corruption
    // guard), then build the detected table. Memoized per identity triple.
    const cacheKey = `${artifact.text} ${artifact.candidates} ${artifact.recipe}`;
    let detected = gen.detectedTables.get(cacheKey);
    if (!detected) {
      const bundle = await deriveCandidatesFromText(text, plan.extractionRecipe);
      if (bundle.candidateHash !== artifact.candidates) {
        this.emitError('EXTRACTION_MISMATCH', { job, message: `document '${doc}' reconstructed candidates do not match the artifact`, recoverable: false });
        return;
      }
      detected = buildDetectedSections(text, bundle.candidates, plan.structureRecipe);
      // Bound the ephemeral cache (at most one entry per project doc).
      if (gen.detectedTables.size >= INGEST_CAPS_V0.maxDocsPerProject) {
        const oldest = gen.detectedTables.keys().next().value;
        if (oldest !== undefined) gen.detectedTables.delete(oldest);
      }
      gen.detectedTables.set(cacheKey, detected);
    }
    await this.queryCheckpoint(job, gen, snapshot.id);

    // Token ranges for the CURRENT composed sections (same projection + cache
    // as the plain structure query).
    const viewKey = tokenViewKey(ref.structure, ref.index);
    let ranges = gen.tokenViews.get(viewKey);
    if (!ranges) {
      ranges = projectSections(artifact.sections, ready.shard.startsUtf16);
      gen.tokenViews.set(viewKey, ranges);
    }
    this.queryGate(job, gen, snapshot.id);

    const idByKey = new Map<string, string>();
    for (const s of artifact.sections) idByKey.set(s.key, await bindSectionId(doc, s.key));
    this.queryGate(job, gen, snapshot.id);
    const current = artifact.sections.map((s, i) => ({
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
      tokens: ranges![i]!,
    }));
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
  private queryLineExcerpt(job: number, snapshot: CorpusSnapshotV1, doc: string, anchor: number, maxChars: number): void {
    const gen = this.generation!;
    const ref = snapshot.docs.find((r) => r.doc === doc);
    if (!ref) {
      this.emitError('REQUEST_INVALID', { job, message: `'${doc}' is not a member of the snapshot`, recoverable: true });
      return;
    }
    const text = gen.texts.get(doc);
    if (text === undefined) {
      this.emitError('DEPENDENCY_MISSING', { job, message: `text for '${doc}' is not resident`, recoverable: true });
      return;
    }
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

  private excerpt(job: number, snapshotId: string, doc: string, charStart: number, charEnd: number): void {
    const gen = this.generation;
    if (!gen?.snapshot || gen.snapshot.id !== snapshotId) {
      this.emitError('SNAPSHOT_UNKNOWN', { job, message: 'excerpt is bound to an unknown or superseded snapshot', recoverable: true });
      return;
    }
    const text = gen.texts.get(doc);
    if (text === undefined) {
      this.emitError('DEPENDENCY_MISSING', { job, message: `text for '${doc}' is not resident`, recoverable: true });
      return;
    }
    if (!Number.isInteger(charStart) || !Number.isInteger(charEnd) || charStart < 0 || charStart >= charEnd || charEnd > text.length) {
      this.emitError('REQUEST_INVALID', { job, message: `invalid excerpt range [${charStart}, ${charEnd})`, recoverable: true });
      return;
    }
    this.emit({ v: PROTOCOL_VERSION_V4, t: 'excerpt-result', job, snapshot: snapshotId, doc, charStart, charEnd, text: text.slice(charStart, charEnd) });
  }

  // -------------------------------------------------------------------------
  // 7. User-data lane
  // -------------------------------------------------------------------------

  /**
   * User-data commands share the worker's job/cancellation infrastructure but
   * NOT generation state, snapshots, progress, or the analysis error channel —
   * they emit ONLY user-data acknowledgements/errors. Reads and pre-write CPU
   * work are cancellable; a durable write is cancellable only BEFORE its
   * transaction starts — once it commits, a truthful acknowledgement wins over
   * a late cancel (else the main thread sits at revision N while storage is at
   * N+1, producing a misleading conflict on retry).
   */
  private async handleUserData(message: Extract<ToWorkerV4, { t: 'project-load' | 'project-save' | 'source-persist' }>): Promise<void> {
    const job = message.job;
    // Tracks whether an IRREVERSIBLE durable write has begun. A failure from a
    // cancellable PRE-WRITE await (provider, read, hash, validation) on a
    // cancelled job must surface as `cancelled`, not as a storage error — but
    // once a write has started the truthful ack/error rule takes over.
    let writeStarted = false;
    try {
      if (message.t === 'project-load') {
        const access = await this.access(job);
        if (!access) return;
        if (this.checkCancelled(job)) return;
        const read = await access.getProject(message.project);
        if (this.checkCancelled(job)) return;
        if (read.kind === 'miss') {
          this.emit({ v: PROTOCOL_VERSION_V4, t: 'project-missing', job, project: message.project });
          return;
        }
        if (read.kind === 'corrupt') {
          this.emitUserDataError(job, 'DATA_CORRUPT', `stored project is corrupt: ${read.reason}`);
          return;
        }
        let manifest;
        try {
          manifest = await validateProjectManifest(read.value);
        } catch (e) {
          if (this.checkCancelled(job)) return; // cancelled during recipe/hash recomputation
          this.emitUserDataError(job, 'DATA_CORRUPT', `stored project failed validation: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        if (this.checkCancelled(job)) return; // deep validation recomputes hashes — recheck before publishing
        this.emit({ v: PROTOCOL_VERSION_V4, t: 'project-loaded', job, project: message.project, manifest });
        return;
      }

      if (message.t === 'project-save') {
        let next;
        try {
          next = await validateProjectManifest(message.manifest);
        } catch (e) {
          if (this.checkCancelled(job)) return;
          this.emitUserDataError(job, 'REQUEST_INVALID', `manifest failed validation: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        if (this.checkCancelled(job)) return; // recheck after the (awaited) deep validation, before the write
        if (next.id !== message.project) {
          this.emitUserDataError(job, 'REQUEST_INVALID', 'manifest id does not match the save target');
          return;
        }
        if (next.revision !== message.expectedRevision + 1) {
          this.emitUserDataError(job, 'REQUEST_INVALID', `manifest revision ${next.revision} must be expectedRevision + 1 (${message.expectedRevision + 1})`);
          return;
        }
        const access = await this.access(job);
        if (!access) return;
        if (this.checkCancelled(job)) return; // last cancellable point before the durable write
        writeStarted = true;
        const { committed } = await access.putProject(next, message.expectedRevision);
        this.emit({ v: PROTOCOL_VERSION_V4, t: 'project-saved', job, project: message.project, revision: committed.revision });
        return;
      }

      // source-persist: cap → hash → verify → durable put → ack.
      if (message.bytes.byteLength > this.caps.maxSourceBytesPerFile) {
        this.emitUserDataError(job, 'REQUEST_INVALID', `source of ${message.bytes.byteLength} bytes exceeds the per-file cap`);
        return;
      }
      const hash = await hashSourceBytes(new Uint8Array(message.bytes));
      if (this.checkCancelled(job)) return;
      if (hash !== message.sourceHash) {
        this.emitUserDataError(job, 'SOURCE_MISMATCH', `bytes hashed to ${hash.slice(0, 16)}… but the claim was ${message.sourceHash.slice(0, 16)}…`);
        return;
      }
      const access = await this.access(job);
      if (!access) return;
      if (this.checkCancelled(job)) return; // last cancellable point before the durable write
      writeStarted = true;
      const record: StoredSourceV1 = { schema: 'texttrends/source/1', hash, byteLength: message.bytes.byteLength, bytes: message.bytes };
      await access.putSource(record);
      this.emit({ v: PROTOCOL_VERSION_V4, t: 'source-persisted', job, sourceHash: hash });
    } catch (e) {
      // A pre-write failure on a cancelled job is a cancellation, not a storage
      // error — cancellation wins until an irreversible write has begun.
      if (!writeStarted && this.checkCancelled(job)) return;
      this.emitUserDataError(job, mapUserDataCode(e), e instanceof Error ? e.message : String(e), e instanceof UserDataError ? e.currentRevision : undefined);
    }
  }

  /** Await the durable provider for a user-data command; emit a precise
   *  user-data error (never an analysis error) when it is not available. */
  private async access(job: number): Promise<UserDataStore | null> {
    const access = await this.userData();
    if (this.checkCancelled(job)) return null;
    if (access.kind === 'ok') return access.store;
    this.emitUserDataError(job, 'PERSISTENCE_UNAVAILABLE', access.message);
    return null;
  }

  /** True if the job was cancelled — emits `cancelled` and returns true so the
   *  caller stops BEFORE an irreversible write. */
  private checkCancelled(job: number): boolean {
    if (this.cancelledJobs.has(job)) {
      this.emit({ v: PROTOCOL_VERSION_V4, t: 'cancelled', job });
      return true;
    }
    return false;
  }

  private emitUserDataError(job: number, code: UserDataErrorCodeV4, message: string, currentRevision?: number): void {
    this.emit({ v: PROTOCOL_VERSION_V4, t: 'user-data-error', job, code, message, ...(currentRevision === undefined ? {} : { currentRevision }) });
  }

  // -------------------------------------------------------------------------
  // 8. Gates, checkpoints, and emission
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

/** Map a caught user-data failure to its precise code (storage faults keep
 *  their UserDataError code; anything else is a request/persistence fault). */
function mapUserDataCode(e: unknown): UserDataErrorCodeV4 {
  if (e instanceof UserDataError) return e.code as UserDataErrorCodeV4;
  return 'PERSISTENCE_UNAVAILABLE';
}
