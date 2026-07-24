/**
 * Main-thread worker client: job correlation, snapshot tracking, typed
 * requests. The main thread owns user intent (current generation, live
 * snapshot id, active jobs); the worker owns analysis and residency.
 * Corpus bytes are TRANSFERRED, never cloned.
 *
 * M5: openGeneration is the awaitable warm-open seam — it resolves on the
 * worker's generation-ready barrier, after which the caller fetches ONLY
 * the named misses. The client also owns worker DEATH: on error the failed
 * worker is terminated and replaced (bounded attempts), pending requests
 * reject, and the restart listener lets the app re-open its generation —
 * cheap, because rehydration is a warm reopen. Messages are fenced by a
 * worker-instance epoch so a stale instance can never publish.
 */

import type { IndexRecipeProvisional, ProjectManifestV1, SourceDescriptorV1 } from '@texttrends/core';
import type {
  FromWorkerV4,
  GenerationDocSpecV4,
  MissingWarmDocV4,
  QueryOpV4,
  QueryResultDataV4,
  ToWorkerV4,
  UserDataErrorCodeV4,
  WorkerErrorCodeV4,
} from '../worker/protocol-v4.ts';
import { PROTOCOL_VERSION_V4 } from '../worker/protocol-v4.ts';
import type { ProtocolTraceSink } from './trace.ts';

/** A durable user-data failure surfaced as a typed rejection (never an
 *  analysis error): the code plus, for a CAS conflict, the revision actually
 *  stored so the caller can rebase. */
export class UserDataClientError extends Error {
  readonly code: UserDataErrorCodeV4;
  readonly currentRevision?: number;
  constructor(code: UserDataErrorCodeV4, message: string, currentRevision?: number) {
    super(message);
    this.name = 'UserDataClientError';
    this.code = code;
    if (currentRevision !== undefined) this.currentRevision = currentRevision;
  }
}

/** Transport-lifecycle failure codes for analysis-lane rejections. */
export type WorkerClientFailureCode =
  | 'CANCELLED'
  | 'WORKER_RESTARTED'
  | 'WORKER_TERMINATED'
  | 'WORKER_POST_FAILED'
  | 'WORKER_ERROR';

/** A typed transport/lifecycle rejection from the analysis lane. `code` is the
 *  control-flow discriminant — message text is presentation only and must never
 *  be compared. A worker analysis error additionally carries its wire code in
 *  `analysisCode`. Durable user-data failures stay `UserDataClientError`: their
 *  codes (and `currentRevision`) are domain data, not transport lifecycle. */
export class WorkerClientError extends Error {
  readonly code: WorkerClientFailureCode;
  readonly analysisCode?: WorkerErrorCodeV4;
  constructor(code: WorkerClientFailureCode, message: string, analysisCode?: WorkerErrorCodeV4) {
    super(message);
    this.name = 'WorkerClientError';
    this.code = code;
    if (analysisCode !== undefined) this.analysisCode = analysisCode;
  }
}

/** THE cancellation predicate — a deliberate cancel is invisible noise to every
 *  consumer, and only the typed code says so (an error whose message happens to
 *  read 'cancelled' is a real error). */
export const isCancelled = (e: unknown): boolean =>
  e instanceof WorkerClientError && e.code === 'CANCELLED';

/** Resolution of projectLoad: the WORKER-VALIDATED manifest (the worker is
 *  the sole durable-admission authority — it upgrades + deep-validates before
 *  emitting), or a miss. Corrupt/unavailable rejects with a
 *  UserDataClientError (DATA_CORRUPT / PERSISTENCE_UNAVAILABLE). */
export type ProjectLoadResult =
  | { readonly kind: 'loaded'; readonly manifest: ProjectManifestV1 }
  | { readonly kind: 'missing' };

/** The correlated extraction event: the source/text/candidate identities a
 *  manifest needs, retaining job + generation + doc so a superseded or retried
 *  import can never assemble the wrong document. NOTE: source-ready is an
 *  intermediate signal, NOT ingest completion — segment/index/structure/compose
 *  can still fail after it; snapshot publication is the analysis boundary. */
export interface SourceReadyInfo {
  readonly job: number;
  readonly generation: string;
  readonly doc: string;
  readonly source: SourceDescriptorV1;
  readonly extractionRecipeHash: string;
  readonly text: string;
  readonly textLengthUtf16: number;
  readonly candidates: string;
  readonly decoderReplacementCount: number;
  readonly suspiciousControlCount: number;
}

export interface SnapshotInfo {
  /** The generation this snapshot belongs to — lets a consumer distinguish a
   *  live generation's publication from a superseded one's late arrival. */
  readonly generation: string;
  readonly snapshot: string;
  readonly readyDocs: readonly string[];
  readonly missingDocs: readonly string[];
}

export interface IngestProgress {
  readonly doc: string;
  readonly phase: string;
  /** The generation this progress belongs to — lets a consumer ignore a
   *  superseded generation's late progress. */
  readonly generation: string;
}

/** Resolution of openGeneration: warm rehydration finished; exactly
 *  `missing` still need their bytes ingested (each with its typed reason —
 *  preserved for the loader, which fetches only `source-bytes` misses). */
export interface GenerationReady {
  readonly generation: string;
  readonly snapshot: string | null;
  readonly readyDocs: readonly string[];
  readonly missing: readonly MissingWarmDocV4[];
}

/** Bounded automatic restarts — a deterministic startup fault must not
 *  crash-loop forever; the last failure surfaces as fatal. */
const MAX_WORKER_RESTARTS = 3;

type Pending =
  | { kind: 'query'; resolve: (r: QueryResultDataV4) => void; reject: (e: Error) => void }
  | { kind: 'open'; resolve: (r: GenerationReady) => void; reject: (e: Error) => void }
  | { kind: 'project-load'; resolve: (r: ProjectLoadResult) => void; reject: (e: Error) => void }
  | { kind: 'project-save'; resolve: (r: { revision: number }) => void; reject: (e: Error) => void }
  | { kind: 'source-persist'; resolve: () => void; reject: (e: Error) => void };

export class WorkerClient {
  private worker: Worker;
  /** Fences messages AND late handlers from a replaced worker instance. */
  private workerEpoch = 0;
  private restartAttempts = 0;
  /** Set when restarts are exhausted: the worker is terminated and NOT
   *  replaced. New queries reject immediately — posting into a terminated
   *  worker would hang forever — and only an explicit openGeneration (a
   *  user-initiated retry) revives the client with a fresh budget. */
  private dead = false;
  /** Set by close(): terminal, NOT revivable (unlike restart exhaustion) —
   *  disposal/HMR teardown must never resurrect a Worker. */
  private closed = false;
  private nextJob = 1;
  private readonly pending = new Map<number, Pending>();
  private snapshotListener: ((info: SnapshotInfo) => void) | null = null;
  private progressListener: ((p: IngestProgress) => void) | null = null;
  private ingestErrorListener: ((generation: string, message: string, doc?: string) => void) | null = null;
  private sourceReadyListener: ((info: SourceReadyInfo) => void) | null = null;
  private restartListener: ((fatal: boolean) => void) | null = null;
  /** job -> the ingest's generation + document. A successful ingest has no
   *  job-bearing completion event (source-ready is too early — segment/index/
   *  structure can still fail after it), so entries are cleared at
   *  snapshot-published for the now-ready document; errors before publication
   *  still find their job. */
  private readonly ingestJobs = new Map<number, { generation: string; doc: string }>();
  /** Optional PASSIVE observability sink (e2e builds) — sanitized metadata
   *  only; the client never behaves differently when it is present. */
  private readonly trace: ProtocolTraceSink | null;

  constructor(trace?: ProtocolTraceSink) {
    this.trace = trace ?? null;
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const epoch = ++this.workerEpoch;
    const worker = new Worker(new URL('../worker/index.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<FromWorkerV4>) => {
      if (epoch === this.workerEpoch) this.receive(event.data);
    };
    worker.onerror = () => {
      if (epoch === this.workerEpoch) this.restart();
    };
    worker.onmessageerror = () => {
      if (epoch === this.workerEpoch) this.restart();
    };
    return worker;
  }

  /** Replace a dead/broken worker. Transferred buffers are unreplayable, so
   *  recovery is the app's: re-open the generation (warm) and refetch only
   *  what the barrier reports missing. */
  private restart(): void {
    for (const [, p] of this.pending) {
      p.reject(new WorkerClientError('WORKER_RESTARTED', 'WORKER_RESTARTED'));
    }
    this.pending.clear();
    this.ingestJobs.clear();
    this.worker.terminate();
    this.trace?.record({
      direction: 'client',
      t: 'restart',
      code: this.restartAttempts >= MAX_WORKER_RESTARTS ? 'fatal' : 'respawn',
    });
    if (this.restartAttempts >= MAX_WORKER_RESTARTS) {
      this.workerEpoch++; // fence any straggling events; no replacement
      this.dead = true;
      this.restartListener?.(true);
      return;
    }
    this.restartAttempts++;
    this.worker = this.spawn();
    this.restartListener?.(false);
  }

  onSnapshot(listener: (info: SnapshotInfo) => void): void {
    this.snapshotListener = listener;
  }
  onProgress(listener: (p: IngestProgress) => void): void {
    this.progressListener = listener;
  }
  onIngestError(listener: (generation: string, message: string, doc?: string) => void): void {
    this.ingestErrorListener = listener;
  }
  /** The correlated extraction event — the import flow assembles a manifest
   *  document from it, gating on the info's job/generation/doc. */
  onSourceReady(listener: (info: SourceReadyInfo) => void): void {
    this.sourceReadyListener = listener;
  }
  /** fatal=false: a replacement worker is live — re-open the generation.
   *  fatal=true: restarts are exhausted; surface the failure. */
  onRestart(listener: (fatal: boolean) => void): void {
    this.restartListener = listener;
  }

  private receive(m: FromWorkerV4): void {
    // Trace every message (sanitized metadata) BEFORE handling or ignoring it.
    this.trace?.record({
      direction: 'from-worker',
      t: m.t,
      ...('job' in m && m.job !== undefined ? { job: m.job } : {}),
      ...('generation' in m && m.generation !== undefined ? { generation: m.generation } : {}),
      ...('snapshot' in m ? { snapshot: m.snapshot } : {}),
      ...('doc' in m ? { doc: m.doc } : {}),
      ...('phase' in m ? { phase: m.phase } : {}),
      ...('code' in m ? { code: m.code } : {}),
      ...('data' in m ? { op: m.data.op } : {}),
      ...('readyDocs' in m ? { readyCount: m.readyDocs.length } : {}),
      ...('missing' in m ? { missingCount: m.missing.length } : {}),
      ...('missingDocs' in m ? { missingCount: m.missingDocs.length } : {}),
    });
    switch (m.t) {
      case 'snapshot-published':
        // NOTE: a publication's readyDocs is the whole ready CORPUS, not the
        // docs this publication committed, and it carries no ingest job — so it
        // cannot correlate a successful ingest job. Ingest jobs are instead
        // retired deliberately: a superseding same-document ingest drops the
        // prior attempt (see ingest()), and a new generation clears them all
        // (see openGeneration()). Clearing here by membership could delete a
        // live re-ingest's job on an unrelated document's publication and then
        // silently swallow that job's later terminal error.
        this.snapshotListener?.({
          generation: m.generation,
          snapshot: m.snapshot,
          readyDocs: m.readyDocs,
          missingDocs: m.missingDocs,
        });
        return;
      case 'progress':
        this.progressListener?.({ doc: m.doc, phase: m.phase, generation: m.generation });
        return;
      case 'generation-ready': {
        const p = this.pending.get(m.job);
        if (p?.kind === 'open') {
          this.pending.delete(m.job);
          // A completed barrier is proof of a functioning worker: reset the
          // restart budget so an old crash doesn't starve a future recovery.
          this.restartAttempts = 0;
          p.resolve({
            generation: m.generation,
            snapshot: m.snapshot,
            readyDocs: m.readyDocs,
            missing: m.missing,
          });
        }
        return;
      }
      case 'result': {
        const p = m.job !== undefined ? this.pending.get(m.job) : undefined;
        if (p?.kind === 'query') {
          this.pending.delete(m.job);
          p.resolve(m.data);
        }
        return;
      }
      case 'cancelled': {
        const p = this.pending.get(m.job);
        if (p) {
          this.pending.delete(m.job);
          p.reject(new WorkerClientError('CANCELLED', 'cancelled'));
        }
        return;
      }
      case 'error': {
        const p = m.job !== undefined ? this.pending.get(m.job) : undefined;
        if (p) {
          this.pending.delete(m.job!);
          p.reject(new WorkerClientError('WORKER_ERROR', `${m.code}: ${m.message}`, m.code));
          return;
        }
        // Uncorrelated errors from ingest jobs surface to the app instead of
        // being dropped (UI review round 1, finding 3). A terminal
        // EXTRACTION_MISMATCH reaches here like any other ingest error — it is
        // reported, never silently turned into a missing-doc retry.
        if (m.job !== undefined && this.ingestJobs.has(m.job)) {
          const info = this.ingestJobs.get(m.job)!;
          this.ingestJobs.delete(m.job);
          this.ingestErrorListener?.(m.generation ?? info.generation, `${m.code}: ${m.message}`, info.doc);
        }
        return;
      }
      case 'warning':
        // Storage health is non-fatal by contract — never routed into
        // ingest-failure or query rejection paths. The codes are all
        // artifact-CACHE degradation (cold recomputes, never data loss), so a
        // console warning is the whole surface; durable user-data failures
        // arrive as typed UserDataClientError rejections instead.
        console.warn(`[texttrends worker] ${m.code}: ${m.message}`);
        return;
      case 'source-ready':
        // The correlated extraction event — surfaced for import assembly. It is
        // NOT ingest completion, and it does not touch the ingest-job
        // bookkeeping (later phases may still fail).
        this.sourceReadyListener?.({
          job: m.job,
          generation: m.generation,
          doc: m.doc,
          source: m.source,
          extractionRecipeHash: m.extractionRecipe,
          text: m.text,
          textLengthUtf16: m.textLengthUtf16,
          candidates: m.candidates,
          decoderReplacementCount: m.decoderReplacementCount,
          suspiciousControlCount: m.suspiciousControlCount,
        });
        return;
      // User-data acknowledgements/errors — resolve/reject the correlated
      // pending request; an uncorrelated ack (a superseded/replaced request) is
      // dropped.
      case 'project-loaded': {
        const p = this.pending.get(m.job);
        if (p?.kind === 'project-load') { this.pending.delete(m.job); p.resolve({ kind: 'loaded', manifest: m.manifest }); }
        return;
      }
      case 'project-missing': {
        const p = this.pending.get(m.job);
        if (p?.kind === 'project-load') { this.pending.delete(m.job); p.resolve({ kind: 'missing' }); }
        return;
      }
      case 'project-saved': {
        const p = this.pending.get(m.job);
        if (p?.kind === 'project-save') { this.pending.delete(m.job); p.resolve({ revision: m.revision }); }
        return;
      }
      case 'source-persisted': {
        const p = this.pending.get(m.job);
        if (p?.kind === 'source-persist') { this.pending.delete(m.job); p.resolve(); }
        return;
      }
      case 'user-data-error': {
        const p = this.pending.get(m.job);
        if (p) { this.pending.delete(m.job); p.reject(new UserDataClientError(m.code, m.message, m.currentRevision)); }
        return;
      }
    }
  }

  private post(message: ToWorkerV4, transfer?: Transferable[]): void {
    // Detachment is synchronous: byteLength before vs after the post proves
    // a real transfer (0 after) rather than a structured clone — for both
    // ingest AND source-persist (a persist RETRY posting again is the
    // browser-observable proof the private File was retained and re-read).
    const bytes = message.t === 'ingest' || message.t === 'source-persist' ? message.bytes : null;
    const before = bytes?.byteLength;
    if (transfer) this.worker.postMessage(message, transfer);
    else this.worker.postMessage(message);
    this.trace?.record({
      direction: 'to-worker',
      t: message.t,
      ...('job' in message ? { job: message.job } : {}),
      ...('generation' in message && typeof message.generation === 'string' ? { generation: message.generation } : {}),
      ...('doc' in message ? { doc: message.doc } : {}),
      ...(message.t === 'query' ? { op: message.query.op } : {}),
      ...(before === undefined ? {} : { transferBytesBefore: before, transferBytesAfter: bytes!.byteLength }),
    });
  }

  openGeneration(
    generation: string,
    docs: readonly GenerationDocSpecV4[],
    indexRecipe: IndexRecipeProvisional,
  ): { result: Promise<GenerationReady>; cancel: () => void } {
    // A closed client is terminal — teardown must never resurrect a Worker.
    if (this.closed) {
      return {
        result: Promise.reject(new WorkerClientError('WORKER_TERMINATED', 'WORKER_TERMINATED: the client was closed')),
        cancel: () => undefined,
      };
    }
    // An explicit new generation is user intent to try again: revive a dead
    // client with a fresh restart budget instead of posting into the void.
    // Revival is TRANSACTIONAL — new Worker() can throw synchronously, and a
    // client marked live while holding a terminated worker would restore the
    // exact hang this state exists to prevent (review round 2). The failure
    // surfaces as the returned rejection so the retry UI stays functional.
    if (this.dead) {
      let replacement: Worker;
      try {
        replacement = this.spawn();
      } catch (e) {
        return {
          result: Promise.reject(
            new WorkerClientError('WORKER_TERMINATED', `WORKER_TERMINATED: replacement worker construction failed (${e instanceof Error ? e.message : String(e)})`),
          ),
          cancel: () => undefined,
        };
      }
      this.worker = replacement;
      this.dead = false;
      this.restartAttempts = 0;
    }
    // A new generation supersedes every prior in-flight ingest: their jobs and
    // any late errors are moot (a superseded ingest answers GENERATION_STALE),
    // so retire them rather than let them accrete or mis-route.
    this.ingestJobs.clear();
    return this.request<GenerationReady>((job, resolve, reject) => {
      this.pending.set(job, { kind: 'open', resolve, reject });
      this.post({ v: PROTOCOL_VERSION_V4, t: 'begin-generation', job, generation, docs, indexRecipe });
    });
  }

  /** Returns the correlation `job` so a caller can match this ingest's
   *  source-ready (and any correlated error, which carries the doc). */
  ingest(generation: string, doc: string, bytes: ArrayBuffer): { job: number } {
    if (this.dead) {
      this.ingestErrorListener?.(generation, 'WORKER_TERMINATED: the analysis worker is not running', doc);
      return { job: -1 };
    }
    // Collect any prior in-flight ingest of the SAME (generation, doc), but
    // retire them only AFTER a successful post: this attempt supersedes them
    // only if the worker actually receives it. If the post throws, the prior
    // ingest is still live, so its correlation must be preserved.
    const priors: number[] = [];
    for (const [prior, info] of this.ingestJobs) {
      if (info.generation === generation && info.doc === doc) priors.push(prior);
    }
    const job = this.nextJob++;
    this.ingestJobs.set(job, { generation, doc });
    try {
      this.post({ v: PROTOCOL_VERSION_V4, t: 'ingest', job, generation, doc, bytes }, [bytes]); // transferred
    } catch (e) {
      // A synchronous postMessage failure (e.g. an already-detached buffer)
      // must surface as a correlated ingest error, not a thrown exception, and
      // must not leave a dangling job — nor retire the still-live prior attempt.
      this.ingestJobs.delete(job);
      this.ingestErrorListener?.(generation, `WORKER_POST_FAILED: ${e instanceof Error ? e.message : String(e)}`, doc);
      return { job: -1 };
    }
    // The worker received the replacement — the prior attempts are now moot.
    for (const prior of priors) this.ingestJobs.delete(prior);
    return { job };
  }

  /** Load a durable project by id. Resolves `loaded` with the WORKER-VALIDATED
   *  manifest or `missing`; rejects UserDataClientError on a corrupt record or
   *  unavailable storage. Cancellable before the worker's read/deep validation
   *  completes. */
  projectLoad(project: string): { result: Promise<ProjectLoadResult>; cancel: () => void } {
    return this.request<ProjectLoadResult>(
      (job, resolve, reject) => {
        this.pending.set(job, { kind: 'project-load', resolve, reject });
        this.post({ v: PROTOCOL_VERSION_V4, t: 'project-load', job, project });
      },
    );
  }

  /** Save a manifest by compare-and-swap. The WORKER deep-validates it at its
   *  trust boundary before any durable write (an invalid one rejects
   *  REQUEST_INVALID). Resolves with the committed revision; rejects
   *  UserDataClientError (REVISION_CONFLICT carries the stored
   *  `currentRevision`). Cancellable before the durable write begins. */
  projectSave(manifest: ProjectManifestV1, expectedRevision: number): { result: Promise<{ revision: number }>; cancel: () => void } {
    return this.request<{ revision: number }>(
      (job, resolve, reject) => {
        this.pending.set(job, { kind: 'project-save', resolve, reject });
        this.post({ v: PROTOCOL_VERSION_V4, t: 'project-save', job, project: manifest.id, manifest, expectedRevision });
      },
    );
  }

  /** Persist opted-in source bytes durably (content-addressed). The bytes are
   *  TRANSFERRED; the worker re-hashes and verifies them against `sourceHash`.
   *  Resolves only after the durable write commits; rejects UserDataClientError.
   *  Cancellable before the durable write begins (a truthful ack wins after). */
  sourcePersist(sourceHash: string, bytes: ArrayBuffer): { result: Promise<void>; cancel: () => void } {
    return this.request<void>(
      (job, resolve, reject) => {
        this.pending.set(job, { kind: 'source-persist', resolve, reject });
        this.post({ v: PROTOCOL_VERSION_V4, t: 'source-persist', job, sourceHash, bytes }, [bytes]);
      },
    );
  }

  /**
   * The ONE correlation+cancel harness for every request/response operation
   * (analysis queries, generation opens, user-data ops): assign a job, set up
   * the pending resolver, POST inside a guard that deletes the exact entry and
   * rejects typed WORKER_POST_FAILED if postMessage throws synchronously
   * (never leaking a pending resolver or throwing from the public method), and
   * expose a NO-THROW best-effort cancel for this job (rejected as CANCELLED
   * by the worker's cancellation, ignored once the operation commits).
   */
  private request<T>(
    send: (job: number, resolve: (r: T) => void, reject: (e: Error) => void) => void,
  ): { result: Promise<T>; cancel: () => void } {
    if (this.dead) {
      return { result: Promise.reject(new WorkerClientError('WORKER_TERMINATED', 'WORKER_TERMINATED: the analysis worker is not running')), cancel: () => undefined };
    }
    const job = this.nextJob++;
    const result = new Promise<T>((resolve, reject) => {
      try {
        send(job, resolve, reject);
      } catch (e) {
        this.pending.delete(job);
        reject(new WorkerClientError('WORKER_POST_FAILED', `WORKER_POST_FAILED: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
    return { result, cancel: () => this.cancelJob(job) };
  }

  /** Best-effort cancellation must never throw: a cancel closure runs inside
   *  supersession and teardown paths that must complete regardless. */
  private cancelJob(job: number): void {
    try {
      this.post({ v: PROTOCOL_VERSION_V4, t: 'cancel', job });
    } catch {
      // The request either settles normally or was already fenced.
    }
  }

  /** Permanently tear the client down (app disposal / Vite HMR replacement):
   *  fence the worker epoch so straggling events are ignored, reject every
   *  pending request with a typed WORKER_TERMINATED, clear job bookkeeping and
   *  listeners, and terminate the Worker. Terminal — close() is not revivable,
   *  and a cancel() closure posting into the terminated Worker is a no-op. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dead = true;
    this.workerEpoch++; // fence any straggling events from the live instance
    for (const [, p] of this.pending) {
      p.reject(new WorkerClientError('WORKER_TERMINATED', 'WORKER_TERMINATED: the client was closed'));
    }
    this.pending.clear();
    this.ingestJobs.clear();
    this.snapshotListener = null;
    this.progressListener = null;
    this.ingestErrorListener = null;
    this.sourceReadyListener = null;
    this.restartListener = null;
    this.worker.terminate();
  }

  query(snapshot: string, query: QueryOpV4): { result: Promise<QueryResultDataV4>; cancel: () => void } {
    return this.request<QueryResultDataV4>((job, resolve, reject) => {
      this.pending.set(job, { kind: 'query', resolve, reject });
      this.post({ v: PROTOCOL_VERSION_V4, t: 'query', job, snapshot, query });
    });
  }
}
