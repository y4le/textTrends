/**
 * WorkerClient restart machinery against a stubbed Worker global — the
 * review-mandated coverage for restart exhaustion and revival. Real worker
 * death in a browser is Milestone 6 Playwright scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerClient, UserDataClientError, type GenerationReady, type ProjectLoadResult, type SourceReadyInfo } from '../src/lib/client.ts';
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

describe('WorkerClient restart machinery', () => {
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
    await expect(client.excerpt('snap', 'a', 0, 1)).rejects.toThrow('WORKER_TERMINATED');
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
        missing: [],
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
        generation: 'gen-retry-2', snapshot: null, readyDocs: [], missing: [],
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
        generation: 'gen-1', snapshot: null, readyDocs: [], missing: [],
      },
    });
    // No pending entry may have been resurrected by the stale message.
    await expect(open.result).rejects.toThrow('WORKER_RESTARTED');
  });
});

describe('WorkerClient v4 wire', () => {
  const spec = (doc: string) => ({
    doc, language: 'en',
    source: { byteLength: 8, format: 'txt' as const, availability: 'external' as const },
    extraction: { recipe: {} as never, recipeHash: 'er' },
    structure: { recipe: {} as never, recipeHash: 'sr', override: { kind: 'none' as const } },
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

  it('propagates the structured MissingWarmDocV4 array from the barrier', async () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const open = client.openGeneration('g', [spec('a')], DEFAULT_INDEX_RECIPE);
    const job = (worker.posted[0] as { job: number }).job;
    worker.onmessage?.({
      data: {
        v: PROTOCOL_VERSION_V4, t: 'generation-ready', job, generation: 'g', snapshot: null,
        readyDocs: [], missing: [{ doc: 'a', need: 'source-bytes', reason: 'extraction-miss' }],
      },
    });
    const ready = await open.result;
    expect(ready.missing).toEqual([{ doc: 'a', need: 'source-bytes', reason: 'extraction-miss' }]);
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
});

describe('WorkerClient user-data seam (v4)', () => {
  const manifest = { schema: 'texttrends/project/1', id: 'p', revision: 3 } as never;

  it('projectLoad resolves loaded/missing and rejects a typed user-data error', async () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const loaded = client.projectLoad('p');
    const job1 = (worker.posted.at(-1) as { job: number; t: string; project: string }).job;
    expect((worker.posted.at(-1) as { t: string }).t).toBe('project-load');
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'project-loaded', job: job1, project: 'p', manifest } });
    await expect(loaded.result).resolves.toEqual({ kind: 'loaded', manifest } as ProjectLoadResult);

    const missing = client.projectLoad('q');
    const job2 = (worker.posted.at(-1) as { job: number }).job;
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'project-missing', job: job2, project: 'q' } });
    await expect(missing.result).resolves.toEqual({ kind: 'missing' } as ProjectLoadResult);

    const corrupt = client.projectLoad('bad');
    const job3 = (worker.posted.at(-1) as { job: number }).job;
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'user-data-error', job: job3, code: 'DATA_CORRUPT', message: 'invalid manifest' } });
    await expect(corrupt.result).rejects.toBeInstanceOf(UserDataClientError);
    await expect(corrupt.result).rejects.toMatchObject({ code: 'DATA_CORRUPT' });
  });

  it('projectSave resolves the committed revision and surfaces REVISION_CONFLICT with currentRevision', async () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const saved = client.projectSave(manifest, 2);
    const job1 = (worker.posted.at(-1) as { job: number }).job;
    const post = worker.posted.at(-1) as { t: string; expectedRevision: number; project: string };
    expect(post.t).toBe('project-save');
    expect(post.expectedRevision).toBe(2);
    expect(post.project).toBe('p');
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'project-saved', job: job1, project: 'p', revision: 3 } });
    await expect(saved.result).resolves.toEqual({ revision: 3 });

    const conflict = client.projectSave(manifest, 2);
    const job2 = (worker.posted.at(-1) as { job: number }).job;
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'user-data-error', job: job2, code: 'REVISION_CONFLICT', message: 'stale', currentRevision: 5 } });
    await expect(conflict.result).rejects.toMatchObject({ code: 'REVISION_CONFLICT', currentRevision: 5 });
  });

  it('sourcePersist TRANSFERS the bytes and resolves only on the durable ack', async () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const bytes = new ArrayBuffer(16);
    const persist = client.sourcePersist('deadbeef', bytes);
    const post = worker.posted.at(-1) as { t: string; sourceHash: string; job: number };
    expect(post.t).toBe('source-persist');
    expect(post.sourceHash).toBe('deadbeef');
    expect(worker.transfers.at(-1)).toEqual([bytes]); // transferred, not cloned
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'source-persisted', job: post.job, sourceHash: 'deadbeef' } });
    await expect(persist.result).resolves.toBeUndefined();
  });

  it('a user-data request is cancellable: cancel posts a job cancel and the worker ack rejects it', async () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const load = client.projectLoad('p');
    const job = (worker.posted.at(-1) as { job: number }).job;
    load.cancel();
    const cancelPost = worker.posted.at(-1) as { t: string; job: number };
    expect(cancelPost).toMatchObject({ t: 'cancel', job });
    // The worker acknowledges the cancel before its durable read completes.
    worker.onmessage?.({ data: { v: PROTOCOL_VERSION_V4, t: 'cancelled', job } });
    await expect(load.result).rejects.toThrow('cancelled');
  });

  it('a synchronous postMessage failure rejects the request and leaves NO dangling pending entry', async () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    worker.postMessage = () => { throw new DOMException('detached', 'DataCloneError'); };
    const persist = client.sourcePersist('h', new ArrayBuffer(4));
    await expect(persist.result).rejects.toThrow('WORKER_POST_FAILED');
    // No leaked resolver: a late (impossible) ack would find nothing to settle.
    expect((client as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
  });

  it('surfaces source-ready as a fully correlated SourceReadyInfo (wire extractionRecipe -> extractionRecipeHash)', () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const infos: SourceReadyInfo[] = [];
    client.onSourceReady((i) => infos.push(i));
    worker.onmessage?.({
      data: {
        v: PROTOCOL_VERSION_V4, t: 'source-ready', job: 7, generation: 'g', doc: 'a',
        source: { hash: 'sh', byteLength: 10, format: 'txt', encoding: { detected: 'utf-8', hadReplacementChars: false } },
        extractionRecipe: 'erh', text: 'th', textLengthUtf16: 10, candidates: 'ch',
        decoderReplacementCount: 0, suspiciousControlCount: 2,
      },
    });
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ job: 7, generation: 'g', doc: 'a', extractionRecipeHash: 'erh', text: 'th', textLengthUtf16: 10, candidates: 'ch', suspiciousControlCount: 2 });
    expect(infos[0]!.source.hash).toBe('sh');
  });

  it('rejects every in-flight user-data request when the worker dies', async () => {
    const client = new WorkerClient();
    const worker = FakeWorker.instances[0]!;
    const load = client.projectLoad('p');
    const save = client.projectSave(manifest, 2);
    const persist = client.sourcePersist('h', new ArrayBuffer(4));
    worker.onerror?.(new Event('error')); // death: pending all reject
    await expect(load.result).rejects.toThrow('WORKER_RESTARTED');
    await expect(save.result).rejects.toThrow('WORKER_RESTARTED');
    await expect(persist.result).rejects.toThrow('WORKER_RESTARTED');
  });

  it('a dead client rejects user-data requests immediately', async () => {
    const client = new WorkerClient();
    for (let i = 0; i < 4; i++) FakeWorker.instances.at(-1)!.onerror?.(new Event('error')); // exhaust → dead
    await expect(client.projectLoad('p').result).rejects.toThrow('WORKER_TERMINATED');
    await expect(client.projectSave(manifest, 2).result).rejects.toThrow('WORKER_TERMINATED');
    await expect(client.sourcePersist('h', new ArrayBuffer(4)).result).rejects.toThrow('WORKER_TERMINATED');
  });
});
