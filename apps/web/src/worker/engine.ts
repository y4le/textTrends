/**
 * WorkerEngine — Phase 1 Milestone 4 (docs/design/phase1-plan.md, Milestone 4).
 *
 * The worker's state machine, kept free of Worker/postMessage/IndexedDB APIs
 * so it is unit-testable in Node: messages in via handle(), messages out via
 * the injected emit, storage via the injected ArtifactStore, scheduling via
 * the injected yieldControl (a REAL task-queue yield in the web adapter).
 *
 * Lifecycle rules (contract §8, plan M4, review round 1):
 * - one active generation; begin-generation replaces it; stale work is
 *   suppressed by OBJECT identity (the captured generation state), never by
 *   comparing strings or timing;
 * - ingest phases (decode → segment → index → compose) are separated by
 *   yielding cancellation checkpoints, and publication is guarded by a
 *   SYNCHRONOUS commit gate after all awaits: candidate maps and bindings
 *   are staged locally, then committed only if the job is uncancelled and
 *   the captured generation is still current; compositions are serialized
 *   through an async mutex so an older staging can never overwrite newer;
 * - the query path has the same discipline: yielding checkpoints between
 *   phases and a synchronous identity/cancel gate immediately before the
 *   result is emitted;
 * - the warm path is an INDEX-CACHE hit (not yet the plan's manifest-driven
 *   reopen): keyed by (textHash, recipeHash, FULL segmenter-fingerprint
 *   hash), and every hit is re-verified against the requested tuple — a
 *   mismatching record is reported ARTIFACT_CORRUPT and rebuilt;
 * - cache writes are best-effort after publication.
 */

import {
  CapError,
  bindShards,
  bindTexts,
  buildResolver,
  composeSnapshot,
  createDocumentIndex,
  DependencyError,
  hashIndexRecipe,
  hashSegmenterFingerprint,
  hashText,
  checkedResolverFor,
  kwicPage,
  makeReadyDocument,
  materializeKwicPage,
  materializePassage,
  modeKey,
  occurrences,
  planPassage,
  resolveSelection,
  rootOnlyStructure,
  segment,
  tokenEndChar,
  trend,
  validateShardStructure,
  DEFAULT_INDEX_RECIPE,
  type BoundShards,
  type BoundTexts,
  type CorpusSnapshotV1,
  type DocumentIndexV1,
  type MatchMode,
  type ReadyDocument,
  type Resolver,
} from '@texttrends/core';
import { PROTOCOL_VERSION, type FromWorker, type GenerationDocSpec, type QueryOp, type ToWorker } from './protocol.ts';
import type { ArtifactStore } from './store.ts';

type Emit = (message: FromWorker) => void;
type Yield = () => Promise<void>;

interface GenerationState {
  readonly generation: string;
  readonly docs: readonly GenerationDocSpec[];
  ready: Map<string, ReadyDocument>;
  texts: Map<string, string>;
  snapshot: CorpusSnapshotV1 | null;
  bound: BoundShards | null;
  boundTexts: BoundTexts | null;
  readonly resolvers: Map<string, Map<string, Resolver>>;
}

const CANCELLED = Symbol('cancelled');

export class WorkerEngine {
  private readonly store: ArtifactStore;
  private readonly emit: Emit;
  private readonly yieldControl: Yield;
  private generation: GenerationState | null = null;
  /** Jobs currently being processed — cancellation only applies to these;
   *  both sets are cleaned when the job finishes, so late cancel messages
   *  for completed jobs cannot grow state without bound (scrub traffic). */
  private readonly activeJobs = new Set<number>();
  private readonly cancelledJobs = new Set<number>();
  /** Serializes staging+commit so an older composition cannot win a race. */
  private composing: Promise<void> = Promise.resolve();

  constructor(store: ArtifactStore, emit: Emit, yieldControl: Yield) {
    this.store = store;
    this.emit = emit;
    this.yieldControl = yieldControl;
  }

  async handle(message: ToWorker): Promise<void> {
    if (message === null || typeof message !== 'object' || typeof (message as { t?: unknown }).t !== 'string') {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error',
        code: 'PARSE_FAILED', message: 'malformed envelope', recoverable: true,
      });
      return;
    }
    if (message.v !== PROTOCOL_VERSION) {
      this.emit({
        v: PROTOCOL_VERSION,
        t: 'error',
        code: 'PROTOCOL_VERSION',
        message: `expected protocol ${PROTOCOL_VERSION}`,
        recoverable: false,
        ...('job' in message && typeof message.job === 'number' ? { job: message.job } : {}),
      });
      return;
    }
    if (!narrowEnvelope(message)) {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error',
        ...('job' in message && typeof message.job === 'number' ? { job: message.job } : {}),
        code: 'PARSE_FAILED', message: `malformed '${message.t}' payload`, recoverable: true,
      });
      return;
    }
    const job = 'job' in message && typeof message.job === 'number' ? message.job : undefined;
    if (job !== undefined && message.t !== 'cancel') this.activeJobs.add(job);
    try {
      switch (message.t) {
        case 'begin-generation':
          this.beginGeneration(message.generation, message.docs);
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
          // Only an ACTIVE job can become cancelled — a late cancel for a
          // finished job must not accrete permanent state.
          if (this.activeJobs.has(message.job)) this.cancelledJobs.add(message.job);
          return;
        default: {
          const unknown: never | { t?: string; job?: number } = message;
          this.emit({
            v: PROTOCOL_VERSION,
            t: 'error',
            ...(typeof unknown.job === 'number' ? { job: unknown.job } : {}),
            code: 'UNKNOWN_OP',
            message: `unknown message type '${String(unknown.t)}'`,
            recoverable: true,
          });
          return;
        }
      }
    } catch (e) {
      if (e === CANCELLED) return;
      this.emit({
        v: PROTOCOL_VERSION,
        t: 'error',
        ...(job === undefined ? {} : { job }),
        ...mapError(e),
        recoverable: true,
      });
    } finally {
      if (job !== undefined && message.t !== 'cancel') {
        this.activeJobs.delete(job);
        this.cancelledJobs.delete(job);
      }
    }
  }

  private beginGeneration(generation: string, docs: readonly GenerationDocSpec[]): void {
    // Generation replacement IS invalidation; old artifacts stay content-
    // addressed in the store and are simply not consulted.
    this.generation = {
      generation,
      docs,
      ready: new Map(),
      texts: new Map(),
      snapshot: null,
      bound: null,
      boundTexts: null,
      resolvers: new Map(),
    };
  }

  /** Yielding checkpoint: parks on the task queue so queued cancel messages
   *  run, then checks job cancellation and generation OBJECT identity. */
  private async checkpoint(job: number, gen: GenerationState): Promise<void> {
    await this.yieldControl();
    this.gate(job, gen);
  }

  /** SYNCHRONOUS gate — also used immediately before commits/emissions. */
  private gate(job: number, gen: GenerationState): void {
    if (this.cancelledJobs.has(job)) {
      this.emit({ v: PROTOCOL_VERSION, t: 'cancelled', job });
      throw CANCELLED;
    }
    if (this.generation !== gen) {
      this.emit({
        v: PROTOCOL_VERSION,
        t: 'error',
        job,
        generation: gen.generation,
        code: 'GENERATION_STALE',
        message: 'generation was replaced during the job',
        recoverable: true,
      });
      throw CANCELLED;
    }
  }

  private async ingest(job: number, generation: string, doc: string, bytes: ArrayBuffer): Promise<void> {
    const gen = this.generation;
    if (!gen || gen.generation !== generation) {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error', job, generation,
        code: 'GENERATION_STALE', message: 'unknown or replaced generation', recoverable: true,
      });
      return;
    }
    const spec = gen.docs.find((d) => d.doc === doc);
    if (!spec) {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error', job, generation,
        code: 'PARSE_FAILED', message: `document '${doc}' is not in this generation`, recoverable: true,
      });
      return;
    }

    await this.checkpoint(job, gen);
    this.emit({ v: PROTOCOL_VERSION, t: 'progress', job, generation, phase: 'decode', doc });
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error', job, generation,
        code: 'DECODE_FAILED', message: `document '${doc}' is not valid UTF-8`, recoverable: true,
      });
      return;
    }
    const textHash = await hashText(text);
    this.emit({
      v: PROTOCOL_VERSION, t: 'source-ready', job, generation, doc,
      textHash, textLength: text.length,
    });

    await this.checkpoint(job, gen);
    // Warm path: an index-cache hit for the FULL identity tuple skips
    // segmentation and indexing. Every hit is re-verified; a mismatching or
    // structurally unsound record is corrupt and gets rebuilt.
    const recipeHash = await hashIndexRecipe(DEFAULT_INDEX_RECIPE);
    const fingerprint = (await segment('', spec.language)).provenance;
    const segmenterHash = await hashSegmenterFingerprint(fingerprint);
    let shard = await this.store.getShard(textHash, recipeHash, segmenterHash);
    if (shard) {
      // One cache-hit validation boundary: store output is UNTRUSTED — verify
      // the identity tuple AND the complete shard ABI; any failure is a
      // corrupt record that gets rebuilt (review round 2).
      try {
        validateShardStructure(shard);
        // Bind resident geometry to THIS text's actual extent — in-domain
        // spans can still point past the end of this document (round 3).
        const n = shard.tokenTypeIds.length;
        if (n > 0 && tokenEndChar(shard, n - 1) > text.length) {
          throw new RangeError('resident token spans exceed the verified text length');
        }
        const hitSegmenter = await hashSegmenterFingerprint(shard.segmenter);
        if (shard.text !== textHash || shard.recipe !== recipeHash || hitSegmenter !== segmenterHash) {
          throw new RangeError('cached shard does not match its key');
        }
      } catch (e) {
        this.emit({
          v: PROTOCOL_VERSION, t: 'error', job, generation,
          code: 'ARTIFACT_CORRUPT',
          message: `cached shard for '${doc}' failed verification (${e instanceof Error ? e.message : String(e)}); rebuilding`,
          recoverable: true,
        });
        shard = undefined;
      }
    }
    if (!shard) {
      this.emit({ v: PROTOCOL_VERSION, t: 'progress', job, generation, phase: 'segment', doc });
      const batch = await segment(text, spec.language);
      await this.checkpoint(job, gen);
      this.emit({ v: PROTOCOL_VERSION, t: 'progress', job, generation, phase: 'index', doc });
      shard = await createDocumentIndex(text, batch, DEFAULT_INDEX_RECIPE);
    }
    const readyShard = shard;

    await this.checkpoint(job, gen);
    this.emit({ v: PROTOCOL_VERSION, t: 'progress', job, generation, phase: 'compose', doc });

    // Serialize staging+commit: an older composition must never overwrite a
    // newer one, and the commit itself must be synchronous after all awaits.
    const run = this.composing.then(async () => {
      this.gate(job, gen); // re-check after acquiring the mutex

      const ready = await makeReadyDocument(
        doc as Parameters<typeof makeReadyDocument>[0],
        readyShard,
        rootOnlyStructure(readyShard.text, text.length),
      );
      // Stage candidate state LOCALLY — nothing on gen mutates yet.
      const nextReady = new Map(gen.ready);
      nextReady.set(doc, ready);
      const nextTexts = new Map(gen.texts);
      nextTexts.set(doc, text);
      const expected = gen.docs.map((d) => d.doc);
      const snapshot = await composeSnapshot(
        gen.generation as Parameters<typeof composeSnapshot>[0],
        expected as unknown as Parameters<typeof composeSnapshot>[1],
        nextReady as unknown as Parameters<typeof composeSnapshot>[2],
      );
      const shards = new Map<string, DocumentIndexV1>();
      for (const [id, r] of nextReady) shards.set(id, r.shard);
      const bound = await bindShards(snapshot, shards);
      const boundTexts = await bindTexts(snapshot, bound, nextTexts);

      // SYNCHRONOUS commit gate + commit + publication (review round 1).
      this.gate(job, gen);
      gen.ready = nextReady;
      gen.texts = nextTexts;
      gen.snapshot = snapshot;
      gen.bound = bound;
      gen.boundTexts = boundTexts;
      // ALWAYS replace the resolver map when this doc's shard commits — a
      // retained map holds resolvers bound to the replaced shard, and an
      // in-flight old-snapshot query could poison it (review round 4).
      gen.resolvers.set(doc, new Map());
      this.emit({
        v: PROTOCOL_VERSION,
        t: 'snapshot-published',
        generation: gen.generation,
        snapshot: snapshot.id,
        readyDocs: snapshot.docs.map((d) => d.doc),
        missingDocs: snapshot.missingDocs,
      });
    });
    // The mutex must advance even when this composition throws.
    this.composing = run.catch(() => undefined);
    await run;

    // Best-effort cache write AFTER publication — failure is a warning.
    void Promise.all([
      this.store.putText(textHash, text),
      this.store.putShard(textHash, recipeHash, segmenterHash, readyShard),
    ]).catch(() => {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error', generation,
        code: 'INTERNAL', message: 'cache write failed (results unaffected)', recoverable: true,
      });
    });
  }

  private async resolverFor(gen: GenerationState, doc: string, mode: MatchMode): Promise<Resolver> {
    const byMode = gen.resolvers.get(doc);
    const ready = gen.ready.get(doc);
    if (!byMode || !ready) throw new DependencyError('shard', doc);
    const key = modeKey(mode);
    let resolver = byMode.get(key);
    // Self-heal: a cached entry bound to a shard other than the CURRENT ready
    // shard (async poisoning across a replacement) is rebuilt, not served.
    if (!resolver || resolver.shard !== ready.shard) {
      resolver = await buildResolver(ready.shard, DEFAULT_INDEX_RECIPE, mode);
      byMode.set(key, resolver);
    }
    return resolver;
  }

  /** Query checkpoint: yields, then re-verifies job, generation, and that the
   *  bound snapshot is still the published one. */
  private async queryCheckpoint(job: number, gen: GenerationState, snapshotId: string): Promise<void> {
    await this.yieldControl();
    this.queryGate(job, gen, snapshotId);
  }

  private queryGate(job: number, gen: GenerationState, snapshotId: string): void {
    if (this.cancelledJobs.has(job)) {
      this.emit({ v: PROTOCOL_VERSION, t: 'cancelled', job });
      throw CANCELLED;
    }
    if (this.generation !== gen || gen.snapshot?.id !== snapshotId) {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error', job,
        code: 'SNAPSHOT_UNKNOWN',
        message: 'query is bound to an unknown or superseded snapshot',
        recoverable: true,
      });
      throw CANCELLED;
    }
  }

  private async query(job: number, snapshotId: string, q: QueryOp): Promise<void> {
    const gen = this.generation;
    if (!gen?.snapshot || gen.snapshot.id !== snapshotId || !gen.bound || !gen.boundTexts) {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error', job,
        code: 'SNAPSHOT_UNKNOWN', message: 'query is bound to an unknown or superseded snapshot',
        recoverable: true,
      });
      return;
    }
    if (!narrowQuery(q)) {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error', job,
        code: 'REQUEST_INVALID', message: 'malformed query payload', recoverable: true,
      });
      return;
    }
    if (q.op !== 'trend' && q.op !== 'kwic' && q.op !== 'passage') {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error', job,
        code: 'UNKNOWN_OP', message: `unknown query op '${String((q as { op?: string }).op)}'`,
        recoverable: true,
      });
      return;
    }
    const snapshot = gen.snapshot;
    const bound = gen.bound;
    const boundTexts = gen.boundTexts;

    if (q.op === 'passage') {
      const { doc, centerToken, maxTokens, tracks } = q.request;
      const ready = gen.ready.get(doc);
      if (!ready) throw new DependencyError('shard', doc);
      const ref = snapshot.docs.find((r) => r.doc === doc);
      if (!ref) {
        throw new RangeError(`'${doc}' is not a member of the snapshot`);
      }
      const byMode = new Map<string, Resolver>();
      for (const track of tracks) {
        for (const member of track.group.members) {
          byMode.set(modeKey(member.match), await this.resolverFor(gen, doc, member.match));
        }
      }
      await this.queryCheckpoint(job, gen, snapshotId);
      const resolverFor = checkedResolverFor(doc, ref.index, ready.shard, byMode);
      const plan = planPassage(
        snapshot, doc, ready.shard, resolverFor,
        tracks.map((t) => t.group), centerToken, maxTokens,
      );
      await this.queryCheckpoint(job, gen, snapshotId);
      const passage = materializePassage(snapshot, plan, boundTexts, tracks);
      this.emit({
        v: PROTOCOL_VERSION, t: 'result', job, snapshot: snapshot.id,
        data: { op: 'passage', passage },
      });
      return;
    }

    let selection;
    try {
      selection = await resolveSelection(
        snapshot,
        q.selection as Parameters<typeof resolveSelection>[1],
      );
    } catch (e) {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error', job,
        code: 'SELECTION_INVALID', message: e instanceof Error ? e.message : String(e),
        recoverable: true,
      });
      return;
    }
    await this.queryCheckpoint(job, gen, snapshotId);

    const shards = new Map<string, DocumentIndexV1>();
    const resolvers = new Map<string, Map<string, Resolver>>();
    for (const id of selection.spec.docs) {
      const ready = gen.ready.get(id);
      if (!ready) throw new DependencyError('shard', id);
      shards.set(id, ready.shard);
      const byMode = new Map<string, Resolver>();
      for (const member of q.group.members) {
        byMode.set(modeKey(member.match), await this.resolverFor(gen, id, member.match));
      }
      resolvers.set(id, byMode);
    }
    await this.queryCheckpoint(job, gen, snapshotId);

    const occ = occurrences(snapshot, shards, resolvers, selection, q.group);
    await this.queryCheckpoint(job, gen, snapshotId);

    if (q.op === 'trend') {
      const data = trend(snapshot, selection, occ, q.request);
      // Yield AFTER the final compute phase so a cancel queued during the
      // synchronous kernel becomes observable, then gate+emit synchronously.
      await this.queryCheckpoint(job, gen, snapshotId);
      this.emit({
        v: PROTOCOL_VERSION, t: 'result', job, snapshot: snapshot.id,
        data: { op: 'trend', trend: data },
      });
      return;
    }
    const page = kwicPage(snapshot, bound, selection, occ, q.request);
    const rows = materializeKwicPage(snapshot, page, boundTexts);
    await this.queryCheckpoint(job, gen, snapshotId);
    this.emit({
      v: PROTOCOL_VERSION, t: 'result', job, snapshot: snapshot.id,
      data: { op: 'kwic', total: page.total, rows },
    });
  }

  private excerpt(job: number, snapshotId: string, doc: string, charStart: number, charEnd: number): void {
    const gen = this.generation;
    if (!gen?.snapshot || gen.snapshot.id !== snapshotId) {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error', job,
        code: 'SNAPSHOT_UNKNOWN', message: 'excerpt is bound to an unknown or superseded snapshot',
        recoverable: true,
      });
      return;
    }
    const text = gen.texts.get(doc);
    if (text === undefined) {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error', job,
        code: 'DEPENDENCY_MISSING', message: `text for '${doc}' is not resident`, recoverable: true,
      });
      return;
    }
    if (
      !Number.isInteger(charStart) || !Number.isInteger(charEnd) ||
      charStart < 0 || charStart >= charEnd || charEnd > text.length
    ) {
      this.emit({
        v: PROTOCOL_VERSION, t: 'error', job,
        code: 'REQUEST_INVALID', message: `invalid excerpt range [${charStart}, ${charEnd})`,
        recoverable: true,
      });
      return;
    }
    this.emit({
      v: PROTOCOL_VERSION, t: 'excerpt-result', job, snapshot: snapshotId, doc,
      charStart, charEnd, text: text.slice(charStart, charEnd),
    });
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object';

/** Container/scalar narrowing for the fields each dispatch arm consumes —
 *  malformed wire shapes map to PARSE_FAILED, reserving INTERNAL for faults. */
function narrowEnvelope(m: ToWorker): boolean {
  switch (m.t) {
    case 'begin-generation':
      return (
        typeof m.job === 'number' && typeof m.generation === 'string' &&
        Array.isArray(m.docs) &&
        m.docs.every((d) => isRecord(d) && typeof d.doc === 'string' && typeof d.language === 'string')
      );
    case 'ingest':
      return (
        typeof m.job === 'number' && typeof m.generation === 'string' &&
        typeof m.doc === 'string' && m.bytes instanceof ArrayBuffer
      );
    case 'query':
      return typeof m.job === 'number' && typeof m.snapshot === 'string';
    case 'excerpt':
      return (
        typeof m.job === 'number' && typeof m.snapshot === 'string' &&
        typeof m.doc === 'string' && typeof m.charStart === 'number' && typeof m.charEnd === 'number'
      );
    case 'cancel':
      return typeof m.job === 'number';
    default:
      return true; // unknown t handled by the dispatch default → UNKNOWN_OP
  }
}

const MATCH_VALUES = new Set(['sensitive', 'folded']);

function narrowMember(m: unknown): boolean {
  if (!isRecord(m) || typeof m.id !== 'string' || !isRecord(m.match)) return false;
  const match = m.match as { case?: unknown; diacritics?: unknown };
  // EXACT enum values — any other string would silently be interpreted as
  // 'sensitive' by foldKey and change semantics (review round 5).
  if (!MATCH_VALUES.has(match.case as string) || !MATCH_VALUES.has(match.diacritics as string)) {
    return false;
  }
  switch (m.kind) {
    case 'token':
      return typeof m.surface === 'string';
    case 'phrase':
      return (
        Array.isArray(m.surfaces) && m.surfaces.every((x) => typeof x === 'string') &&
        typeof m.crossSentence === 'boolean'
      );
    case 'prefix':
    case 'suffix':
      return typeof m.stem === 'string';
    default:
      return false;
  }
}

function narrowGroup(g: unknown): boolean {
  return (
    isRecord(g) &&
    typeof (g as { id?: unknown }).id === 'string' &&
    typeof (g as { countOverlaps?: unknown }).countOverlaps === 'boolean' &&
    Array.isArray((g as { members?: unknown }).members) &&
    ((g as { members: unknown[] }).members as unknown[]).every(narrowMember)
  );
}

/** The query payload containers, member elements, and semantic-bearing
 *  scalars the kernels consume; value-range checks stay in the kernels —
 *  except the passage TRACK cap and seriesId uniqueness, which are wire-
 *  boundary invariants (the kernel never sees seriesIds). */
function narrowQuery(q: unknown): q is QueryOp {
  if (!isRecord(q) || typeof q.op !== 'string') return false;
  if (q.op === 'passage') {
    if (!isRecord(q.request)) return false;
    const r = q.request as Record<string, unknown>;
    if (
      typeof r.doc !== 'string' ||
      typeof r.centerToken !== 'number' ||
      typeof r.maxTokens !== 'number' ||
      !Array.isArray(r.tracks) ||
      (r.tracks as unknown[]).length > 5
    ) {
      return false;
    }
    const seen = new Set<string>();
    for (const t of r.tracks as unknown[]) {
      if (!isRecord(t) || typeof (t as { seriesId?: unknown }).seriesId !== 'string') return false;
      if (!narrowGroup((t as { group?: unknown }).group)) return false;
      const id = (t as { seriesId: string }).seriesId;
      if (seen.has(id)) return false;
      seen.add(id);
    }
    return true;
  }
  if (q.op !== 'trend' && q.op !== 'kwic') return true; // let dispatch emit UNKNOWN_OP
  if (
    !isRecord(q.selection) || !Array.isArray((q.selection as { docs?: unknown }).docs) ||
    !narrowGroup(q.group) ||
    !isRecord(q.request)
  ) {
    return false;
  }
  const request = q.request as Record<string, unknown>;
  if (q.op === 'trend') {
    return typeof request.coordinate === 'string' && typeof request.binsPerDoc === 'number';
  }
  return (
    typeof request.contextTokens === 'number' &&
    Array.isArray(request.sort) &&
    (request.sort as unknown[]).every(
      (s) => isRecord(s) && typeof s.at === 'string' && typeof s.dir === 'number',
    ) &&
    isRecord(request.page) &&
    typeof (request.page as { offset?: unknown }).offset === 'number' &&
    typeof (request.page as { limit?: unknown }).limit === 'number'
  );
}

/** Deterministic error → code mapping by TYPE, never by message text
 *  (review round 2 — user-controlled messages must not select codes). */
function mapError(e: unknown): { code: import('./protocol.ts').WorkerErrorCode; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof DependencyError) return { code: 'DEPENDENCY_MISSING', message };
  if (e instanceof CapError) return { code: 'CAP_EXCEEDED', message };
  if (e instanceof RangeError) return { code: 'REQUEST_INVALID', message };
  return { code: 'INTERNAL', message };
}
