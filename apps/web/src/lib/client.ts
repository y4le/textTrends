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

import type { IndexRecipeProvisional } from '@texttrends/core';
import type {
  FromWorker,
  GenerationDocSpec,
  MissingWarmDoc,
  QueryOp,
  QueryResultData,
  StorageWarningCode,
  ToWorker,
} from '../worker/protocol.ts';
import { PROTOCOL_VERSION } from '../worker/protocol.ts';
import type { ProtocolTraceSink } from './trace.ts';

export interface SnapshotInfo {
  readonly snapshot: string;
  readonly readyDocs: readonly string[];
  readonly missingDocs: readonly string[];
}

export interface IngestProgress {
  readonly doc: string;
  readonly phase: string;
}

/** Resolution of openGeneration: warm rehydration finished; exactly
 *  `missing` still need their bytes ingested. */
export interface GenerationReady {
  readonly generation: string;
  readonly snapshot: string | null;
  readonly readyDocs: readonly string[];
  readonly missing: readonly MissingWarmDoc[];
}

/** Bounded automatic restarts — a deterministic startup fault must not
 *  crash-loop forever; the last failure surfaces as fatal. */
const MAX_WORKER_RESTARTS = 3;

type Pending =
  | { kind: 'query'; resolve: (r: QueryResultData) => void; reject: (e: Error) => void }
  | { kind: 'excerpt'; resolve: (text: string) => void; reject: (e: Error) => void }
  | { kind: 'open'; resolve: (r: GenerationReady) => void; reject: (e: Error) => void };

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
  private nextJob = 1;
  private readonly pending = new Map<number, Pending>();
  private snapshotListener: ((info: SnapshotInfo) => void) | null = null;
  private progressListener: ((p: IngestProgress) => void) | null = null;
  private ingestErrorListener: ((generation: string, message: string) => void) | null = null;
  private warningListener: ((code: StorageWarningCode, message: string) => void) | null = null;
  private restartListener: ((fatal: boolean) => void) | null = null;
  private readonly ingestJobs = new Map<number, string>(); // job -> generation
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
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
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
      p.reject(new Error('WORKER_RESTARTED'));
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
  onIngestError(listener: (generation: string, message: string) => void): void {
    this.ingestErrorListener = listener;
  }
  onWarning(listener: (code: StorageWarningCode, message: string) => void): void {
    this.warningListener = listener;
  }
  /** fatal=false: a replacement worker is live — re-open the generation.
   *  fatal=true: restarts are exhausted; surface the failure. */
  onRestart(listener: (fatal: boolean) => void): void {
    this.restartListener = listener;
  }

  private receive(m: FromWorker): void {
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
        this.snapshotListener?.({
          snapshot: m.snapshot,
          readyDocs: m.readyDocs,
          missingDocs: m.missingDocs,
        });
        return;
      case 'progress':
        this.progressListener?.({ doc: m.doc, phase: m.phase });
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
      case 'excerpt-result': {
        const p = this.pending.get(m.job);
        if (p?.kind === 'excerpt') {
          this.pending.delete(m.job);
          p.resolve(m.text);
        }
        return;
      }
      case 'cancelled': {
        const p = this.pending.get(m.job);
        if (p) {
          this.pending.delete(m.job);
          p.reject(new Error('cancelled'));
        }
        return;
      }
      case 'error': {
        const p = m.job !== undefined ? this.pending.get(m.job) : undefined;
        if (p) {
          this.pending.delete(m.job!);
          p.reject(new Error(`${m.code}: ${m.message}`));
          return;
        }
        // Uncorrelated errors from ingest jobs surface to the app instead of
        // being dropped (UI review round 1, finding 3).
        if (m.job !== undefined && this.ingestJobs.has(m.job)) {
          const generation = m.generation ?? this.ingestJobs.get(m.job)!;
          this.ingestJobs.delete(m.job);
          this.ingestErrorListener?.(generation, `${m.code}: ${m.message}`);
        }
        return;
      }
      case 'warning':
        // Storage health is non-fatal by contract — never routed into
        // ingest-failure or query rejection paths.
        if (this.warningListener) this.warningListener(m.code, m.message);
        else console.warn(`[texttrends worker] ${m.code}: ${m.message}`);
        return;
      case 'source-ready':
        return;
    }
  }

  private post(message: ToWorker, transfer?: Transferable[]): void {
    // Detachment is synchronous: byteLength before vs after the post proves
    // a real transfer (0 after) rather than a structured clone.
    const bytes = message.t === 'ingest' ? message.bytes : null;
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
    docs: readonly GenerationDocSpec[],
    recipe: IndexRecipeProvisional,
  ): { result: Promise<GenerationReady>; cancel: () => void } {
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
            new Error(`WORKER_TERMINATED: replacement worker construction failed (${e instanceof Error ? e.message : String(e)})`),
          ),
          cancel: () => undefined,
        };
      }
      this.worker = replacement;
      this.dead = false;
      this.restartAttempts = 0;
    }
    const job = this.nextJob++;
    const result = new Promise<GenerationReady>((resolve, reject) => {
      this.pending.set(job, { kind: 'open', resolve, reject });
    });
    this.post({ v: PROTOCOL_VERSION, t: 'begin-generation', job, generation, docs, recipe });
    return {
      result,
      cancel: () => this.post({ v: PROTOCOL_VERSION, t: 'cancel', job }),
    };
  }

  ingest(generation: string, doc: string, bytes: ArrayBuffer): void {
    if (this.dead) {
      this.ingestErrorListener?.(generation, 'WORKER_TERMINATED: the analysis worker is not running');
      return;
    }
    const job = this.nextJob++;
    this.ingestJobs.set(job, generation);
    this.post(
      { v: PROTOCOL_VERSION, t: 'ingest', job, generation, doc, bytes },
      [bytes], // transferred, zero-copy
    );
  }

  query(snapshot: string, query: QueryOp): { result: Promise<QueryResultData>; cancel: () => void } {
    if (this.dead) {
      return {
        result: Promise.reject(new Error('WORKER_TERMINATED: the analysis worker is not running')),
        cancel: () => undefined,
      };
    }
    const job = this.nextJob++;
    const result = new Promise<QueryResultData>((resolve, reject) => {
      this.pending.set(job, { kind: 'query', resolve, reject });
    });
    this.post({ v: PROTOCOL_VERSION, t: 'query', job, snapshot, query });
    return {
      result,
      cancel: () => this.post({ v: PROTOCOL_VERSION, t: 'cancel', job }),
    };
  }

  excerpt(snapshot: string, doc: string, charStart: number, charEnd: number): Promise<string> {
    if (this.dead) {
      return Promise.reject(new Error('WORKER_TERMINATED: the analysis worker is not running'));
    }
    const job = this.nextJob++;
    const result = new Promise<string>((resolve, reject) => {
      this.pending.set(job, { kind: 'excerpt', resolve, reject });
    });
    this.post({ v: PROTOCOL_VERSION, t: 'excerpt', job, snapshot, doc, charStart, charEnd });
    return result;
  }
}
