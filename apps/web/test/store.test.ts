import { describe, expect, it } from 'vitest';
import {
  createAppStore,
  parseSeries,
  MAX_SERIES,
  SHERLOCK,
  type ClientLike,
} from '../src/lib/store.ts';
import type { QueryResultData } from '../src/worker/protocol.ts';
import type { NumericTrend, PassageResult } from '@texttrends/core';

interface Issued {
  snapshot: string;
  term: string;
  groupId: string;
  op: string;
  query: unknown;
  resolve: (r: QueryResultData) => void;
  reject: (e: Error) => void;
  cancelled: boolean;
}

function fakeTrend(marker: number): NumericTrend {
  return {
    coordinate: 'declared-sequence',
    docOrdinal: Uint32Array.from([0]),
    binIndex: Uint32Array.from([0]),
    binStartToken: Uint32Array.from([0]),
    binTokens: Uint32Array.from([10]),
    count: Uint32Array.from([marker]),
    ratePer10k: Float64Array.from([marker]),
    order: ['a'],
    sequenceBases: [0],
    docTokenCount: [10],
  };
}

function fakePassage(start: number, end: number, center: number, doc = 'a'): PassageResult {
  const count = end - start;
  return {
    doc,
    centerToken: center,
    tokens: { start, end },
    docCharsUtf16: { start: 0, end: count },
    text: ' '.repeat(count),
    tokenStartsUtf16: Array.from({ length: count }, (_, i) => i),
    tokenEndsUtf16: Array.from({ length: count }, (_, i) => i + 1),
    centerCharsUtf16: { start: center - start, end: center - start + 1 },
    marks: [],
    truncatedByCharCap: false,
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
      const q = query as {
        op: string;
        group?: { id: string; members: { surface: string }[] };
        request?: { doc: string; centerToken: number; tracks: { seriesId: string }[] };
      };
      const entry: Issued = {
        snapshot,
        term: q.group?.members[0]?.surface ?? q.request?.doc ?? '',
        groupId: q.group?.id ?? '',
        op: q.op,
        query,
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
    trends: () => issued.filter((q) => q.op === 'trend'),
    kwics: () => issued.filter((q) => q.op === 'kwic'),
    passages: () => issued.filter((q) => q.op === 'passage'),
    publish: (snapshot: string) =>
      snapshotListener?.({ snapshot, readyDocs: ['a'], missingDocs: [] }),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('parseSeries', () => {
  it('splits on commas, trims, drops blanks, preserves first spelling and order', () => {
    const p = parseSeries(' Holmes , , moriarty ,');
    expect(p.error).toBeNull();
    expect(p.series!.map((s) => s.label)).toEqual(['Holmes', 'moriarty']);
    expect(p.series!.map((s) => s.styleSlot)).toEqual([0, 1]);
  });

  it('dedupes by SEMANTIC key (case and diacritic folds), not raw spelling', () => {
    const p = parseSeries('Holmes, holmes, Hólmes, watson');
    expect(p.series!.map((s) => s.label)).toEqual(['Holmes', 'watson']);
    expect(p.series![0]!.id).toBe(parseSeries('hólmes').series![0]!.id);
  });

  it('refuses more than MAX_SERIES distinct terms instead of truncating', () => {
    const p = parseSeries('a, b, c, d, e, f');
    expect(p.series).toBeNull();
    expect(p.error).toContain(String(MAX_SERIES));
  });
});

describe('store intent discipline', () => {
  it('issues one trend per series plus one focused KWIC, with distinct group ids', () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes, moriarty');
    const live = f.trends().filter((q) => !q.cancelled);
    expect(live.map((q) => q.term)).toEqual(['holmes', 'moriarty']);
    expect(new Set(live.map((q) => q.groupId)).size).toBe(2);
    const liveKwic = f.kwics().filter((q) => !q.cancelled);
    expect(liveKwic.length).toBe(1);
    expect(liveKwic[0]!.term).toBe('holmes'); // focus defaults to the first series
  });

  it('cancels superseded queries and a stale term can never win', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('bear');
    store.getState().setInput('hound');
    const trendQueries = f.trends();
    for (const q of trendQueries.slice(0, -1)) expect(q.cancelled).toBe(true);
    const live = trendQueries.at(-1)!;
    expect(live.cancelled).toBe(false);
    expect(live.term).toBe('hound');

    // Even if the stale 'bear' promise resolves LAST, it cannot write.
    live.resolve({ op: 'trend', trend: fakeTrend(7) });
    await flush();
    const stale = trendQueries.find((q) => q.term === 'bear')!;
    stale.resolve({ op: 'trend', trend: fakeTrend(99) }); // stale resolve after cancel
    await flush();
    const trends = store.getState().trends;
    expect(trends.size).toBe(1);
    const hound = trends.get(store.getState().series[0]!.id)!;
    expect(hound.status).toBe('ready');
    expect(hound.status === 'ready' && hound.trend.count[0]).toBe(7);
  });

  it('per-series results land independently; one failure does not erase peers', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes, moriarty');
    const [q1, q2] = f.trends().filter((q) => !q.cancelled);
    q1!.resolve({ op: 'trend', trend: fakeTrend(3) });
    await flush();
    const [holmes, moriarty] = store.getState().series;
    expect(store.getState().trends.get(holmes!.id)!.status).toBe('ready');
    expect(store.getState().trends.get(moriarty!.id)!.status).toBe('pending');
    q2!.reject(new Error('CAP_EXCEEDED: too much'));
    await flush();
    const after = store.getState().trends;
    expect(after.get(holmes!.id)!.status).toBe('ready'); // peer survives
    const failed = after.get(moriarty!.id)!;
    expect(failed.status).toBe('error');
    expect(failed.status === 'error' && failed.message).toContain('CAP_EXCEEDED');
  });

  it('focus change cancels and reissues ONLY the KWIC query', () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes, moriarty');
    const trendsBefore = f.trends().length;
    const kwicBefore = f.kwics().filter((q) => !q.cancelled).at(-1)!;
    const moriarty = store.getState().series[1]!;
    store.getState().setFocus(moriarty.id);
    expect(f.trends().length).toBe(trendsBefore); // no trend churn
    expect(f.trends().filter((q) => !q.cancelled).length).toBe(2); // still live
    expect(kwicBefore.cancelled).toBe(true);
    expect(f.kwics().filter((q) => !q.cancelled).at(-1)!.term).toBe('moriarty');
  });

  it('the default focus is canonical: clicking the already-focused first chip is a no-op', () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes, moriarty');
    const holmes = store.getState().series[0]!;
    expect(store.getState().focusedSeries).toBe(holmes.id); // actual, not implied
    const kwicCount = f.kwics().length;
    store.getState().setFocus(holmes.id);
    expect(f.kwics().length).toBe(kwicCount); // no cancel/reissue of the same intent
  });

  it('reordering the input preserves a surviving focus instead of stealing it', () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes, moriarty');
    const moriarty = store.getState().series[1]!;
    store.getState().setFocus(moriarty.id);
    store.getState().setInput('moriarty, holmes'); // same series, new order
    expect(store.getState().focusedSeries).toBe(moriarty.id);
    expect(f.kwics().filter((q) => !q.cancelled).at(-1)!.term).toBe('moriarty');
  });

  it('a late KWIC result from the previously focused series cannot relabel the new focus', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes, moriarty');
    const oldKwic = f.kwics().filter((q) => !q.cancelled).at(-1)!;
    store.getState().setFocus(store.getState().series[1]!.id);
    oldKwic.resolve({ op: 'kwic', total: 9, rows: [] }); // raced past cancel
    await flush();
    const kwic = store.getState().kwic!;
    expect(kwic.seriesId).toBe(store.getState().series[1]!.id);
    expect(kwic.state.status).toBe('pending'); // stale evidence did not land
  });

  it('view toggle is presentation-only: no query is issued', () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    const count = f.issued.length;
    store.getState().setTrendView('by-book');
    store.getState().setTrendView('series');
    expect(f.issued.length).toBe(count);
    expect(store.getState().trendView).toBe('series');
  });

  it('clears results to pending on reissue — old arrays are never relabeled', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes');
    const first = f.trends().filter((q) => !q.cancelled).at(-1)!;
    first.resolve({ op: 'trend', trend: fakeTrend(1) });
    await flush();
    expect(store.getState().trends.get(store.getState().series[0]!.id)!.status).toBe('ready');
    store.getState().setInput('other');
    const pending = store.getState().trends.get(store.getState().series[0]!.id)!;
    expect(pending.status).toBe('pending'); // pending, not stale
  });

  it('a result from a superseded snapshot cannot write', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    const old = f.trends().filter((q) => !q.cancelled).at(-1)!;
    f.publish('s2'); // cancels s1 queries, reissues
    old.resolve({ op: 'trend', trend: fakeTrend(5) }); // resolve raced past cancel
    await flush();
    for (const [, state] of store.getState().trends) {
      expect(state.status).toBe('pending'); // s2's queries own the panels
    }
    const fresh = f.trends().at(-1)!;
    expect(fresh.snapshot).toBe('s2');
  });

  it('blank input cancels and clears — old evidence is never relabeled', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes');
    const q = f.trends().filter((x) => !x.cancelled).at(-1)!;
    q.resolve({ op: 'trend', trend: fakeTrend(3) });
    await flush();
    expect(store.getState().trends.size).toBe(1);
    store.getState().setInput('  ,  ');
    expect(store.getState().trends.size).toBe(0);
    expect(store.getState().kwic).toBeNull();
    expect(q.cancelled).toBe(true);
    // A raced late duplicate of the old result must not resurface either.
    await flush();
    expect(store.getState().trends.size).toBe(0);
  });

  it('an over-cap input is refused: error surfaced, work cancelled, nothing issued', () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes');
    const live = f.trends().filter((q) => !q.cancelled);
    expect(live.length).toBe(1);
    store.getState().setInput('a, b, c, d, e, f');
    expect(store.getState().inputError).toContain('up to');
    expect(live[0]!.cancelled).toBe(true);
    expect(store.getState().trends.size).toBe(0);
    expect(f.trends().filter((q) => !q.cancelled).length).toBe(0);
  });

  it('scrub: first target fetches a passage block with one track per series', () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes, moriarty');
    store.getState().setScrub({ doc: 'a', token: 500 });
    const issued = f.passages();
    expect(issued.length).toBe(1);
    const q = issued[0]!.query as { request: { doc: string; centerToken: number; tracks: { seriesId: string }[] } };
    expect(q.request.doc).toBe('a');
    expect(q.request.centerToken).toBe(500);
    expect(q.request.tracks.map((t) => t.seriesId)).toEqual(
      store.getState().series.map((s) => s.id),
    );
  });

  it('scrub: moves inside the guard band are purely local; edge moves refetch', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes');
    store.getState().setScrub({ doc: 'a', token: 500 });
    f.passages()[0]!.resolve({ op: 'passage', passage: fakePassage(400, 600, 500) });
    await flush();
    expect(store.getState().passage).not.toBeNull();
    store.getState().setScrub({ doc: 'a', token: 510 });
    store.getState().setScrub({ doc: 'a', token: 450 });
    expect(f.passages().length).toBe(1); // both inside [428, 572) — no fetch
    store.getState().setScrub({ doc: 'a', token: 590 }); // within block, past the guard
    expect(f.passages().length).toBe(2);
  });

  it('scrub: one active request plus one replaceable pending — motion never queues', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes');
    store.getState().setScrub({ doc: 'a', token: 500 });
    expect(f.passages().length).toBe(1);
    // Continuous motion while the first fetch is in flight: nothing new issues.
    store.getState().setScrub({ doc: 'a', token: 900 });
    store.getState().setScrub({ doc: 'a', token: 1200 });
    store.getState().setScrub({ doc: 'a', token: 1500 });
    expect(f.passages().length).toBe(1);
    // The active request resolves (already stale); the LATEST parked target
    // is issued next — intermediate ones were replaced, not queued.
    f.passages()[0]!.resolve({ op: 'passage', passage: fakePassage(400, 600, 500) });
    await flush();
    expect(f.passages().length).toBe(2);
    const q = f.passages()[1]!.query as { request: { centerToken: number } };
    expect(q.request.centerToken).toBe(1500);
  });

  it('scrub: an input change invalidates the block, refetches for the kept position, and a stale in-flight block cannot land', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes');
    store.getState().setScrub({ doc: 'a', token: 500 });
    const first = f.passages()[0]!; // left IN FLIGHT across the input change
    store.getState().setInput('holmes, watson'); // marks are stale — new tracks needed
    expect(first.cancelled).toBe(true);
    expect(store.getState().passage).toBeNull();
    expect(store.getState().scrub).toEqual({ doc: 'a', token: 500 }); // position kept
    const refetch = f.passages().at(-1)!;
    expect(refetch).not.toBe(first);
    const q = refetch.query as { request: { tracks: { seriesId: string }[] } };
    expect(q.request.tracks.length).toBe(2);
    // The superseded request settles late (a real worker can race a cancel):
    // it must neither land its block nor free the replacement's active slot.
    first.resolve({ op: 'passage', passage: fakePassage(0, 200, 100) });
    await flush();
    expect(store.getState().passage).toBeNull();
    refetch.resolve({ op: 'passage', passage: fakePassage(400, 600, 500) });
    await flush();
    expect(store.getState().passage).not.toBeNull();
  });

  it('scrub: a rejected center clears the scrub instead of showing a mismatched block', async () => {
    const f = fakeClient();
    const store = createAppStore(f.client);
    f.publish('s1');
    store.getState().setInput('holmes');
    store.getState().setScrub({ doc: 'a', token: 99999 });
    f.passages()[0]!.reject(new Error('REQUEST_INVALID: centerToken 99999 outside [0, 5000)'));
    await flush();
    expect(store.getState().scrub).toBeNull();
    expect(store.getState().passage).toBeNull();
  });

  it('manifest byte lengths and text hashes match the shipped assets', async () => {
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { hashText } = await import('@texttrends/core');
    for (const { doc, bytes, textHash } of SHERLOCK) {
      const data = await readFile(new URL(`../public/corpora/sherlock/${doc}`, import.meta.url));
      expect(data.byteLength, doc).toBe(bytes);
      // Both readings must agree: the file-byte hash AND the TextHash of the
      // decoded text (what the worker computes and rehydrates against) — this
      // is what makes the manifest hash a valid expectedText identity.
      expect(createHash('sha256').update(data).digest('hex'), doc).toBe(textHash);
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(data);
      expect(await hashText(decoded), doc).toBe(textHash);
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
