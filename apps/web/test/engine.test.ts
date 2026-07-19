import { describe, expect, it } from 'vitest';
import { WorkerEngine } from '../src/worker/engine.ts';
import { InMemoryArtifactStore } from '../src/worker/store.ts';
import { PROTOCOL_VERSION, type FromWorker, type ToWorker } from '../src/worker/protocol.ts';

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
    await h.send({ t: 'begin-generation', job: 1, generation: 'g', docs: [{ doc: 'a', language: 'en', sourceByteLength: 2 }] });
    await h.send({ t: 'ingest', job: 2, generation: 'g', doc: 'a', bytes: Uint8Array.from([0xff, 0xfe]).buffer as ArrayBuffer });
    expect(h.last('error').code).toBe('DECODE_FAILED');
  });

  it('suppresses jobs from a replaced generation by identity', async () => {
    const h = harness();
    await h.send({ t: 'begin-generation', job: 1, generation: 'old', docs: [{ doc: 'a', language: 'en', sourceByteLength: 1 }] });
    await h.send({ t: 'begin-generation', job: 2, generation: 'new', docs: [{ doc: 'a', language: 'en', sourceByteLength: 1 }] });
    await h.send({ t: 'ingest', job: 3, generation: 'old', doc: 'a', bytes: bytes('x') });
    expect(h.last('error').code).toBe('GENERATION_STALE');
    expect(h.all('snapshot-published').length).toBe(0);
  });

  it('a cancel queued at a checkpoint stops the job before publication', async () => {
    // Manual yields: the ingest parks at its first checkpoint until released.
    let resolveYield: (() => void) | null = null;
    const engine2Messages: FromWorker[] = [];
    const engine2 = new WorkerEngine(
      new InMemoryArtifactStore(),
      (m) => engine2Messages.push(m),
      () =>
        new Promise<void>((resolve) => {
          resolveYield = resolve;
        }),
    );
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', job: 1, generation: 'g', docs: [{ doc: 'a', language: 'en', sourceByteLength: 5 }] });
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
    await engine.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', job: 1, generation: 'g', docs: [{ doc: 'a', language: 'en', sourceByteLength: 5 }] });
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
          void engineRef!.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', job: 9, generation: 'g2', docs: [] });
        }
      },
      () => Promise.resolve(),
    );
    engineRef = engine;
    await engine.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', job: 1, generation: 'g1', docs: [{ doc: 'a', language: 'en', sourceByteLength: 5 }] });
    await engine.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g1', doc: 'a', bytes: bytes('wolf!') });
    expect(messages.some((m) => m.t === 'snapshot-published')).toBe(false);
    expect(messages.some((m) => m.t === 'error' && m.code === 'GENERATION_STALE')).toBe(true);
  });

  it('the warm key does NOT alias across locales; corrupted records rebuild', async () => {
    // Same text under en then fr: the fr ingest must segment/index itself
    // (probe hashes can collide across locales; the FULL fingerprint keys).
    const h = harness();
    await h.send({
      t: 'begin-generation', job: 1, generation: 'g',
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
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', job: 1, generation: 'g2', docs: [{ doc: 'a', language: 'en', sourceByteLength: 12 }] });
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes('the wolf ran') });
    expect(messages2.some((m) => m.t === 'error' && m.code === 'ARTIFACT_CORRUPT')).toBe(true);
    expect(messages2.some((m) => m.t === 'snapshot-published')).toBe(true); // rebuilt
  });

  it('warm reopen skips segmentation via the artifact store', async () => {
    const h = harness();
    await ingested(h, { a: 'the wolf ran' });
    // Second engine sharing the same store: same text, fresh generation.
    const messages2: FromWorker[] = [];
    const engine2 = new WorkerEngine(h.store, (m) => messages2.push(m), () => Promise.resolve());
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', job: 1, generation: 'g2', docs: [{ doc: 'a', language: 'en', sourceByteLength: 12 }] });
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes('the wolf ran') });
    const phases = messages2.filter((m) => m.t === 'progress').map((m) => (m as { phase: string }).phase);
    expect(phases).toEqual(['decode', 'compose']); // no segment/index on the warm path
    expect(messages2.some((m) => m.t === 'snapshot-published')).toBe(true);
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
    await engine.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', job: 1, generation: 'g', docs: [{ doc: 'a', language: 'en', sourceByteLength: 4 }] });
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
    await engine.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', job: 4, generation: 'g2', docs: [] });
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
    await engine.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', job: 1, generation: 'g', docs: [{ doc: 'a', language: 'en', sourceByteLength: 4 }] });
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
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', job: 1, generation: 'g2', docs: [{ doc: 'a', language: 'en', sourceByteLength: 12 }] });
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes('the wolf ran') });
    expect(messages2.some((m) => m.t === 'error' && m.code === 'ARTIFACT_CORRUPT')).toBe(true);
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
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'begin-generation', job: 1, generation: 'g2', docs: [{ doc: 'a', language: 'en', sourceByteLength: 10 }] });
    await engine2.handle({ v: PROTOCOL_VERSION, t: 'ingest', job: 2, generation: 'g2', doc: 'a', bytes: bytes('alpha wolf') });
    expect(messages2.some((m) => m.t === 'error' && m.code === 'ARTIFACT_CORRUPT')).toBe(true);
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
    await h.send({ t: 'begin-generation', job: 62, generation: 'gx', docs: null as never });
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
