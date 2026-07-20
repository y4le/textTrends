/**
 * WorkerClient restart machinery against a stubbed Worker global — the
 * review-mandated coverage for restart exhaustion and revival. Real worker
 * death in a browser is Milestone 6 Playwright scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerClient, type GenerationReady } from '../src/lib/client.ts';
import { PROTOCOL_VERSION } from '../src/worker/protocol.ts';
import { DEFAULT_INDEX_RECIPE } from '@texttrends/core';

class FakeWorker {
  static instances: FakeWorker[] = [];
  static throwOnConstruct = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;
  constructor() {
    if (FakeWorker.throwOnConstruct) {
      throw new Error('no more workers');
    }
    FakeWorker.instances.push(this);
  }
  postMessage(m: unknown): void {
    this.posted.push(m);
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
        v: PROTOCOL_VERSION,
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
        v: PROTOCOL_VERSION, t: 'generation-ready', job: posted.job,
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
        v: PROTOCOL_VERSION, t: 'generation-ready', job: posted.job,
        generation: 'gen-1', snapshot: null, readyDocs: [], missing: [],
      },
    });
    // No pending entry may have been resurrected by the stale message.
    await expect(open.result).rejects.toThrow('WORKER_RESTARTED');
  });
});
