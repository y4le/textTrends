/**
 * Main-thread worker client: job correlation, snapshot tracking, typed
 * requests. The main thread owns user intent (current generation, live
 * snapshot id, active jobs); the worker owns analysis and residency.
 * Corpus bytes are TRANSFERRED, never cloned.
 */

import type { IndexRecipeProvisional } from '@texttrends/core';
import type {
  FromWorker,
  GenerationDocSpec,
  QueryOp,
  QueryResultData,
  ToWorker,
} from '../worker/protocol.ts';
import { PROTOCOL_VERSION } from '../worker/protocol.ts';

export interface SnapshotInfo {
  readonly snapshot: string;
  readonly readyDocs: readonly string[];
  readonly missingDocs: readonly string[];
}

export interface IngestProgress {
  readonly doc: string;
  readonly phase: string;
}

type Pending =
  | { kind: 'query'; resolve: (r: QueryResultData) => void; reject: (e: Error) => void }
  | { kind: 'excerpt'; resolve: (text: string) => void; reject: (e: Error) => void };

export class WorkerClient {
  private readonly worker: Worker;
  private nextJob = 1;
  private readonly pending = new Map<number, Pending>();
  private snapshotListener: ((info: SnapshotInfo) => void) | null = null;
  private progressListener: ((p: IngestProgress) => void) | null = null;
  private ingestErrorListener: ((generation: string, message: string) => void) | null = null;
  private readonly ingestJobs = new Map<number, string>(); // job -> generation

  constructor() {
    this.worker = new Worker(new URL('../worker/index.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
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

  private receive(m: FromWorker): void {
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
      case 'source-ready':
        return;
      case 'warning':
        // Storage health is non-fatal by contract; surfaced fully when the
        // warm-open client flow lands (M5 client commit).
        console.warn(`[texttrends worker] ${m.code}: ${m.message}`);
        return;
      case 'generation-ready':
        // Consumed by openGeneration in the M5 client commit.
        return;
    }
  }

  private post(message: ToWorker, transfer?: Transferable[]): void {
    if (transfer) this.worker.postMessage(message, transfer);
    else this.worker.postMessage(message);
  }

  beginGeneration(generation: string, docs: readonly GenerationDocSpec[], recipe: IndexRecipeProvisional): void {
    this.post({ v: PROTOCOL_VERSION, t: 'begin-generation', job: this.nextJob++, generation, docs, recipe });
  }

  ingest(generation: string, doc: string, bytes: ArrayBuffer): void {
    const job = this.nextJob++;
    this.ingestJobs.set(job, generation);
    this.post(
      { v: PROTOCOL_VERSION, t: 'ingest', job, generation, doc, bytes },
      [bytes], // transferred, zero-copy
    );
  }

  query(snapshot: string, query: QueryOp): { result: Promise<QueryResultData>; cancel: () => void } {
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
    const job = this.nextJob++;
    const result = new Promise<string>((resolve, reject) => {
      this.pending.set(job, { kind: 'excerpt', resolve, reject });
    });
    this.post({ v: PROTOCOL_VERSION, t: 'excerpt', job, snapshot, doc, charStart, charEnd });
    return result;
  }
}
