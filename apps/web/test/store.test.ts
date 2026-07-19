import { describe, expect, it } from 'vitest';
import { createAppStore, SHERLOCK, type ClientLike } from '../src/lib/store.ts';
import type { QueryResultData } from '../src/worker/protocol.ts';
import type { NumericTrend } from '@texttrends/core';

interface Issued {
  snapshot: string;
  term: string;
  op: string;
  resolve: (r: QueryResultData) => void;
  reject: (e: Error) => void;
  cancelled: boolean;
}

function fakeTrend(marker: number): NumericTrend {
  return {
    coordinate: 'document-relative',
    docOrdinal: Uint32Array.from([0]),
    binIndex: Uint32Array.from([0]),
    binStartToken: Uint32Array.from([0]),
    binTokens: Uint32Array.from([10]),
    count: Uint32Array.from([marker]),
    ratePer10k: Float64Array.from([marker]),
    order: ['a'],
    sequenceBases: null,
  };
}

function fakeClient() {
  const issued: Issued[] = [];
  let snapshotListener: ((info: { snapshot: string; readyDocs: readonly string[]; missingDocs: readonly string[] }) => void) | null = null;
  const client: ClientLike = {
    onSnapshot: (l) => {
      snapshotListener = l;
    },
    onProgress: () => undefined,
    onIngestError: () => undefined,
    beginGeneration: () => undefined,
    ingest: () => undefined,
    query: (snapshot, query) => {
      const q = query as { op: string; group: { members: { surface: string }[] } };
      const entry: Issued = {
        snapshot,
        term: q.group.members[0]!.surface,
        op: q.op,
        resolve: () => undefined,
        reject: () => undefined,
        cancelled: false,
      };
      const result = new Promise<QueryResultData>((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      issued.push(entry);
      return {
        result,
        // Realistic: cancel only MARKS intent (a real worker may still emit a
        // raced result afterward) — the store's epoch gate must protect.
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
  };
  return {
    client,
    issued,
    publish: (snapshot: string) =>
      snapshotListener?.({ snapshot, readyDocs: ['a'], missingDocs: [] }),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('store intent discipline', () => {
  it('cancels superseded queries and a stale term can never win', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setTerm('bear');
    store.getState().setTerm('hound');
    // Three epochs issued (publication + two terms); all but the last cancelled.
    const trendQueries = f.issued.filter((q) => q.op === 'trend');
    expect(trendQueries.length).toBe(3);
    expect(trendQueries[0]!.cancelled).toBe(true);
    expect(trendQueries[1]!.cancelled).toBe(true);
    expect(trendQueries[2]!.cancelled).toBe(false);
    expect(trendQueries[2]!.term).toBe('hound');

    // Even if the stale 'bear' promise resolves LAST, it cannot write.
    trendQueries[2]!.resolve({ op: 'trend', trend: fakeTrend(7) });
    await flush();
    trendQueries[1]!.resolve({ op: 'trend', trend: fakeTrend(99) }); // stale resolve after cancel
    await flush();
    expect(store.getState().trend?.count[0]).toBe(7);
    expect(store.getState().term).toBe('hound');
  });

  it('clears results to pending on reissue — old arrays are never relabeled', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    const first = f.issued.filter((q) => q.op === 'trend').at(-1)!;
    first.resolve({ op: 'trend', trend: fakeTrend(1) });
    await flush();
    expect(store.getState().trend).not.toBeNull();
    store.getState().setTerm('other');
    expect(store.getState().trend).toBeNull(); // pending, not stale
  });

  it('a result from a superseded snapshot cannot write', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    const old = f.issued.filter((q) => q.op === 'trend').at(-1)!;
    f.publish('s2'); // cancels s1 queries, reissues
    old.resolve({ op: 'trend', trend: fakeTrend(5) }); // resolve raced past cancel
    await flush();
    expect(store.getState().trend).toBeNull(); // s2's query owns the panel
    const fresh = f.issued.filter((q) => q.op === 'trend').at(-1)!;
    expect(fresh.snapshot).toBe('s2');
  });

  it('a blank term cancels and clears — old evidence is never relabeled', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    const q = f.issued.filter((x) => x.op === 'trend').at(-1)!;
    q.resolve({ op: 'trend', trend: fakeTrend(3) });
    await flush();
    expect(store.getState().trend).not.toBeNull();
    store.getState().setTerm('   ');
    expect(store.getState().trend).toBeNull();
    expect(q.cancelled).toBe(true);
    // A raced late duplicate of the old result must not resurface either.
    await flush();
    expect(store.getState().trend).toBeNull();
  });

  it('manifest byte lengths and hash prefixes match the shipped assets', async () => {
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { SHERLOCK } = await import('../src/lib/store.ts');
    for (const { doc, bytes, sha256Prefix } of SHERLOCK) {
      const data = await readFile(new URL(`../public/corpora/sherlock/${doc}`, import.meta.url));
      expect(data.byteLength, doc).toBe(bytes);
      expect(createHash('sha256').update(data).digest('hex').slice(0, 16), doc).toBe(sha256Prefix);
    }
  });

  it('a mid-flight ingest error fails only its own attempt; a parked stale fetch cannot corrupt the retry', async () => {
    // Controlled fetch: attempt 1 parks on its SECOND fetch; the worker error
    // arrives while it is parked; the retry (gen-2) must own the attempt, the
    // released stale loop must be inert, and late stale errors ignored.
    let errorListener: ((g: string, m: string) => void) | null = null;
    const generationsBegun: string[] = [];
    const ingests: string[] = [];
    const f = fakeClient();
    const client: ClientLike = {
      ...f.client,
      beginGeneration: (g) => {
        generationsBegun.push(g);
      },
      ingest: (g) => {
        ingests.push(g);
      },
      onIngestError: (l) => {
        errorListener = l;
      },
    };
    let parked: (() => void) | null = null;
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      fetchCount++;
      // Serve the CORRECT byte length for whichever doc was requested.
      const url = decodeURIComponent(String(input));
      const entry = SHERLOCK.find(({ doc }) => url.endsWith(doc))!;
      if (generationsBegun.length === 1 && fetchCount === 2) {
        await new Promise<void>((r) => {
          parked = r;
        });
      }
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(entry.bytes),
      };
    }) as unknown as typeof fetch;

    const store = createAppStore(client);
    try {
    const attempt1 = store.getState().loadSherlock();
    await flush();
    expect(generationsBegun).toEqual(['gen-1']);
    expect(ingests.length).toBe(1); // doc 1 ingested, doc 2 parked

    // The worker reports gen-1's ingest failed while the loop is parked.
    errorListener!('gen-1', 'DECODE_FAILED: boom');
    expect(store.getState().loadError).toContain('DECODE_FAILED');

    // Retry: a fresh generation that must complete all six ingests.
    await store.getState().loadSherlock();
    expect(generationsBegun).toEqual(['gen-1', 'gen-2']);
    expect(ingests.filter((g) => g === 'gen-2').length).toBe(6);

    // Release the parked gen-1 loop: it may not ingest or mutate state.
    parked!();
    await attempt1;
    await flush();
    expect(ingests.filter((g) => g === 'gen-1').length).toBe(1); // still just doc 1

    // A late stale error from gen-1 must not fail the completed gen-2 attempt.
    errorListener!('gen-1', 'GENERATION_STALE: old');
    await store.getState().loadSherlock(); // still idempotent: no gen-3
    expect(generationsBegun).toEqual(['gen-1', 'gen-2']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('loadSherlock is idempotent across Strict Mode double-invocation', async () => {
    const f = fakeClient();
    let generations = 0;
    const counting: ClientLike = {
      ...f.client,
      beginGeneration: () => {
        generations++;
      },
    };
    const store = createAppStore(counting);
    // fetch is unavailable in this test env — both calls fail identically,
    // but only ONE may begin a generation.
    await Promise.all([store.getState().loadSherlock(), store.getState().loadSherlock()]);
    expect(generations).toBe(1);
  });
});
