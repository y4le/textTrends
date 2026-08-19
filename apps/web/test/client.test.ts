/**
 * WorkerClient restart machinery against a stubbed Worker global — the
 * review-mandated coverage for restart exhaustion and revival. Real worker
 * death in a browser is Milestone 6 Playwright scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerClient, type GenerationReady, type SourceReadyInfo } from '../src/lib/client.ts';
import { PROTOCOL_VERSION_V4 } from '../src/worker/protocol-v4.ts';
import { DEFAULT_INDEX_RECIPE } from '@texttrends/core';

class FakeWorker {
  static instances: FakeWorker[] = [];
  static throwOnConstruct = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  readonly posted: unknown[] = [];
  readonly transfers: (Transferable[] | undefined)[] = [];
  terminated = false;
  constructor() {
    if (FakeWorker.throwOnConstruct) {
      throw new Error('no more workers');
    }
    FakeWorker.instances.push(this);
  }
  postMessage(m: unknown, transfer?: Transferable[]): void {
    this.posted.push(m);
    this.transfers.push(transfer);
  }
  terminate(): void {
    this.terminated = true;
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.throwOnConstruct = false;
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('WorkerClient close()', () => {
  it('rejects every pending request typed, terminates the Worker, and is NOT revivable', async () => {
    const client = new WorkerClient();
    const query = client.query('snap', { op: 'trend' } as never);
    client.close();
    await expect(query.result).rejects.toMatchObject({ name: 'WorkerClientError', code: 'WORKER_TERMINATED' });
    expect(FakeWorker.instances.at(-1)!.terminated).toBe(true);
    // Unlike restart exhaustion, openGeneration must NOT revive a closed
    // client — teardown (disposal/HMR) is terminal.
    const open = client.openGeneration('g', [], DEFAULT_INDEX_RECIPE);
    await expect(open.result).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    expect(FakeWorker.instances.length).toBe(1); // no replacement Worker spawned
  });

  it('fences straggling events: a message from the terminated instance is ignored', () => {
    const client = new WorkerClient();
    const phases: string[] = [];
    client.onProgress((p) => phases.push(p.phase));
    const worker = FakeWorker.instances.at(-1)!;
    // Delivered before close: proves the listener/event pair is actually live.
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'progress', job: 1, generation: 'g', phase: 'decode', doc: 'a' } });
    expect(phases).toEqual(['decode']);
    client.close();
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'progress', job: 1, generation: 'g', phase: 'extract', doc: 'a' } });
    expect(phases).toEqual(['decode']); // listeners cleared
    // Re-register AFTER close: only the worker-epoch fence can block delivery
    // now, so this pins the fence independently of listener clearing.
    client.onProgress((p) => phases.push(p.phase));
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'progress', job: 1, generation: 'g', phase: 'segment', doc: 'a' } });
    expect(phases).toEqual(['decode']); // epoch fenced
  });

  it('a synchronous post failure in query()/openGeneration() rejects typed and never throws', async () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances.at(-1)!;
    worker.postMessage = () => {
      throw new DOMException('detached', 'DataCloneError');
    };
    const q = client.query('snap', { op: 'trend' } as never);
    await expect(q.result).rejects.toMatchObject({ name: 'WorkerClientError', code: 'WORKER_POST_FAILED' });
    const open = client.openGeneration('g', [], DEFAULT_INDEX_RECIPE);
    await expect(open.result).rejects.toMatchObject({ name: 'WorkerClientError', code: 'WORKER_POST_FAILED' });
    // The cancel closures are best-effort no-throw even though posting fails.
    expect(() => q.cancel()).not.toThrow();
    expect(() => open.cancel()).not.toThrow();
  });
});

describe('WorkerClient restart machinery', () => {
  it('reports sanitized health and explicitly revives a fatally exhausted worker', () => {
    const client = new WorkerClient();
    const first = FakeWorker.instances.at(-1)!;
    first.onmessage?.({
      data: {
        v: PROTOCOL_VERSION_V4,
        t: 'warning',
        code: 'CACHE_WRITE_FAILED',
        message: 'sensitive implementation detail',
      },
    });
    for (let i = 0; i < 4; i++) FakeWorker.instances.at(-1)!.onerror?.(new Event('error'));

    expect(client.diagnostics()).toEqual({
      health: 'dead',
      restartCount: 4,
      pendingRequests: 0,
      lastStorageWarning: { code: 'CACHE_WRITE_FAILED' },
    });
    expect(client.restartNow()).toBe(true);
    expect(FakeWorker.instances.length).toBe(5);
    expect(client.diagnostics()).toMatchObject({ health: 'live', restartCount: 5 });
  });

  it('bounded restarts: each death respawns until the budget is exhausted, then fatal', () => {
    const restarts: boolean[] = [];
    const client = new WorkerClient();
    client.onRestart((fatal) => restarts.push(fatal));
    expect(FakeWorker.instances.length).toBe(1);
    // Three deaths: three respawns, all non-fatal.
    for (let i = 0; i < 3; i++) FakeWorker.instances.at(-1)!.onerror?.(new Event('error'));
    expect(FakeWorker.instances.length).toBe(4);
    expect(restarts).toEqual([false, false, false]);
    // The fourth death exhausts the budget: fatal, no replacement.
    FakeWorker.instances.at(-1)!.onerror?.(new Event('error'));
    expect(FakeWorker.instances.length).toBe(4);
    expect(restarts).toEqual([false, false, false, true]);
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
  });

  it('after fatal exhaustion, queries reject immediately instead of hanging forever', async () => {
    const client = new WorkerClient();
    for (let i = 0; i < 4; i++) FakeWorker.instances.at(-1)!.onerror?.(new Event('error'));
    // The old failure mode: this posted into a terminated worker and the
    // promise stayed pending forever (review P2).
    await expect(client.query('snap', { op: 'trend' } as never).result).rejects.toThrow('WORKER_TERMINATED');
    const errors: string[] = [];
    client.onIngestError((_g, message) => errors.push(message));
    client.ingest('gen', 'a', new ArrayBuffer(1));
    expect(errors.some((m) => m.includes('WORKER_TERMINATED'))).toBe(true);
  });

  it('a user-initiated openGeneration REVIVES a dead client with a fresh budget', async () => {
    const restarts: boolean[] = [];
    const client = new WorkerClient();
    client.onRestart((fatal) => restarts.push(fatal));
    for (let i = 0; i < 4; i++) FakeWorker.instances.at(-1)!.onerror?.(new Event('error'));
    expect(restarts.at(-1)).toBe(true);
    expect(FakeWorker.instances.length).toBe(4);

    // The retry action: a fresh generation spawns a NEW worker and posts to
    // IT, not into a terminated instance.
    const open = client.openGeneration('gen-retry', [], DEFAULT_INDEX_RECIPE);
    expect(FakeWorker.instances.length).toBe(5);
    const revived = FakeWorker.instances.at(-1)!;
    expect(revived.terminated).toBe(false);
    expect(revived.posted.length).toBe(1);
    const posted = revived.posted[0] as { t: string; job: number; generation: string };
    expect(posted.t).toBe('begin-generation');

    // The revived worker answers, and the barrier resolves.
    revived.onmessage?.({
      data: {
        v: PROTOCOL_VERSION_V4,
        t: 'generation-ready',
        job: posted.job,
        generation: 'gen-retry',
        snapshot: null,
        readyDocs: [],
        missingDocs: [],
      },
    });
    const ready: GenerationReady = await open.result;
    expect(ready.generation).toBe('gen-retry');

    // The budget reset: a post-revival death respawns again (non-fatal).
    revived.onerror?.(new Event('error'));
    expect(restarts.at(-1)).toBe(false);
    expect(FakeWorker.instances.length).toBe(6);
  });

  it('a throwing replacement constructor keeps the client dead; a later retry still revives', async () => {
    // Review round 2: revival must be transactional — a synchronous
    // new Worker() failure must not mark the client live while it still
    // holds the terminated instance.
    const client = new WorkerClient();
    for (let i = 0; i < 4; i++) FakeWorker.instances.at(-1)!.onerror?.(new Event('error'));
    expect(FakeWorker.instances.length).toBe(4);

    FakeWorker.throwOnConstruct = true;
    const failed = client.openGeneration('gen-retry', [], DEFAULT_INDEX_RECIPE);
    await expect(failed.result).rejects.toThrow('WORKER_TERMINATED');
    expect(FakeWorker.instances.length).toBe(4); // nothing spawned
    // STILL dead: requests keep rejecting immediately, none post anywhere.
    await expect(client.query('snap', { op: 'trend' } as never).result).rejects.toThrow('WORKER_TERMINATED');
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
    expect(FakeWorker.instances.flatMap((w) => w.posted).length).toBe(0); // nothing ever posted into the void

    // Construction works again: the SAME retry path now revives cleanly.
    FakeWorker.throwOnConstruct = false;
    const open = client.openGeneration('gen-retry-2', [], DEFAULT_INDEX_RECIPE);
    expect(FakeWorker.instances.length).toBe(5);
    const revived = FakeWorker.instances.at(-1)!;
    const posted = revived.posted[0] as { job: number };
    revived.onmessage?.({
      data: {
        v: PROTOCOL_VERSION_V4, t: 'generation-ready', job: posted.job,
        generation: 'gen-retry-2', snapshot: null, readyDocs: [], missingDocs: [],
      },
    });
    await expect(open.result).resolves.toMatchObject({ generation: 'gen-retry-2' });
  });

  it('messages from a replaced worker instance are fenced by epoch', async () => {
    const client = new WorkerClient();
    const first = FakeWorker.instances[0]!;
    const open = client.openGeneration('gen-1', [], DEFAULT_INDEX_RECIPE);
    const posted = first.posted[0] as { job: number };
    let settled = false;
    open.result.then(() => (settled = true), () => (settled = true));
    // Kill the first worker; its late barrier must be ignored (and the open
    // promise rejects via the restart path, not resolves).
    first.onerror?.(new Event('error'));
    await flush();
    expect(settled).toBe(true); // rejected WORKER_RESTARTED
    first.onmessage?.({
      data: {
        v: PROTOCOL_VERSION_V4, t: 'generation-ready', job: posted.job,
        generation: 'gen-1', snapshot: null, readyDocs: [], missingDocs: [],
      },
    });
    // No pending entry may have been resurrected by the stale message.
    await expect(open.result).rejects.toThrow('WORKER_RESTARTED');
  });
});

describe('WorkerClient v4 wire', () => {
  const spec = (doc: string) => ({
    doc, language: 'en',
    source: { byteLength: 8, format: 'txt' as const },
    extraction: { recipe: {} as never, recipeHash: 'er' },
  });

  it('begin-generation posts v4 with an `indexRecipe` field and the v4 spec array', () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    client.openGeneration('g', [spec('a')], DEFAULT_INDEX_RECIPE);
    const posted = worker.posted[0] as { v: number; t: string; indexRecipe: unknown; recipe?: unknown; docs: unknown[] };
    expect(posted.v).toBe(PROTOCOL_VERSION_V4);
    expect(posted.t).toBe('begin-generation');
    expect(posted.indexRecipe).toBe(DEFAULT_INDEX_RECIPE);
    expect('recipe' in posted).toBe(false); // v3 field is gone
    expect((posted.docs[0] as { doc: string }).doc).toBe('a');
  });

  it('propagates the source-byte misses from the warm-open barrier', async () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const open = client.openGeneration('g', [spec('a')], DEFAULT_INDEX_RECIPE);
    const job = (worker.posted[0] as { job: number }).job;
    worker.onmessage?.({
      data: {
        v: PROTOCOL_VERSION_V4, t: 'generation-ready', job, generation: 'g', snapshot: null,
        readyDocs: [], missingDocs: ['a'],
      },
    });
    const ready = await open.result;
    expect(ready.missingDocs).toEqual(['a']);
  });

  it('an unrelated document publication does NOT retire a live re-ingest job (no error is swallowed)', () => {
    // The bug a cumulative-membership cleanup would introduce: 'a' is already
    // ready, a NEW ingest of 'a' is in flight, and an unrelated ingest of 'b'
    // publishes a snapshot whose readyDocs still contains 'a'. That publication
    // must NOT retire the live 'a' job, or its later terminal error is lost.
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const errors: string[] = [];
    client.onIngestError((_g, m) => errors.push(m));
    client.ingest('g', 'a', new ArrayBuffer(4)); // the live re-ingest of 'a'
    const jobA = (worker.posted.at(-1) as { job: number }).job;
    // An unrelated 'b' publication that happens to report 'a' ready too.
    worker.onmessage?.({
      data: { v: PROTOCOL_VERSION_V4, t: 'snapshot-published', generation: 'g', snapshot: 's1', readyDocs: ['a', 'b'], missingDocs: [] },
    });
    // 'a' genuinely fails — its error must still reach the app.
    worker.onmessage?.({
      data: { v: PROTOCOL_VERSION_V4, t: 'error', job: jobA, generation: 'g', code: 'EXTRACTION_MISMATCH', message: 're-ingest failed', recoverable: true },
    });
    expect(errors).toEqual(['EXTRACTION_MISMATCH: re-ingest failed']);
  });

  it('a superseding same-document ingest retires the prior attempt; a new generation clears all', () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const errors: string[] = [];
    client.onIngestError((_g, m) => errors.push(m));
    client.ingest('g', 'a', new ArrayBuffer(4));
    const jobA1 = (worker.posted.at(-1) as { job: number }).job;
    client.ingest('g', 'a', new ArrayBuffer(4)); // supersedes A1
    // A late error for the SUPERSEDED attempt is moot and dropped.
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'error', job: jobA1, generation: 'g', code: 'INTERNAL', message: 'stale', recoverable: true } });
    expect(errors).toEqual([]);
    // A new generation retires every prior ingest job.
    client.ingest('g', 'b', new ArrayBuffer(4));
    const jobB = (worker.posted.at(-1) as { job: number }).job;
    client.openGeneration('g2', [], DEFAULT_INDEX_RECIPE);
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'error', job: jobB, generation: 'g', code: 'INTERNAL', message: 'moot', recoverable: true } });
    expect(errors).toEqual([]); // the superseded-generation job was cleared
  });

  it('an ingest error BEFORE publication still surfaces to the app', () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const ingestErrors: string[] = [];
    client.onIngestError((_g, m) => ingestErrors.push(m));
    client.ingest('g', 'a', new ArrayBuffer(4));
    const job = (worker.posted.at(-1) as { job: number }).job;
    worker.onmessage?.({
      data: { v: PROTOCOL_VERSION_V4, t: 'error', job, generation: 'g', code: 'EXTRACTION_MISMATCH', message: 'stale', recoverable: true },
    });
    expect(ingestErrors).toEqual(['EXTRACTION_MISMATCH: stale']);
  });

  it('ingest returns its correlation job, and a correlated error carries the doc', () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const errors: { message: string; doc?: string | undefined }[] = [];
    client.onIngestError((_g, message, doc) => errors.push({ message, doc }));
    const { job } = client.ingest('g', 'a', new ArrayBuffer(4));
    expect((worker.posted.at(-1) as { job: number }).job).toBe(job);
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'error', job, generation: 'g', code: 'DECODE_FAILED', message: 'boom', recoverable: true } });
    expect(errors).toEqual([{ message: 'DECODE_FAILED: boom', doc: 'a' }]);
  });

  it('a FAILED same-document replacement post does not retire the still-live prior ingest', () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const errors: { message: string; doc?: string | undefined }[] = [];
    client.onIngestError((_g, message, doc) => errors.push({ message, doc }));
    const a1 = client.ingest('g', 'a', new ArrayBuffer(4)); // A1 posts fine, stays live
    const realPost = worker.postMessage.bind(worker);
    let throwNext = true;
    worker.postMessage = (m: unknown, transfer?: Transferable[]) => {
      if (throwNext) { throwNext = false; throw new DOMException('detached', 'DataCloneError'); }
      realPost(m, transfer);
    };
    client.ingest('g', 'a', new ArrayBuffer(4)); // A2's post throws — A1 must NOT be retired
    // A1 (still live in the worker) later fails terminally — its error must surface.
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'error', job: a1.job, generation: 'g', code: 'DECODE_FAILED', message: 'a1 failed', recoverable: true } });
    expect(errors.some((e) => e.message === 'DECODE_FAILED: a1 failed' && e.doc === 'a')).toBe(true);
  });

  it('source-ready is NOT ingest completion: a later terminal error for the same job still surfaces', () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const errors: string[] = [];
    client.onIngestError((_g, message) => errors.push(message));
    const { job } = client.ingest('g', 'a', new ArrayBuffer(4));
    // The extraction event arrives — it must NOT retire the ingest job.
    worker.onmessage?.({
      data: {
        v: PROTOCOL_VERSION_V4, t: 'source-ready', job, generation: 'g', doc: 'a',
        source: { hash: 'sh', byteLength: 4, format: 'txt', encoding: { detected: 'utf-8', hadReplacementChars: false } },
        extractionRecipe: 'erh', text: 'th', textLengthUtf16: 4, candidates: 'ch',
        decoderReplacementCount: 0, suspiciousControlCount: 0,
      },
    });
    // A LATER phase (index/structure/compose) fails for the same job — the error
    // must still reach the app because the job was never retired.
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'error', job, generation: 'g', code: 'INTERNAL', message: 'index blew up', recoverable: true } });
    expect(errors).toEqual(['INTERNAL: index blew up']);
  });

  it('surfaces source-ready as a fully correlated SourceReadyInfo', () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const infos: SourceReadyInfo[] = [];
    client.onSourceReady((i) => infos.push(i));
    worker.onmessage?.({
      data: {
        v: PROTOCOL_VERSION_V4, t: 'source-ready', job: 7, generation: 'g', doc: 'a',
        source: { hash: 'sh', byteLength: 10, format: 'txt', encoding: { detected: 'utf-8', hadReplacementChars: false } },
        extractionRecipe: 'erh', text: 'th', textLengthUtf16: 10,
        decoderReplacementCount: 0, suspiciousControlCount: 2,
      },
    });
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ job: 7, generation: 'g', doc: 'a', extractionRecipeHash: 'erh', text: 'th', textLengthUtf16: 10, suspiciousControlCount: 2 });
    expect(infos[0]!.source.hash).toBe('sh');
  });
});
