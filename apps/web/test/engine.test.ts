import { describe, expect, it } from 'vitest';
import { WorkerEngine } from '../src/worker/engine.ts';
import { InMemoryArtifactStore } from '../src/worker/store.ts';
import { PROTOCOL_VERSION, type FromWorker, type ToWorker } from '../src/worker/protocol.ts';
import { DEFAULT_INDEX_RECIPE, hashText } from '@texttrends/core';

const FOLD = { case: 'folded', diacritics: 'sensitive' } as const;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface Harness {
  engine: WorkerEngine;
  messages: FromWorker[];
  store: InMemoryArtifactStore;
  /** Pending yields — resolve one to let the engine pass a checkpoint. */
  releaseYield(): void;
  autoYield(): void;
  send(m: DistributiveOmit<ToWorker, 'v'>): Promise<void>;
  last<T extends FromWorker['t']>(t: T): Extract<FromWorker, { t: T }>;
  all<T extends FromWorker['t']>(t: T): Extract<FromWorker, { t: T }>[];
}

function harness(): Harness {
  const messages: FromWorker[] = [];
  const store = new InMemoryArtifactStore();
  let auto = true;
  const pending: (() => void)[] = [];
  const engine = new WorkerEngine(
    store,
    (m) => messages.push(m),
    () =>
      auto
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            pending.push(resolve);
          }),
  );
  return {
    engine,
    messages,
    store,
    releaseYield: () => pending.shift()?.(),
    autoYield: () => {
      auto = true;
      while (pending.length) pending.shift()?.();
    },
    send: (m) => engine.handle({ v: PROTOCOL_VERSION, ...m } as ToWorker),
    last: (t) => {
      const found = [...messages].reverse().find((m) => m.t === t);
      if (!found) throw new Error(`no message of type ${t}`);
      return found as never;
    },
    all: (t) => messages.filter((m) => m.t === t) as never,
  };
}

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

async function ingested(h: Harness, docs: Record<string, string>, generation = 'gen-1') {
  await h.send({
    t: 'begin-generation',
    job: 1,
    generation,
    docs: Object.keys(docs).map((doc) => ({
      doc,
      language: 'en',
      sourceByteLength: docs[doc]!.length,
    })),
    recipe: DEFAULT_INDEX_RECIPE,
  });
  let job = 10;
  for (const [doc, text] of Object.entries(docs)) {
    await h.send({ t: 'ingest', job: job++, generation, doc, bytes: bytes(text) });
  }
  return h.last('snapshot-published');
}

const wolfGroup = {
  id: 'g1',
  members: [{ id: 'm1', kind: 'token' as const, surface: 'wolf', match: FOLD }],
  countOverlaps: false,
};

describe('generation and ingest lifecycle', () => {
  it('ingests documents progressively, publishing a snapshot per completion', async () => {
    const h = harness();
    await ingested(h, { a: 'the wolf ran', b: 'a wolf slept' });
    const published = h.all('snapshot-published');
    expect(published.length).toBe(2);
    expect(published[0]!.readyDocs).toEqual(['a']);
    expect(published[0]!.missingDocs).toEqual(['b']);
    expect(published[1]!.readyDocs).toEqual(['a', 'b']);
    expect(published[1]!.missingDocs).toEqual([]);
    expect(published[0]!.snapshot).not.toBe(published[1]!.snapshot);
    const phases = h.all('progress').map((p) => p.phase);
    expect(phases).toEqual(['decode', 'segment', 'index', 'compose', 'decode', 'segment', 'index', 'compose']);
  });

  it('rejects protocol version mismatches with PROTOCOL_VERSION', async () => {
    const h = harness();
    await h.engine.handle({ v: 99, t: 'cancel', job: 1 } as never);
    expect(h.last('error').code).toBe('PROTOCOL_VERSION');
  });

  it('rejects invalid UTF-8 with DECODE_FAILED', async () => {
    const h = harness();
    await h.send({ t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g', docs: [{ doc: 'a', language: 'en', sourceByteLength: 2 }] });
    await h.send({ t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: Uint8Array.from([0xff, 0xfe]).buffer as ArrayBuffer });
    expect(h.last('error').code).toBe('DECODE_FAILED');
  });

  it('suppresses jobs from a replaced generation by identity', async () => {
    const h = harness();
    await h.send({ t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'old', docs: [{ doc: 'a', language: 'en', sourceByteLength: 1 }] });
    await h.send({ t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 2, generation: 'new', docs: [{ doc: 'a', language: 'en', sourceByteLength: 1 }] });
    await h.send({ t: 'ingest', job: 3, generation: 'old', doc: 'a', bytes: bytes('x') });
    expect(h.last('error').code).toBe('GENERATION_STALE');
    expect(h.all('snapshot-published').length).toBe(0);
  });

  it('a cancel queued at a checkpoint stops the job before publication', async () => {
    // Manual yields: the ingest parks at its first checkpoint until released.
    // (begin-generation has its own checkpoints now, so parking starts only
    // after the generation is open.)
    let park = false;
    let resolveYield: (() => void) | null = null;
    const engine2Messages: FromWorker[] = [];
    const engine2 = new WorkerEngine(
      new InMemoryArtifactStore(),
      (m) => engine2Messages.push(m),
      () =>
        park
          ? new Promise<void>((resolve) => {
              resolveYield = resolve;
            })
          : Promise.resolve(),
    );
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g', docs: [{ doc: 'a', language: 'en', sourceByteLength: 5 }] });
    park = true;
    const ingestPromise = engine2.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: bytes('wolf!') });
    // The job is parked at the first checkpoint; deliver a cancel, then release.
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'cancel', job: 2 });
    resolveYield!();
    await ingestPromise;
    expect(engine2Messages.some((m) => m.t === 'cancelled' && m.job === 2)).toBe(true);
    expect(engine2Messages.some((m) => m.t === 'snapshot-published')).toBe(false);
  });

  it('a cancel delivered DURING composition suppresses publication (commit gate)', async () => {
    // Deliver cancel from inside the compose progress callback — after the
    // final checkpoint, during the staging awaits (review round 1, finding 1).
    const messages: FromWorker[] = [];
    const store = new InMemoryArtifactStore();
    let engineRef: WorkerEngine | null = null;
    const engine = new WorkerEngine(
      store,
      (m) => {
        messages.push(m);
        if (m.t === 'progress' && m.phase === 'compose') {
          void engineRef!.handle({ v: PROTOCOL_VERSION, t: 'cancel', job: 2 });
        }
      },
      () => Promise.resolve(),
    );
    engineRef = engine;
    await engine.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g', docs: [{ doc: 'a', language: 'en', sourceByteLength: 5 }] });
    await engine.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: bytes('wolf!') });
    expect(messages.some((m) => m.t === 'snapshot-published')).toBe(false);
    expect(messages.some((m) => m.t === 'cancelled' && m.job === 2)).toBe(true);
  });

  it('a generation replaced DURING composition suppresses publication', async () => {
    const messages: FromWorker[] = [];
    const store = new InMemoryArtifactStore();
    let engineRef: WorkerEngine | null = null;
    const engine = new WorkerEngine(
      store,
      (m) => {
        messages.push(m);
        if (m.t === 'progress' && m.phase === 'compose') {
          void engineRef!.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 9, generation: 'g2', docs: [] });
        }
      },
      () => Promise.resolve(),
    );
    engineRef = engine;
    await engine.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g1', docs: [{ doc: 'a', language: 'en', sourceByteLength: 5 }] });
    await engine.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g1', doc: 'a', bytes: bytes('wolf!') });
    expect(messages.some((m) => m.t === 'snapshot-published')).toBe(false);
    expect(messages.some((m) => m.t === 'error' && m.code === 'GENERATION_STALE')).toBe(true);
  });

  it('the warm key does NOT alias across locales; corrupted records rebuild', async () => {
    // Same text under en then fr: the fr ingest must segment/index itself
    // (probe hashes can collide across locales; the FULL fingerprint keys).
    const h = harness();
    await h.send({
      t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g',
      docs: [
        { doc: 'en-doc', language: 'en', sourceByteLength: 12 },
        { doc: 'fr-doc', language: 'fr', sourceByteLength: 12 },
      ],
    });
    await h.send({ t: 'ingest', job: 2, generation: 'g', doc: 'en-doc', bytes: bytes('the wolf ran') });
    const before = h.all('progress').length;
    await h.send({ t: 'ingest', job: 3, generation: 'g', doc: 'fr-doc', bytes: bytes('the wolf ran') });
    const frPhases = h.all('progress').slice(before).map((p) => p.phase);
    expect(frPhases).toEqual(['decode', 'segment', 'index', 'compose']); // no cross-locale hit
  });

  it('a cached record that fails re-verification is ARTIFACT_CORRUPT and rebuilt', async () => {
    const h = harness();
    await ingested(h, { a: 'the wolf ran' });
    // Corrupt the store: file a WRONG shard under whatever key exists.
    const anyStore = h.store as unknown as { shards: Map<string, unknown> };
    const [key] = anyStore.shards.keys();
    const wrong = await (async () => {
      const { createDocumentIndex, segment } = await import('@texttrends/core');
      return createDocumentIndex('other text', await segment('other text', 'en'), (await import('@texttrends/core')).DEFAULT_INDEX_RECIPE);
    })();
    anyStore.shards.set(key!, wrong);
    const messages2: FromWorker[] = [];
    const engine2 = new WorkerEngine(h.store, (m) => messages2.push(m), () => Promise.resolve());
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g2', docs: [{ doc: 'a', language: 'en', sourceByteLength: 12 }] });
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes('the wolf ran') });
    expect(messages2.some((m) => m.t === 'warning' && m.code === 'CACHE_CORRUPT')).toBe(true);
    expect(messages2.some((m) => m.t === 'snapshot-published')).toBe(true); // rebuilt
  });

  it('a store-reported corrupt read is ARTIFACT_CORRUPT, deleted, and rebuilt', async () => {
    const h = harness();
    await ingested(h, { a: 'the wolf ran' });
    // Wrap the store: the next shard read reports envelope corruption.
    const deleted: unknown[] = [];
    const store = h.store;
    const wrapped = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'getShard') {
          return () => Promise.resolve({ kind: 'corrupt', reason: 'stored record failed envelope validation' });
        }
        if (prop === 'deleteShard') {
          return (key: unknown) => {
            deleted.push(key);
            return Promise.resolve();
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const messages2: FromWorker[] = [];
    const engine2 = new WorkerEngine(wrapped, (m) => messages2.push(m), () => Promise.resolve());
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g2', docs: [{ doc: 'a', language: 'en', sourceByteLength: 12 }] });
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes('the wolf ran') });
    expect(messages2.some((m) => m.t === 'warning' && m.code === 'CACHE_CORRUPT')).toBe(true);
    expect(deleted.length).toBe(1); // exact-record repair, not just a warning
    expect(messages2.some((m) => m.t === 'snapshot-published')).toBe(true); // rebuilt
  });

  it('a corrupt record is REPAIRED: the reopen after the rebuild is warm and clean', async () => {
    const h = harness();
    await ingested(h, { a: 'the wolf ran' });
    const anyStore = h.store as unknown as { shards: Map<string, { lengths8: Uint8Array }> };
    const [key] = anyStore.shards.keys();
    anyStore.shards.get(key!)!.lengths8[0] = 0; // corrupt in place
    const messages2: FromWorker[] = [];
    const engine2 = new WorkerEngine(h.store, (m) => messages2.push(m), () => Promise.resolve());
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g2', docs: [{ doc: 'a', language: 'en', sourceByteLength: 12 }] });
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes('the wolf ran') });
    expect(messages2.some((m) => m.t === 'warning' && m.code === 'CACHE_CORRUPT')).toBe(true);
    // Third engine, same store: the rebuild must have OVERWRITTEN the corrupt
    // record, so this reopen hits the warm path with no corruption report.
    const messages3: FromWorker[] = [];
    const engine3 = new WorkerEngine(h.store, (m) => messages3.push(m), () => Promise.resolve());
    await engine3.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g3', docs: [{ doc: 'a', language: 'en', sourceByteLength: 12 }] });
    await engine3.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g3', doc: 'a', bytes: bytes('the wolf ran') });
    expect(messages3.some((m) => m.t === 'warning' && m.code === 'CACHE_CORRUPT')).toBe(false);
    const phases = messages3.filter((m) => m.t === 'progress').map((m) => (m as { phase: string }).phase);
    expect(phases).toEqual(['decode', 'compose']); // warm — no segment/index
  });

  it('warm reopen skips segmentation via the artifact store', async () => {
    const h = harness();
    await ingested(h, { a: 'the wolf ran' });
    // Second engine sharing the same store: same text, fresh generation.
    const messages2: FromWorker[] = [];
    const engine2 = new WorkerEngine(h.store, (m) => messages2.push(m), () => Promise.resolve());
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g2', docs: [{ doc: 'a', language: 'en', sourceByteLength: 12 }] });
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes('the wolf ran') });
    const phases = messages2.filter((m) => m.t === 'progress').map((m) => (m as { phase: string }).phase);
    expect(phases).toEqual(['decode', 'compose']); // no segment/index on the warm path
    expect(messages2.some((m) => m.t === 'snapshot-published')).toBe(true);
  });
});

describe('warm reopen (begin-generation with expectedText)', () => {
  /** Cold-ingest docs into a store, return it plus each doc's TextHash. */
  async function warmed(docs: Record<string, string>) {
    const h = harness();
    await ingested(h, docs);
    const hashes: Record<string, string> = {};
    for (const [doc, text] of Object.entries(docs)) hashes[doc] = await hashText(text);
    return { store: h.store, hashes };
  }

  function specsFor(docs: Record<string, string>, hashes: Record<string, string>) {
    return Object.entries(docs).map(([doc, text]) => ({
      doc,
      language: 'en',
      sourceByteLength: text.length,
      expectedText: hashes[doc]!,
    }));
  }

  it('an all-warm reopen publishes ONE snapshot, no segmentation, and answers queries', async () => {
    const docs = { a: 'the wolf ran far. a wolf slept.', b: 'no wolves here' };
    const { store, hashes } = await warmed(docs);
    const messages: FromWorker[] = [];
    const engine = new WorkerEngine(store, (m) => messages.push(m), () => Promise.resolve());
    await engine.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE,
      job: 1, generation: 'g2', docs: specsFor(docs, hashes),
    });
    const ready = messages.find((m) => m.t === 'generation-ready');
    expect(ready).toBeDefined();
    if (ready?.t === 'generation-ready') {
      expect(ready.missing).toEqual([]);
      expect(ready.readyDocs).toEqual(['a', 'b']);
      expect(ready.snapshot).not.toBeNull();
    }
    // The all-warm reopen must not churn snapshots: exactly one publication.
    const published = messages.filter((m) => m.t === 'snapshot-published');
    expect(published.length).toBe(1);
    expect(messages.filter((m) => m.t === 'progress').length).toBe(0); // no segment/index/decode
    // The rebound generation answers queries — including KWIC, which proves
    // stored TEXTS were rehydrated, not just shards.
    const snap = published[0]!.snapshot;
    await engine.handle({
      v: PROTOCOL_VERSION, t: 'query', job: 2, snapshot: snap,
      query: {
        op: 'kwic', selection: { docs: ['a'] }, group: wolfGroup,
        request: { contextTokens: 1, sort: [{ at: 'pos', dir: 1 }], page: { offset: 0, limit: 10 } },
      } as never,
    });
    const result = messages.find((m) => m.t === 'result');
    expect(result).toBeDefined();
    if (result?.t === 'result' && result.data.op === 'kwic') {
      expect(result.data.total).toBe(2);
      expect(result.data.rows[0]!.nodeText).toBe('wolf');
    }
  });

  it('a verified text with a missing shard re-indexes locally — no byte fetch needed', async () => {
    const docs = { a: 'the wolf ran' };
    const { store, hashes } = await warmed(docs);
    // Drop the shard record but keep the text (e.g. a recipe change or a
    // partial write): the warm path must rebuild from the stored text.
    const anyStore = store as unknown as { shards: Map<string, unknown> };
    anyStore.shards.clear();
    const messages: FromWorker[] = [];
    const engine = new WorkerEngine(store, (m) => messages.push(m), () => Promise.resolve());
    await engine.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE,
      job: 1, generation: 'g2', docs: specsFor(docs, hashes),
    });
    const ready = messages.find((m) => m.t === 'generation-ready');
    if (ready?.t === 'generation-ready') {
      expect(ready.missing).toEqual([]);
      expect(ready.readyDocs).toEqual(['a']);
    }
    const phases = messages.filter((m) => m.t === 'progress').map((m) => (m as { phase: string }).phase);
    expect(phases).toEqual(['segment', 'index', 'compose']); // rebuilt — but never decoded bytes
    // The rebuilt shard was persisted: a THIRD engine reopens fully warm.
    const messages3: FromWorker[] = [];
    const engine3 = new WorkerEngine(store, (m) => messages3.push(m), () => Promise.resolve());
    await engine3.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE,
      job: 1, generation: 'g3', docs: specsFor(docs, hashes),
    });
    expect(messages3.filter((m) => m.t === 'progress').length).toBe(0);
    const ready3 = messages3.find((m) => m.t === 'generation-ready');
    if (ready3?.t === 'generation-ready') expect(ready3.missing).toEqual([]);
  });

  it('warm hits publish as a batch FIRST; text-only rebuilds stream after', async () => {
    const docs = { a: 'the wolf ran', b: 'a wolf slept' };
    const { store, hashes } = await warmed(docs);
    // Remove only b's shard: a is an exact hit, b is a text-only rebuild.
    const anyStore = store as unknown as { shards: Map<string, { text: string }> };
    for (const [key, shard] of anyStore.shards) {
      if (shard.text === hashes.b) anyStore.shards.delete(key);
    }
    const messages: FromWorker[] = [];
    const engine = new WorkerEngine(store, (m) => messages.push(m), () => Promise.resolve());
    await engine.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE,
      job: 1, generation: 'g2', docs: specsFor(docs, hashes),
    });
    const published = messages.filter((m) => m.t === 'snapshot-published');
    expect(published.length).toBe(2); // batch of hits, then the rebuild
    expect(published[0]!.readyDocs).toEqual(['a']);
    expect(published[1]!.readyDocs).toEqual(['a', 'b']);
    const ready = messages.find((m) => m.t === 'generation-ready');
    if (ready?.t === 'generation-ready') expect(ready.missing).toEqual([]);
    // generation-ready is the BARRIER: it must arrive after both publications.
    expect(messages.findIndex((m) => m.t === 'generation-ready'))
      .toBeGreaterThan(messages.findIndex((m) => m === published[1]));
  });

  it('reports exactly which docs still need bytes, with reasons', async () => {
    const docs = { a: 'the wolf ran' };
    const { store, hashes } = await warmed(docs);
    // Tamper with a stored text so it no longer hashes to its key.
    const anyStore = store as unknown as { texts: Map<string, string> };
    const otherHash = await hashText('never stored');
    anyStore.texts.set(hashes.a!, 'tampered content');
    const messages: FromWorker[] = [];
    const engine = new WorkerEngine(store, (m) => messages.push(m), () => Promise.resolve());
    await engine.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE,
      job: 1, generation: 'g2',
      docs: [
        { doc: 'a', language: 'en', sourceByteLength: 12, expectedText: hashes.a! },
        { doc: 'b', language: 'en', sourceByteLength: 5, expectedText: otherHash },
        { doc: 'c', language: 'en', sourceByteLength: 5 },
      ],
    });
    const ready = messages.find((m) => m.t === 'generation-ready');
    expect(ready).toBeDefined();
    if (ready?.t === 'generation-ready') {
      expect(ready.snapshot).toBeNull();
      expect(ready.readyDocs).toEqual([]);
      expect(ready.missing).toEqual([
        { doc: 'a', reason: 'text-corrupt' },
        { doc: 'b', reason: 'text-miss' },
        { doc: 'c', reason: 'no-text-identity' },
      ]);
    }
    // The tampered record was repaired by deletion, and warned as corruption.
    expect(anyStore.texts.has(hashes.a!)).toBe(false);
    expect(messages.some((m) => m.t === 'warning' && m.code === 'CACHE_CORRUPT')).toBe(true);
    // Cold ingest of the misses then completes the corpus normally.
    await engine.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes('the wolf ran') });
    const pub = messages.filter((m) => m.t === 'snapshot-published');
    expect(pub.length).toBe(1);
    expect(pub[0]!.readyDocs).toEqual(['a']);
  });

  it('delivered bytes that contradict the asserted identity are SOURCE_MISMATCH', async () => {
    const h = harness();
    const asserted = await hashText('what the manifest promised');
    await h.send({
      t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g',
      docs: [{ doc: 'a', language: 'en', sourceByteLength: 10, expectedText: asserted }],
    });
    await h.send({ t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: bytes('different content') });
    expect(h.last('error').code).toBe('SOURCE_MISMATCH');
    expect(h.all('snapshot-published').length).toBe(0);
  });

  it('a fixed-locale recipe overrides document language for ingest AND warm reopen', async () => {
    // Review P1: the effective locale must come from the recipe when fixed —
    // the builder rejects provenance whose locale disagrees with it.
    const fixedRecipe = { ...DEFAULT_INDEX_RECIPE, locale: { mode: 'fixed' as const, value: 'en' } };
    const h = harness();
    await h.send({
      t: 'begin-generation', recipe: fixedRecipe, job: 1, generation: 'g',
      docs: [{ doc: 'a', language: 'fr', sourceByteLength: 12 }],
    });
    await h.send({ t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: bytes('the wolf ran') });
    expect(h.all('error')).toEqual([]);
    expect(h.all('snapshot-published').length).toBe(1);
    // Warm reopen under the same fixed recipe hits the same cache identity.
    const messages2: FromWorker[] = [];
    const engine2 = new WorkerEngine(h.store, (m) => messages2.push(m), () => Promise.resolve());
    await engine2.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: fixedRecipe, job: 1, generation: 'g2',
      docs: [{ doc: 'a', language: 'fr', sourceByteLength: 12, expectedText: await hashText('the wolf ran') }],
    });
    const ready = messages2.find((m) => m.t === 'generation-ready');
    expect(ready).toBeDefined();
    if (ready?.t === 'generation-ready') {
      expect(ready.missing).toEqual([]);
      expect(ready.readyDocs).toEqual(['a']);
    }
    expect(messages2.filter((m) => m.t === 'progress').length).toBe(0); // exact warm hit
  });

  it('document-metadata mode falls back when a document declares no language', async () => {
    const h = harness();
    await h.send({
      t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g',
      docs: [{ doc: 'a', language: '', sourceByteLength: 12 }],
    });
    await h.send({ t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: bytes('the wolf ran') });
    expect(h.all('error')).toEqual([]);
    expect(h.all('snapshot-published').length).toBe(1);
  });

  it('a doc ingested while the warm scan is parked never contradicts the barrier', async () => {
    // Review P1: the shell dispatches without awaiting — an ingest can commit
    // a document while begin-generation is parked on a store read. The
    // barrier must not name that doc in BOTH readyDocs and missing.
    const docs = { a: 'the wolf ran' };
    const { store, hashes } = await warmed(docs);
    // Evict the text so the parked read will resolve to a MISS.
    (store as unknown as { texts: Map<string, string> }).texts.clear();
    let releaseRead: ((r: { kind: 'miss' }) => void) | null = null;
    const parkedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'getText') {
          return () =>
            new Promise((resolve) => {
              releaseRead = resolve;
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const messages: FromWorker[] = [];
    const engine = new WorkerEngine(parkedStore, (m) => messages.push(m), () => Promise.resolve());
    const beginPromise = engine.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE,
      job: 1, generation: 'g2', docs: specsFor(docs, hashes),
    });
    // Let the scan reach the parked getText, then cold-ingest the same doc.
    while (releaseRead === null) await new Promise((r) => setTimeout(r, 0));
    await engine.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes(docs.a) });
    expect(messages.some((m) => m.t === 'snapshot-published')).toBe(true);
    (releaseRead as unknown as (r: { kind: 'miss' }) => void)({ kind: 'miss' });
    await beginPromise;
    const ready = messages.find((m) => m.t === 'generation-ready');
    expect(ready).toBeDefined();
    if (ready?.t === 'generation-ready') {
      expect(ready.readyDocs).toEqual(['a']);
      expect(ready.missing).toEqual([]); // NOT [{doc:'a', reason:'text-miss'}]
    }
  });

  it('a stale CORRUPT text read after a concurrent ingest commit must not delete the new write', async () => {
    // Re-review finding: the parked read observed the OLD record; by release
    // time ingest replaced it. "Repairing" would delete the valid new text.
    const docs = { a: 'the wolf ran' };
    const { store, hashes } = await warmed(docs);
    const deletions: string[] = [];
    let releaseRead: ((r: { kind: 'corrupt'; reason: string }) => void) | null = null;
    let parkArmed = true;
    const parkedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'getText' && parkArmed) {
          return () => {
            parkArmed = false;
            return new Promise((resolve) => {
              releaseRead = resolve;
            });
          };
        }
        if (prop === 'deleteText') {
          return (hash: string) => {
            deletions.push(hash);
            return store.deleteText(hash);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const messages: FromWorker[] = [];
    const engine = new WorkerEngine(parkedStore, (m) => messages.push(m), () => Promise.resolve());
    const beginPromise = engine.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE,
      job: 1, generation: 'g2', docs: specsFor(docs, hashes),
    });
    while (releaseRead === null) await new Promise((r) => setTimeout(r, 0));
    await engine.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes(docs.a) });
    (releaseRead as unknown as (r: { kind: 'corrupt'; reason: string }) => void)({ kind: 'corrupt', reason: 'stale envelope' });
    await beginPromise;
    expect(deletions).toEqual([]); // the valid replacement was NOT repaired away
    expect(messages.some((m) => m.t === 'warning' && m.code === 'CACHE_CORRUPT')).toBe(false);
    const ready = messages.find((m) => m.t === 'generation-ready');
    if (ready?.t === 'generation-ready') {
      expect(ready.readyDocs).toEqual(['a']);
      expect(ready.missing).toEqual([]);
    }
    // The proof of non-destruction: a THIRD engine warm-opens clean.
    const messages3: FromWorker[] = [];
    const engine3 = new WorkerEngine(store, (m) => messages3.push(m), () => Promise.resolve());
    await engine3.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE,
      job: 1, generation: 'g3', docs: specsFor(docs, hashes),
    });
    const ready3 = messages3.find((m) => m.t === 'generation-ready');
    expect(ready3).toBeDefined();
    if (ready3?.t === 'generation-ready') expect(ready3.missing).toEqual([]);
  });

  it('a stale CORRUPT shard read after a concurrent ingest commit must not delete the new write', async () => {
    const docs = { a: 'the wolf ran' };
    const { store, hashes } = await warmed(docs);
    const deletions: unknown[] = [];
    let releaseShard: ((r: { kind: 'corrupt'; reason: string }) => void) | null = null;
    let parkArmed = true;
    const parkedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'getShard' && parkArmed) {
          return () => {
            parkArmed = false;
            return new Promise((resolve) => {
              releaseShard = resolve;
            });
          };
        }
        if (prop === 'deleteShard') {
          return (key: never) => {
            deletions.push(key);
            return store.deleteShard(key);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const messages: FromWorker[] = [];
    const engine = new WorkerEngine(parkedStore, (m) => messages.push(m), () => Promise.resolve());
    const beginPromise = engine.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE,
      job: 1, generation: 'g2', docs: specsFor(docs, hashes),
    });
    while (releaseShard === null) await new Promise((r) => setTimeout(r, 0));
    await engine.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes(docs.a) });
    (releaseShard as unknown as (r: { kind: 'corrupt'; reason: string }) => void)({ kind: 'corrupt', reason: 'stale envelope' });
    await beginPromise;
    expect(deletions).toEqual([]);
    expect(messages.some((m) => m.t === 'warning' && m.code === 'CACHE_CORRUPT')).toBe(false);
    // A THIRD engine still warm-opens with zero progress (shard intact).
    const messages3: FromWorker[] = [];
    const engine3 = new WorkerEngine(store, (m) => messages3.push(m), () => Promise.resolve());
    await engine3.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE,
      job: 1, generation: 'g3', docs: specsFor(docs, hashes),
    });
    expect(messages3.filter((m) => m.t === 'progress').length).toBe(0);
    const ready3 = messages3.find((m) => m.t === 'generation-ready');
    if (ready3?.t === 'generation-ready') expect(ready3.missing).toEqual([]);
  });

  it('sequential re-ingest of a ready document still repairs REAL corruption (both kinds)', async () => {
    // Round-3 review: readiness alone is not supersession — a normal
    // re-ingest of an already published doc must report and delete a
    // genuinely corrupt record, not silently skip repair.

    // (a) failed deep verification: tamper the stored shard in place.
    const h = harness();
    await ingested(h, { a: 'the wolf ran' });
    const anyStore = h.store as unknown as { shards: Map<string, { lengths8: Uint8Array }> };
    const [key] = anyStore.shards.keys();
    anyStore.shards.get(key!)!.lengths8[0] = 0;
    const warningsBefore = h.all('warning').length;
    await h.send({ t: 'ingest', job: 30, generation: 'gen-1', doc: 'a', bytes: bytes('the wolf ran') });
    expect(h.all('warning').slice(warningsBefore).some((w) => w.code === 'CACHE_CORRUPT')).toBe(true);
    expect(h.all('snapshot-published').length).toBe(2); // rebuilt and republished

    // (b) store-reported envelope corruption on the next read.
    const docs = { b: 'a wolf slept' };
    const h2 = harness();
    await ingested(h2, docs, 'gen-2');
    const deletions: unknown[] = [];
    let corruptOnce = true;
    const corruptingStore = new Proxy(h2.store, {
      get(target, prop, receiver) {
        if (prop === 'getShard' && corruptOnce) {
          return () => {
            corruptOnce = false;
            return Promise.resolve({ kind: 'corrupt', reason: 'flipped bit' });
          };
        }
        if (prop === 'deleteShard') {
          return (k: never) => {
            deletions.push(k);
            return h2.store.deleteShard(k);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const messages: FromWorker[] = [];
    const engine = new WorkerEngine(corruptingStore, (m) => messages.push(m), () => Promise.resolve());
    await engine.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE,
      job: 1, generation: 'g3', docs: [{ doc: 'b', language: 'en', sourceByteLength: 12 }],
    });
    await engine.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g3', doc: 'b', bytes: bytes(docs.b) });
    // First ingest read the corrupt record: it must repair, then a SECOND
    // sequential ingest of the now-ready doc must also repair if corrupt.
    expect(messages.some((m) => m.t === 'warning' && m.code === 'CACHE_CORRUPT')).toBe(true);
    expect(deletions.length).toBe(1);
    corruptOnce = true; // the doc is READY now; corruption must still repair
    const warningsBefore2 = messages.filter((m) => m.t === 'warning').length;
    await engine.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 3, generation: 'g3', doc: 'b', bytes: bytes(docs.b) });
    expect(messages.filter((m) => m.t === 'warning').slice(warningsBefore2).some((w) => 'code' in w && w.code === 'CACHE_CORRUPT')).toBe(true);
    expect(deletions.length).toBe(2);
  });

  it('a cancel during source hashing reports cancelled, never SOURCE_MISMATCH', async () => {
    // Review P2: park Web Crypto's digest, cancel the job, then release —
    // the ownership gate after hashing must win over the identity check.
    const h = harness();
    const asserted = await hashText('what the manifest promised');
    await h.send({
      t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g',
      docs: [{ doc: 'a', language: 'en', sourceByteLength: 10, expectedText: asserted }],
    });
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let releaseDigest: (() => void) | null = null;
    let armed = true;
    const digestSpy = (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
      if (!armed) return realDigest(algorithm, data);
      armed = false;
      return new Promise((resolve) => {
        releaseDigest = () => resolve(realDigest(algorithm, data));
      });
    };
    Object.defineProperty(crypto.subtle, 'digest', { value: digestSpy, configurable: true });
    try {
      const ingestPromise = h.send({ t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: bytes('different content') });
      while (releaseDigest === null) await new Promise((r) => setTimeout(r, 0));
      await h.send({ t: 'cancel', job: 2 });
      (releaseDigest as unknown as () => void)();
      await ingestPromise;
    } finally {
      Object.defineProperty(crypto.subtle, 'digest', { value: realDigest, configurable: true });
    }
    expect(h.all('error').map((e) => e.code)).not.toContain('SOURCE_MISMATCH');
    expect(h.messages.some((m) => m.t === 'cancelled' && m.job === 2)).toBe(true);
  });

  it('a cancel during cache admission reports cancelled before any progress', async () => {
    const docs = { a: 'the wolf ran' };
    const { store, hashes } = await warmed(docs);
    let releaseShardRead: ((r: { kind: 'miss' }) => void) | null = null;
    const parkedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'getShard') {
          return () =>
            new Promise((resolve) => {
              releaseShardRead = resolve;
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const messages: FromWorker[] = [];
    const engine = new WorkerEngine(parkedStore, (m) => messages.push(m), () => Promise.resolve());
    await engine.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE,
      job: 1, generation: 'g2',
      docs: [{ doc: 'a', language: 'en', sourceByteLength: 12 }],
    });
    const ingestPromise = engine.handle({
      v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes(docs.a),
    });
    while (releaseShardRead === null) await new Promise((r) => setTimeout(r, 0));
    const before = messages.filter((m) => m.t === 'progress').length;
    await engine.handle({ v: PROTOCOL_VERSION, t: 'cancel', job: 2 });
    (releaseShardRead as unknown as (r: { kind: 'miss' }) => void)({ kind: 'miss' });
    await ingestPromise;
    expect(messages.some((m) => m.t === 'cancelled' && m.job === 2)).toBe(true);
    expect(messages.filter((m) => m.t === 'progress').length).toBe(before); // no segment/index after cancel
    expect(messages.some((m) => m.t === 'snapshot-published')).toBe(false);
    void hashes;
  });

  it('a cancelled warm rehydration stops without a generation-ready barrier', async () => {
    const docs = { a: 'the wolf ran' };
    const { store, hashes } = await warmed(docs);
    let park = false;
    let resolveYield: (() => void) | null = null;
    const messages: FromWorker[] = [];
    const engine = new WorkerEngine(
      store,
      (m) => messages.push(m),
      () =>
        park
          ? new Promise<void>((resolve) => {
              resolveYield = resolve;
            })
          : Promise.resolve(),
    );
    park = true;
    const beginPromise = engine.handle({
      v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE,
      job: 1, generation: 'g2', docs: specsFor(docs, hashes),
    });
    await Promise.resolve(); // reach the parked first checkpoint
    await engine.handle({ v: PROTOCOL_VERSION, t: 'cancel', job: 1 });
    while (resolveYield === null) await new Promise((r) => setTimeout(r, 0));
    (resolveYield as unknown as () => void)();
    await beginPromise;
    expect(messages.some((m) => m.t === 'cancelled' && m.job === 1)).toBe(true);
    expect(messages.some((m) => m.t === 'generation-ready')).toBe(false);
    expect(messages.some((m) => m.t === 'snapshot-published')).toBe(false);
  });
});

describe('queries and excerpts', () => {
  it('answers trend and kwic against the published snapshot', async () => {
    const h = harness();
    const pub = await ingested(h, { a: 'the wolf ran far. a wolf slept.' });
    await h.send({
      t: 'query', job: 20, snapshot: pub.snapshot,
      query: {
        op: 'trend',
        selection: { docs: ['a'] },
        group: wolfGroup,
        request: { coordinate: 'document-relative', binsPerDoc: 2 },
      } as never,
    });
    const trendResult = h.last('result');
    expect(trendResult.data.op).toBe('trend');
    if (trendResult.data.op === 'trend') {
      expect(Array.from(trendResult.data.trend.count)).toEqual([1, 1]);
    }
    await h.send({
      t: 'query', job: 21, snapshot: pub.snapshot,
      query: {
        op: 'kwic',
        selection: { docs: ['a'] },
        group: wolfGroup,
        request: { contextTokens: 1, sort: [{ at: 'pos', dir: 1 }], page: { offset: 0, limit: 10 } },
      } as never,
    });
    const kwicResult = h.last('result');
    expect(kwicResult.data.op).toBe('kwic');
    if (kwicResult.data.op === 'kwic') {
      expect(kwicResult.data.total).toBe(2);
      expect(kwicResult.data.rows[0]!.nodeText).toBe('wolf');
    }
  });

  it('answers passage with marks, per-token extents, and center span', async () => {
    const h = harness();
    const pub = await ingested(h, { a: 'the wolf ran far. a wolf slept.' });
    await h.send({
      t: 'query', job: 25, snapshot: pub.snapshot,
      query: {
        op: 'passage',
        request: {
          doc: 'a', centerToken: 3, maxTokens: 200,
          tracks: [{ seriesId: 's1', group: wolfGroup }],
        },
      } as never,
    });
    const result = h.last('result');
    expect(result.data.op).toBe('passage');
    if (result.data.op === 'passage') {
      const p = result.data.passage;
      expect(p.text).toBe('the wolf ran far. a wolf slept');
      expect(p.text.slice(p.centerCharsUtf16.start, p.centerCharsUtf16.end)).toBe('far');
      expect(p.marks.length).toBe(2);
      expect(p.marks.every((m) => m.seriesId === 's1')).toBe(true);
      expect(p.marks.map((m) => p.text.slice(m.charsUtf16.start, m.charsUtf16.end))).toEqual(['wolf', 'wolf']);
    }
  });

  it('rejects a passage centered out of range and duplicate track seriesIds as REQUEST_INVALID', async () => {
    const h = harness();
    const pub = await ingested(h, { a: 'only four tokens here' });
    await h.send({
      t: 'query', job: 26, snapshot: pub.snapshot,
      query: {
        op: 'passage',
        request: { doc: 'a', centerToken: 4, maxTokens: 10, tracks: [] },
      } as never,
    });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
    await h.send({
      t: 'query', job: 27, snapshot: pub.snapshot,
      query: {
        op: 'passage',
        request: {
          doc: 'a', centerToken: 1, maxTokens: 10,
          tracks: [
            { seriesId: 'dup', group: wolfGroup },
            { seriesId: 'dup', group: { ...wolfGroup, id: 'g9' } },
          ],
        },
      } as never,
    });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
  });

  it('a passage track with an empty phrase is REQUEST_INVALID, matching the trend path', async () => {
    const h = harness();
    const pub = await ingested(h, { a: 'the wolf ran' });
    await h.send({
      t: 'query', job: 28, snapshot: pub.snapshot,
      query: {
        op: 'passage',
        request: {
          doc: 'a', centerToken: 1, maxTokens: 10,
          tracks: [{
            seriesId: 's-bad',
            group: {
              id: 'g-bad',
              members: [{ id: 'p', kind: 'phrase', surfaces: [], match: { case: 'folded', diacritics: 'sensitive' }, crossSentence: false }],
              countOverlaps: false,
            },
          }],
        },
      } as never,
    });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
  });

  it('cancel state does not accrete: a late cancel for a finished job is dropped', async () => {
    const h = harness();
    const pub = await ingested(h, { a: 'the wolf ran' });
    await h.send({
      t: 'query', job: 40, snapshot: pub.snapshot,
      query: {
        op: 'trend', selection: { docs: ['a'] }, group: wolfGroup,
        request: { coordinate: 'document-relative', binsPerDoc: 1 },
      } as never,
    });
    expect(h.last('result').data.op).toBe('trend');
    await h.send({ t: 'cancel', job: 40 }); // job already finished
    const internals = h.engine as unknown as { activeJobs: Set<number>; cancelledJobs: Set<number> };
    expect(internals.activeJobs.size).toBe(0);
    expect(internals.cancelledJobs.size).toBe(0);
    // The next job with the same id (client never reuses, but state must not
    // depend on that) runs unimpeded.
    await h.send({
      t: 'query', job: 40, snapshot: pub.snapshot,
      query: {
        op: 'trend', selection: { docs: ['a'] }, group: wolfGroup,
        request: { coordinate: 'document-relative', binsPerDoc: 1 },
      } as never,
    });
    expect(h.last('result').data.op).toBe('trend');
  });

  it('rejects queries against superseded snapshots (SNAPSHOT_UNKNOWN)', async () => {
    const h = harness();
    await ingested(h, { a: 'wolf one', b: 'wolf two' });
    const first = h.all('snapshot-published')[0]!;
    await h.send({
      t: 'query', job: 30, snapshot: first.snapshot,
      query: {
        op: 'trend', selection: { docs: ['a'] }, group: wolfGroup,
        request: { coordinate: 'document-relative', binsPerDoc: 1 },
      } as never,
    });
    expect(h.last('error').code).toBe('SNAPSHOT_UNKNOWN');
  });

  it('maps invalid selections to SELECTION_INVALID', async () => {
    const h = harness();
    const pub = await ingested(h, { a: 'wolf' });
    await h.send({
      t: 'query', job: 31, snapshot: pub.snapshot,
      query: {
        op: 'trend', selection: { docs: ['zz'] }, group: wolfGroup,
        request: { coordinate: 'document-relative', binsPerDoc: 1 },
      } as never,
    });
    expect(h.last('error').code).toBe('SELECTION_INVALID');
  });

  it('a query whose generation is replaced mid-flight never emits a result', async () => {
    // Park the query at its first checkpoint, replace the generation, release.
    let resolveYield: (() => void) | null = null;
    let manual = false;
    const messages: FromWorker[] = [];
    const store = new InMemoryArtifactStore();
    const engine = new WorkerEngine(
      store,
      (m) => messages.push(m),
      () =>
        manual
          ? new Promise<void>((resolve) => {
              resolveYield = resolve;
            })
          : Promise.resolve(),
    );
    await engine.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g', docs: [{ doc: 'a', language: 'en', sourceByteLength: 4 }] });
    await engine.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: bytes('wolf') });
    const pub = messages.find((m) => m.t === 'snapshot-published')!;
    manual = true;
    const queryPromise = engine.handle({
      v: PROTOCOL_VERSION, t: 'query', job: 3, snapshot: pub.snapshot,
      query: {
        op: 'trend', selection: { docs: ['a'] }, group: wolfGroup,
        request: { coordinate: 'document-relative', binsPerDoc: 1 },
      } as never,
    });
    await Promise.resolve(); // let the query reach its parked checkpoint
    await engine.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 4, generation: 'g2', docs: [] });
    while (resolveYield === null) await new Promise((r) => setTimeout(r, 0));
    (resolveYield as unknown as () => void)();
    await queryPromise;
    expect(messages.some((m) => m.t === 'result')).toBe(false);
    expect(messages.some((m) => m.t === 'error' && m.code === 'SNAPSHOT_UNKNOWN')).toBe(true);
  });

  it('a cancel queued during the FINAL kernel phase is observed before emission', async () => {
    // Auto-yield for ingest; then count query yields and deliver a cancel at
    // the post-kernel checkpoint (the 4th query yield).
    const messages: FromWorker[] = [];
    const store = new InMemoryArtifactStore();
    let queryYields = 0;
    let counting = false;
    let engineRef: WorkerEngine | null = null;
    const engine = new WorkerEngine(store, (m) => messages.push(m), async () => {
      if (!counting) return;
      queryYields++;
      if (queryYields === 4) {
        await engineRef!.handle({ v: PROTOCOL_VERSION, t: 'cancel', job: 3 });
      }
    });
    engineRef = engine;
    await engine.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g', docs: [{ doc: 'a', language: 'en', sourceByteLength: 4 }] });
    await engine.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: bytes('wolf') });
    const pub = messages.find((m) => m.t === 'snapshot-published')!;
    counting = true;
    await engine.handle({
      v: PROTOCOL_VERSION, t: 'query', job: 3, snapshot: pub.snapshot,
      query: {
        op: 'trend', selection: { docs: ['a'] }, group: wolfGroup,
        request: { coordinate: 'document-relative', binsPerDoc: 1 },
      } as never,
    });
    expect(queryYields).toBeGreaterThanOrEqual(4); // the post-kernel checkpoint exists
    expect(messages.some((m) => m.t === 'result')).toBe(false);
    expect(messages.some((m) => m.t === 'cancelled' && m.job === 3)).toBe(true);
  });

  it('same-key STRUCTURAL corruption is ARTIFACT_CORRUPT and rebuilt', async () => {
    const h = harness();
    await ingested(h, { a: 'the wolf ran' });
    const anyStore = h.store as unknown as { shards: Map<string, { lengths8: Uint8Array }> };
    const [key] = anyStore.shards.keys();
    const record = anyStore.shards.get(key!)!;
    record.lengths8[0] = 0; // same key, same descriptor — corrupt array bytes
    const messages2: FromWorker[] = [];
    const engine2 = new WorkerEngine(h.store, (m) => messages2.push(m), () => Promise.resolve());
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g2', docs: [{ doc: 'a', language: 'en', sourceByteLength: 12 }] });
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes('the wolf ran') });
    expect(messages2.some((m) => m.t === 'warning' && m.code === 'CACHE_CORRUPT')).toBe(true);
    const phases = messages2.filter((m) => m.t === 'progress').map((m) => (m as { phase: string }).phase);
    expect(phases).toContain('segment'); // rebuilt, not silently served
    expect(messages2.some((m) => m.t === 'snapshot-published')).toBe(true);
  });

  it('same-key IN-DOMAIN geometry past the text end is ARTIFACT_CORRUPT and rebuilt', async () => {
    const h = harness();
    await ingested(h, { a: 'alpha wolf' });
    const anyStore = h.store as unknown as { shards: Map<string, { startsUtf16: Uint32Array }> };
    const [key] = anyStore.shards.keys();
    anyStore.shards.get(key!)!.startsUtf16[1] = 100; // valid ABI, beyond this text
    const messages2: FromWorker[] = [];
    const engine2 = new WorkerEngine(h.store, (m) => messages2.push(m), () => Promise.resolve());
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 1, generation: 'g2', docs: [{ doc: 'a', language: 'en', sourceByteLength: 10 }] });
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes('alpha wolf') });
    expect(messages2.some((m) => m.t === 'warning' && m.code === 'CACHE_CORRUPT')).toBe(true);
    const phases = messages2.filter((m) => m.t === 'progress').map((m) => (m as { phase: string }).phase);
    expect(phases).toContain('segment');
    expect(messages2.some((m) => m.t === 'snapshot-published')).toBe(true);
  });

  it('re-ingesting a document replaces its resolver cache atomically', async () => {
    const h = harness();
    const pub1 = await ingested(h, { a: 'wolf' });
    // Populate the folded resolver against the first shard.
    await h.send({
      t: 'query', job: 70, snapshot: pub1.snapshot,
      query: {
        op: 'trend', selection: { docs: ['a'] }, group: wolfGroup,
        request: { coordinate: 'document-relative', binsPerDoc: 1 },
      } as never,
    });
    expect(h.last('result').data.op).toBe('trend');
    // Replace the document's content under the same generation.
    await h.send({ t: 'ingest', job: 71, generation: 'gen-1', doc: 'a', bytes: bytes('bear') });
    const pub2 = h.last('snapshot-published');
    expect(pub2.snapshot).not.toBe(pub1.snapshot);
    await h.send({
      t: 'query', job: 72, snapshot: pub2.snapshot,
      query: {
        op: 'trend', selection: { docs: ['a'] },
        group: { id: 'g2', members: [{ id: 'm', kind: 'token', surface: 'bear', match: FOLD }], countOverlaps: false },
        request: { coordinate: 'document-relative', binsPerDoc: 1 },
      } as never,
    });
    const result = h.last('result');
    expect(result.data.op).toBe('trend');
    if (result.data.op === 'trend') expect(Array.from(result.data.trend.count)).toEqual([1]);
    expect(h.messages.some((m) => m.t === 'error' && /different shard/.test(m.message))).toBe(false);
  });

  it('narrows nested payload shapes to typed parse errors', async () => {
    const h = harness();
    const pub = await ingested(h, { a: 'wolf' });
    await h.send({
      t: 'query', job: 60, snapshot: pub.snapshot,
      query: { op: 'trend', selection: { docs: ['a'] }, group: null, request: { coordinate: 'document-relative', binsPerDoc: 1 } } as never,
    });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
    await h.send({
      t: 'query', job: 61, snapshot: pub.snapshot,
      query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: null } as never,
    });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
    await h.send({ t: 'begin-generation', recipe: DEFAULT_INDEX_RECIPE, job: 62, generation: 'gx', docs: null as never });
    expect(h.last('error').code).toBe('PARSE_FAILED');
    // Member ELEMENTS narrow too — INTERNAL is reserved for genuine faults.
    await h.send({
      t: 'query', job: 63, snapshot: pub.snapshot,
      query: {
        op: 'trend', selection: { docs: ['a'] },
        group: { id: 'g', members: [null], countOverlaps: false },
        request: { coordinate: 'document-relative', binsPerDoc: 1 },
      } as never,
    });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
    // Semantic-bearing scalars must be EXACT: a string 'false' must not be
    // interpreted as overlap mode, nor a bogus match value as 'sensitive'.
    await h.send({
      t: 'query', job: 64, snapshot: pub.snapshot,
      query: {
        op: 'trend', selection: { docs: ['a'] },
        group: { id: 'g', members: [{ id: 'm', kind: 'token', surface: 'wolf', match: FOLD }], countOverlaps: 'false' },
        request: { coordinate: 'document-relative', binsPerDoc: 1 },
      } as never,
    });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
    await h.send({
      t: 'query', job: 65, snapshot: pub.snapshot,
      query: {
        op: 'trend', selection: { docs: ['a'] },
        group: { id: 'g', members: [{ id: 'm', kind: 'token', surface: 'wolf', match: { case: 'bogus', diacritics: 'folded' } }], countOverlaps: false },
        request: { coordinate: 'document-relative', binsPerDoc: 1 },
      } as never,
    });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
    await h.send({
      t: 'query', job: 66, snapshot: pub.snapshot,
      query: {
        op: 'kwic', selection: { docs: ['a'] }, group: wolfGroup,
        request: { contextTokens: 1, sort: null, page: { offset: 0, limit: 10 } },
      } as never,
    });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
  });

  it('maps malformed requests and unknown ops deterministically', async () => {
    const h = harness();
    const pub = await ingested(h, { a: 'wolf' });
    await h.send({
      t: 'query', job: 50, snapshot: pub.snapshot,
      query: {
        op: 'trend', selection: { docs: ['a'] }, group: wolfGroup,
        request: { coordinate: 'document-relative', binsPerDoc: 0 },
      } as never,
    });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
    await h.send({
      t: 'query', job: 51, snapshot: pub.snapshot,
      query: { op: 'bogus' } as never,
    });
    expect(h.last('error').code).toBe('UNKNOWN_OP');
    await h.engine.handle({ v: PROTOCOL_VERSION, t: 'nonsense', job: 52 } as never);
    expect(h.last('error').code).toBe('UNKNOWN_OP');
    // Malformed envelopes and malformed query objects:
    await h.engine.handle(null as never);
    expect(h.last('error').code).toBe('PARSE_FAILED');
    await h.send({ t: 'query', job: 53, snapshot: pub.snapshot, query: null as never });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
    // Message-text independence: an empty phrase whose member id is 'cap'
    // must map to REQUEST_INVALID, never CAP_EXCEEDED (typed mapping).
    await h.send({
      t: 'query', job: 54, snapshot: pub.snapshot,
      query: {
        op: 'trend',
        selection: { docs: ['a'] },
        group: { id: 'g', members: [{ id: 'cap', kind: 'phrase', surfaces: [], match: FOLD, crossSentence: false }], countOverlaps: false },
        request: { coordinate: 'document-relative', binsPerDoc: 1 },
      } as never,
    });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
  });

  it('serves and validates excerpts', async () => {
    const h = harness();
    const pub = await ingested(h, { a: 'the wolf ran' });
    await h.send({ t: 'excerpt', job: 40, snapshot: pub.snapshot, doc: 'a', charStart: 4, charEnd: 8 });
    expect(h.last('excerpt-result').text).toBe('wolf');
    await h.send({ t: 'excerpt', job: 41, snapshot: pub.snapshot, doc: 'a', charStart: 8, charEnd: 4 });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
    await h.send({ t: 'excerpt', job: 42, snapshot: 'nope', doc: 'a', charStart: 0, charEnd: 2 });
    expect(h.last('error').code).toBe('SNAPSHOT_UNKNOWN');
  });
});
