/**
 * WorkerEngineV4 lifecycle/race suite (commit 6b). Exercises the ingest/
 * structure worker in isolation over the injected ArtifactStore, UserData
 * provider, and yield seam — the same discipline as the v3 engine suite, plus
 * the new failure modes from the "Commit 6 design of record": override
 * derivation/verification, deep warm admission across the three artifact
 * stages, honest progress, per-document work claims, the snapshot-bound
 * structure query, and the separate user-data lane.
 */
import { describe, expect, it, vi } from 'vitest';
import { WorkerEngineV4, type UserDataAccess, type UserDataProvider } from '../src/worker/engine-v4.ts';
import { InMemoryArtifactStore, type ArtifactStore, type CacheRead } from '../src/worker/store.ts';
import { InMemoryUserDataStore, UserDataError, type UserDataStore } from '../src/worker/user-data-store.ts';
import { PROTOCOL_VERSION_V4, type FromWorkerV4, type GenerationDocSpecV4 } from '../src/worker/protocol-v4.ts';
import {
  bindSectionId,
  DEFAULT_INDEX_RECIPE,
  DEFAULT_STRUCTURE_RECIPE,
  INGEST_CAPS_V0,
  defaultExtractionRecipes,
  emptyOverride,
  extractDocument,
  hashExtractionRecipe,
  hashIndexRecipe,
  hashSourceBytes,
  hashStructureOverride,
  hashStructureRecipe,
  MAX_KWIC_TRACKS,
  type IngestCapsV0,
  type StructureOverrideV1,
} from '@texttrends/core';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const buf = (s: string): ArrayBuffer => utf8(s).buffer as ArrayBuffer;
const FOLD = { case: 'folded', diacritics: 'sensitive' } as const;

/** A store that can hide any artifact class (force a miss) to construct the
 *  warm-path table deterministically, and optionally hook the first read of a
 *  class (to interleave a concurrent ingest). Delegates everything else. */
class FilterStore implements ArtifactStore {
  hide = { text: false, shard: false, structure: false, extraction: false };
  onShardRead: (() => void | Promise<void>) | null = null;
  /** Called on every text read with the 1-based read count, so a test can
   *  interleave at a specific point (e.g. the 2nd document's read). */
  onTextRead: ((count: number) => void | Promise<void>) | null = null;
  private textReads = 0;
  resetReads() { this.textReads = 0; }
  writes = { text: 0, shard: 0, structure: 0, extraction: 0 };
  /** When set, the NEXT get{Shard,Text} reports envelope corruption, then reverts. */
  corruptShardOnce = false;
  corruptTextOnce = false;
  shardDeletes = 0;
  textDeletes = 0;
  constructor(readonly inner: InMemoryArtifactStore) {}
  async getText(h: string): Promise<CacheRead<string>> {
    this.textReads++;
    if (this.onTextRead) await this.onTextRead(this.textReads);
    if (this.corruptTextOnce) { this.corruptTextOnce = false; return { kind: 'corrupt', reason: 'stored text failed envelope validation' }; }
    return this.hide.text ? { kind: 'miss' } : this.inner.getText(h);
  }
  putText(h: string, t: string) { this.writes.text++; return this.inner.putText(h, t); }
  deleteText(h: string) { this.textDeletes++; return this.inner.deleteText(h); }
  async getShard(k: never): Promise<CacheRead<unknown>> {
    if (this.onShardRead) { const cb = this.onShardRead; this.onShardRead = null; await cb(); }
    if (this.corruptShardOnce) { this.corruptShardOnce = false; return { kind: 'corrupt', reason: 'stored record failed envelope validation' }; }
    return this.hide.shard ? { kind: 'miss' } : this.inner.getShard(k);
  }
  putShard(k: never, s: never) { this.writes.shard++; return this.inner.putShard(k, s); }
  deleteShard(k: never) { this.shardDeletes++; return this.inner.deleteShard(k); }
  async getExtraction(k: never): Promise<CacheRead<unknown>> { return this.hide.extraction ? { kind: 'miss' } : this.inner.getExtraction(k); }
  putExtraction(k: never, a: unknown) { this.writes.extraction++; return this.inner.putExtraction(k, a); }
  deleteExtraction(k: never) { return this.inner.deleteExtraction(k); }
  async getStructure(k: never): Promise<CacheRead<unknown>> { return this.hide.structure ? { kind: 'miss' } : this.inner.getStructure(k); }
  putStructure(k: never, a: unknown) { this.writes.structure++; return this.inner.putStructure(k, a); }
  deleteStructure(k: never) { return this.inner.deleteStructure(k); }
  close() { this.inner.close(); }
}

interface Harness {
  engine: WorkerEngineV4;
  messages: FromWorkerV4[];
  transferLists: (readonly Transferable[] | undefined)[];
  store: FilterStore;
  userStore: InMemoryUserDataStore;
  setUserData(p: UserDataProvider): void;
  /** Fires on every emitted message — deliver interleaved messages here. */
  onEmit(cb: ((m: FromWorkerV4) => void) | null): void;
  /** Fires on every yieldControl checkpoint (auto mode) — interleave here. */
  onYield(cb: (() => void | Promise<void>) | null): void;
  manual(): void;
  releaseYield(): void;
  send(m: Record<string, unknown>): Promise<void>;
  handle(m: Record<string, unknown>): Promise<void>;
  flush(): Promise<void>;
  last<T extends FromWorkerV4['t']>(t: T): Extract<FromWorkerV4, { t: T }>;
  all<T extends FromWorkerV4['t']>(t: T): Extract<FromWorkerV4, { t: T }>[];
  clear(): void;
}

function harness(caps: IngestCapsV0 = INGEST_CAPS_V0, sharedStore?: FilterStore): Harness {
  const messages: FromWorkerV4[] = [];
  const transferLists: (readonly Transferable[] | undefined)[] = [];
  const store = sharedStore ?? new FilterStore(new InMemoryArtifactStore());
  const userStore = new InMemoryUserDataStore();
  let provider: UserDataProvider = () => Promise.resolve({ kind: 'ok', store: userStore } as UserDataAccess);
  let auto = true;
  let emitCb: ((m: FromWorkerV4) => void) | null = null;
  let yieldCb: (() => void | Promise<void>) | null = null;
  const pending: (() => void)[] = [];
  const engine = new WorkerEngineV4(
    store,
    () => provider(),
    (m, transfers) => { messages.push(m); transferLists.push(transfers); emitCb?.(m); },
    async () => {
      if (yieldCb) await yieldCb();
      if (!auto) await new Promise<void>((resolve) => pending.push(resolve));
    },
    caps,
  );
  return {
    engine,
    messages,
    transferLists,
    store,
    userStore,
    setUserData: (p) => { provider = p; },
    onEmit: (cb) => { emitCb = cb; },
    onYield: (cb) => { yieldCb = cb; },
    manual: () => { auto = false; },
    releaseYield: () => pending.shift()?.(),
    send: (m) => engine.handle({ v: PROTOCOL_VERSION_V4, ...m }),
    handle: (m) => engine.handle(m),
    flush: () => new Promise<void>((r) => setTimeout(r, 0)),
    last: (t) => {
      const found = [...messages].reverse().find((m) => m.t === t);
      if (!found) throw new Error(`no message of type ${t}`);
      return found as never;
    },
    all: (t) => messages.filter((m) => m.t === t) as never,
    clear: () => { messages.length = 0; },
  };
}

async function docSpec(
  doc: string,
  text: string,
  opts: { format?: 'txt' | 'md'; availability?: 'bundled' | 'persisted' | 'external'; override?: GenerationDocSpecV4['structure']['override'] } = {},
): Promise<GenerationDocSpecV4> {
  const recipes = await defaultExtractionRecipes();
  const format = opts.format ?? 'txt';
  const recipe = format === 'md' ? recipes.md : recipes.txt;
  const bytes = utf8(text);
  const extracted = await extractDocument(bytes, recipe);
  return {
    doc,
    language: 'en',
    source: { expectedHash: extracted.artifact.source, byteLength: bytes.length, format, availability: opts.availability ?? 'external' },
    extraction: {
      recipe,
      recipeHash: await hashExtractionRecipe(recipe),
      expectedText: extracted.artifact.text,
      expectedTextLengthUtf16: extracted.artifact.textLengthUtf16,
      expectedCandidates: extracted.artifact.candidateHash,
    },
    structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: await hashStructureRecipe(DEFAULT_STRUCTURE_RECIPE), override: opts.override ?? { kind: 'none' } },
  };
}

async function begin(h: Harness, docs: GenerationDocSpecV4[], generation = 'g') {
  await h.send({ t: 'begin-generation', job: 1, generation, docs, indexRecipe: DEFAULT_INDEX_RECIPE });
}
async function coldIngest(h: Harness, generation: string, doc: string, text: string, job: number) {
  await h.send({ t: 'ingest', job, generation, doc, bytes: buf(text) });
}

const wolfGroup = { id: 'g1', members: [{ id: 'm1', kind: 'token' as const, surface: 'wolf', match: FOLD }], countOverlaps: false };

describe('generation resolution and plan validation', () => {
  it('rejects an active override whose claimed hash does not match its value (before any warm work)', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far');
    const bad: GenerationDocSpecV4 = { ...spec, structure: { ...spec.structure, override: { kind: 'active', value: emptyOverride(spec.extraction.expectedText!, spec.extraction.expectedCandidates!, spec.structure.recipeHash), hash: 'wrong-hash' } } };
    await begin(h, [bad]);
    expect(h.last('error').code).toBe('REQUEST_INVALID');
    expect(h.all('generation-ready').length).toBe(0);
  });

  it('recomputes recipe hashes and rejects a mismatch', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far');
    await begin(h, [{ ...spec, extraction: { ...spec.extraction, recipeHash: 'wrong' } }]);
    expect(h.last('error').code).toBe('REQUEST_INVALID');
  });

  it('enforces the per-file ingest cap on a declared source', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far');
    await begin(h, [{ ...spec, source: { ...spec.source, byteLength: 40 * 1024 * 1024 } }]);
    expect(h.last('error').code).toBe('CAP_EXCEEDED');
  });

  it('enforces the project caps for FRESH imports that carry no text assertion (byteLength bounds text)', async () => {
    const recipes = await defaultExtractionRecipes();
    // A fresh import: source only, no extraction/expectedText/expectedCandidates.
    const fresh = async (doc: string, byteLength: number): Promise<GenerationDocSpecV4> => ({
      doc, language: 'en',
      source: { byteLength, format: 'txt', availability: 'external' },
      extraction: { recipe: recipes.txt, recipeHash: await hashExtractionRecipe(recipes.txt) },
      structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: await hashStructureRecipe(DEFAULT_STRUCTURE_RECIPE), override: { kind: 'none' } },
    });
    // Three 30 MiB fresh imports: source sum (90 MiB) is under the 128 MiB
    // source cap, but each byteLength bounds its text, so the text total
    // (90 Mi units) exceeds the 64 Mi project text cap — caught with no
    // expectedTextLengthUtf16 to lean on.
    const h = harness();
    await begin(h, [await fresh('a', 30 * 1024 * 1024), await fresh('b', 30 * 1024 * 1024), await fresh('c', 30 * 1024 * 1024)]);
    expect(h.last('error').code).toBe('CAP_EXCEEDED');

    // And the project SOURCE-byte cap: five 30 MiB imports exceed 128 MiB.
    const h2 = harness();
    await begin(h2, await Promise.all([0, 1, 2, 3, 4].map((i) => fresh(`d${i}`, 30 * 1024 * 1024))));
    expect(h2.last('error').code).toBe('CAP_EXCEEDED');
  });

  it('an oversized ingest fails while the documents already ingested stand', async () => {
    const h = harness();
    const a = await docSpec('a', 'the wolf ran far');
    const recipes = await defaultExtractionRecipes();
    const b: GenerationDocSpecV4 = {
      doc: 'b', language: 'en',
      source: { byteLength: 8, format: 'txt', availability: 'external' },
      extraction: { recipe: recipes.txt, recipeHash: await hashExtractionRecipe(recipes.txt) },
      structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: await hashStructureRecipe(DEFAULT_STRUCTURE_RECIPE), override: { kind: 'none' } },
    };
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 10);
    expect(h.last('snapshot-published').readyDocs).toEqual(['a']);
    // b over-delivers past the per-file cap: rejected before decode, and a stands.
    await h.send({ t: 'ingest', job: 11, generation: 'g', doc: 'b', bytes: new ArrayBuffer(33 * 1024 * 1024) });
    expect(h.last('error').code).toBe('CAP_EXCEEDED');
    expect(h.all('snapshot-published').at(-1)!.readyDocs).toEqual(['a']); // a still stands
  });
});

describe('actual aggregate ingest caps (injected small caps)', () => {
  // A spec that UNDER-declares its source/text sizes so the DECLARED begin
  // preflight passes but the ACTUAL sizes must be caught at ingest — the exact
  // gap the atomic freeze charge and the commit-path resident-text cap close.
  async function underDeclared(doc: string, text: string): Promise<GenerationDocSpecV4> {
    const spec = await docSpec(doc, text);
    return { ...spec, source: { ...spec.source, byteLength: 1 }, extraction: { ...spec.extraction, expectedTextLengthUtf16: 1 } };
  }

  it('charges ACTUAL transferred bytes atomically: the crossing ingest fails while the prior stands', async () => {
    const h = harness({ ...INGEST_CAPS_V0, maxProjectSourceBytes: 25 });
    const a = await underDeclared('a', 'the wolf ran far'); // 16 actual bytes
    const b = await underDeclared('b', 'a wolf slept now'); // 16 actual bytes → 32 > 25
    await begin(h, [a, b]); // declared total 2 bytes — passes the preflight
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 10);
    expect(h.last('snapshot-published').readyDocs).toEqual(['a']);
    await coldIngest(h, 'g', 'b', 'a wolf slept now', 11);
    expect(h.last('error').code).toBe('CAP_EXCEEDED');
    expect(h.all('snapshot-published').at(-1)!.readyDocs).toEqual(['a']); // a still stands
  });

  it('an idempotent re-ingest at the exact source cap does NOT double-charge', async () => {
    const h = harness({ ...INGEST_CAPS_V0, maxProjectSourceBytes: 16 }); // exactly one doc
    const a = await underDeclared('a', 'the wolf ran far'); // 16 actual bytes
    await begin(h, [a]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 10);
    expect(h.last('snapshot-published').readyDocs).toEqual(['a']);
    // Same bytes again: freeze returns false and re-charges nothing, so the
    // total stays at the cap rather than doubling to 32 and tripping CAP_EXCEEDED.
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 11);
    expect(h.all('error').length).toBe(0);
  });

  it('enforces the resident-text cap on the shared commit path with crossing-document semantics', async () => {
    const h = harness({ ...INGEST_CAPS_V0, maxProjectTextUtf16: 25 });
    const a = await underDeclared('a', 'the wolf ran far'); // 16 units
    const b = await underDeclared('b', 'a wolf slept nearby'); // 19 → 35 > 25
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 10);
    expect(h.last('snapshot-published').readyDocs).toEqual(['a']);
    await coldIngest(h, 'g', 'b', 'a wolf slept nearby', 11);
    expect(h.last('error').code).toBe('CAP_EXCEEDED');
    // 'a' stands; only the crossing document 'b' failed.
    expect(h.all('snapshot-published').at(-1)!.readyDocs).toEqual(['a']);
  });

  it('charges the transferred bytes atomically under INTERLEAVED ingests (exactly one crosses)', async () => {
    const h = harness({ ...INGEST_CAPS_V0, maxProjectSourceBytes: 25 });
    const a = await underDeclared('a', 'the wolf ran far'); // 16 bytes
    const b = await underDeclared('b', 'a wolf slept now'); // 16 → 32 > 25
    await begin(h, [a, b]);
    // Both ingests in flight at once — the synchronous check-and-charge in
    // freezeAccepted serializes them, so exactly one commits and one crosses.
    await Promise.all([
      h.send({ t: 'ingest', job: 10, generation: 'g', doc: 'a', bytes: buf('the wolf ran far') }),
      h.send({ t: 'ingest', job: 11, generation: 'g', doc: 'b', bytes: buf('a wolf slept now') }),
    ]);
    expect(h.all('error').filter((e) => e.code === 'CAP_EXCEEDED').length).toBe(1);
    expect(h.last('snapshot-published').readyDocs.length).toBe(1); // exactly one committed
  });

  it('selects the fitting prefix within ONE warm exact-hit batch (not reject-the-whole-batch)', async () => {
    // Populate the store under normal caps, then warm-reopen the SAME store
    // under a tiny resident-text cap so both exact hits land in one cheap batch.
    const pop = harness();
    const a = await underDeclared('a', 'the wolf ran far'); // 16 units
    const b = await underDeclared('b', 'a wolf slept nearby'); // 19 → 35 > 25
    await begin(pop, [a, b], 'cold');
    await coldIngest(pop, 'cold', 'a', 'the wolf ran far', 10);
    await coldIngest(pop, 'cold', 'b', 'a wolf slept nearby', 11);
    await pop.flush();
    const warm = harness({ ...INGEST_CAPS_V0, maxProjectTextUtf16: 25 }, pop.store);
    await begin(warm, [a, b], 'warm');
    // One batch: 'a' fits and publishes, 'b' crosses and is reported — the whole
    // batch is NOT rejected.
    expect(warm.last('generation-ready').readyDocs).toEqual(['a']);
    expect(warm.all('error').filter((e) => e.code === 'CAP_EXCEEDED').map((e) => e.message.includes("'b'")).some(Boolean)).toBe(true);
  });
});

describe('cold ingest', () => {
  it('a first cold ingest with override:none derives a canonical empty override and answers the structure query', async () => {
    const h = harness();
    const spec = await docSpec('a', '# Chapter I\n\nthe wolf ran far\n\n# Chapter II\n\na wolf slept', { format: 'md' });
    await begin(h, [spec]);
    const ready = h.last('generation-ready');
    expect(ready.missing.map((m) => m.doc)).toEqual(['a']);
    await coldIngest(h, 'g', 'a', '# Chapter I\n\nthe wolf ran far\n\n# Chapter II\n\na wolf slept', 10);
    const published = h.last('snapshot-published');
    expect(published.readyDocs).toEqual(['a']);

    // Honest cold progress includes decode and extract.
    const phases = h.all('progress').map((p) => p.phase);
    expect(phases).toEqual(['decode', 'extract', 'segment', 'index', 'structure', 'compose']);

    // The structure query echoes both bound identities and returns the outline.
    await h.send({ t: 'query', job: 20, snapshot: published.snapshot, query: { op: 'structure', request: { doc: 'a' } } });
    const result = h.last('result');
    expect(result.data.op).toBe('structure');
    if (result.data.op === 'structure') {
      expect(result.data.structure.doc).toBe('a');
      expect(result.data.structure.structure).toBeTruthy();
      expect(result.data.structure.index).toBeTruthy();
      // root + two detected chapters.
      expect(result.data.structure.rows.length).toBe(3);
      expect(result.data.structure.rows[0]!.section.origin).toBe('fixed');
      expect(result.data.structure.rows.some((r) => r.section.title?.includes('Chapter'))).toBe(true);
    }
  });

  it('emits source-ready with honest decoder evidence and the full descriptor', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far');
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 10);
    const sr = h.last('source-ready');
    expect(sr.source.hash).toBe(spec.source.expectedHash);
    expect(sr.text).toBe(spec.extraction.expectedText);
    expect(sr.candidates).toBe(spec.extraction.expectedCandidates);
    expect(sr.decoderReplacementCount).toBe(0);
    if (sr.source.kind !== 'text') throw new Error('expected a text source descriptor');
    expect(sr.source.encoding.hadReplacementChars).toBe(false);
  });

  it('rejects an active override whose base identities disagree with the extracted text', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far');
    const wrongBase = emptyOverride('OTHERTEXTHASH', spec.extraction.expectedCandidates!, spec.structure.recipeHash);
    const active: GenerationDocSpecV4['structure']['override'] = { kind: 'active', value: wrongBase, hash: await hashStructureOverride(wrongBase) };
    const withOverride: GenerationDocSpecV4 = { ...spec, structure: { ...spec.structure, override: active } };
    await begin(h, [withOverride]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 10);
    expect(h.last('error').code).toBe('REQUEST_INVALID');
    expect(h.all('snapshot-published').length).toBe(0);
  });

  it('a wrong expectedCandidates produces a terminal EXTRACTION_MISMATCH, not a byte miss', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far');
    await begin(h, [{ ...spec, extraction: { ...spec.extraction, expectedCandidates: 'deadbeef' } }]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 10);
    expect(h.last('error').code).toBe('EXTRACTION_MISMATCH');
    expect(h.all('snapshot-published').length).toBe(0);
  });

  it('two same-generation ingests with different bytes cannot change the document identity in place', async () => {
    const h = harness();
    // No asserted text identity: the FIRST accepted bytes freeze the meaning.
    const recipes = await defaultExtractionRecipes();
    const spec: GenerationDocSpecV4 = {
      doc: 'a', language: 'en',
      source: { byteLength: 16, format: 'txt', availability: 'external' },
      extraction: { recipe: recipes.txt, recipeHash: await hashExtractionRecipe(recipes.txt) },
      structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: await hashStructureRecipe(DEFAULT_STRUCTURE_RECIPE), override: { kind: 'none' } },
    };
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 10);
    expect(h.last('snapshot-published').readyDocs).toEqual(['a']);
    await coldIngest(h, 'g', 'a', 'a different animal', 11);
    expect(h.last('error').code).toBe('SOURCE_MISMATCH');
  });

  it('re-ingesting the SAME bytes is idempotent (no identity conflict, no double-charge)', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far');
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 10);
    expect(h.last('snapshot-published').readyDocs).toEqual(['a']);
    // Same identity again: accepted idempotently, republished, never an error.
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 11);
    expect(h.all('error').length).toBe(0);
    expect(h.last('snapshot-published').readyDocs).toEqual(['a']);
  });

  it('two byte streams that decode identically (BOM vs no BOM) still conflict on source identity', async () => {
    const h = harness();
    const recipes = await defaultExtractionRecipes();
    const spec: GenerationDocSpecV4 = {
      doc: 'a', language: 'en',
      source: { byteLength: 16, format: 'txt', availability: 'external' },
      extraction: { recipe: recipes.txt, recipeHash: await hashExtractionRecipe(recipes.txt) },
      structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: await hashStructureRecipe(DEFAULT_STRUCTURE_RECIPE), override: { kind: 'none' } },
    };
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 10); // no BOM
    expect(h.last('snapshot-published').readyDocs).toEqual(['a']);
    // Same decoded text, DIFFERENT source bytes (UTF-8 BOM prefix).
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('the wolf ran far')]);
    await h.send({ t: 'ingest', job: 11, generation: 'g', doc: 'a', bytes: withBom.buffer as ArrayBuffer });
    expect(h.last('error').code).toBe('SOURCE_MISMATCH');
  });
});

describe('warm reopen (deep admission across the three stages)', () => {
  async function coldPass(h: Harness, spec: GenerationDocSpecV4, text: string) {
    await begin(h, [spec], 'cold');
    await coldIngest(h, 'cold', spec.doc, text, 10);
    await h.flush(); // let best-effort disposable writes settle
    h.clear();
  }

  it('an exact warm reopen performs NO decode/extract/segment/index/structure work', async () => {
    const h = harness();
    const text = '# Ch\n\nthe wolf ran far';
    const spec = await docSpec('a', text, { format: 'md' });
    await coldPass(h, spec, text);
    await begin(h, [spec], 'warm');
    const ready = h.last('generation-ready');
    expect(ready.readyDocs).toEqual(['a']);
    expect(ready.missing).toEqual([]);
    expect(h.all('progress').length).toBe(0); // pure admission
    expect(h.all('snapshot-published').length).toBe(1);
  });

  it('text + shard present, structure missing → composes structure only (one publish, no index work)', async () => {
    const h = harness();
    const text = '# Ch\n\nthe wolf ran far';
    const spec = await docSpec('a', text, { format: 'md' });
    await coldPass(h, spec, text);
    h.store.hide.structure = true; // evict just the structure
    await begin(h, [spec], 'warm');
    const phases = h.all('progress').map((p) => p.phase);
    expect(phases).not.toContain('decode');
    expect(phases).not.toContain('segment');
    expect(phases).not.toContain('index');
    expect(phases).toContain('structure');
    expect(h.last('generation-ready').readyDocs).toEqual(['a']);
  });

  it('text + structure present, shard missing → rebuilds the shard with no source fetch', async () => {
    const h = harness();
    const text = '# Ch\n\nthe wolf ran far';
    const spec = await docSpec('a', text, { format: 'md' });
    await coldPass(h, spec, text);
    h.store.hide.shard = true; // evict just the shard
    await begin(h, [spec], 'warm');
    const phases = h.all('progress').map((p) => p.phase);
    expect(phases).not.toContain('decode');
    expect(phases).not.toContain('extract');
    expect(phases).toContain('segment');
    expect(phases).toContain('index');
    expect(h.last('generation-ready').readyDocs).toEqual(['a']);
  });

  it('text present, extraction record evicted → deterministically reconstructs candidates (honest extract)', async () => {
    const h = harness();
    const text = '# Ch\n\nthe wolf ran far';
    const spec = await docSpec('a', text, { format: 'md' });
    await coldPass(h, spec, text);
    h.store.hide.extraction = true; // no cached candidate list
    h.store.hide.structure = true; // force a structure rebuild that needs candidates
    await begin(h, [spec], 'warm');
    const phases = h.all('progress').map((p) => p.phase);
    expect(phases).not.toContain('decode'); // no source bytes touched
    expect(phases).toContain('extract'); // candidates reconstructed from text
    expect(phases).toContain('structure');
    expect(h.last('generation-ready').readyDocs).toEqual(['a']);
  });

  it('a cached extraction whose candidate identity contradicts the manifest is a TERMINAL mismatch, not a byte miss', async () => {
    const h = harness();
    const text = '# Ch\n\nthe wolf ran far';
    const spec = await docSpec('a', text, { format: 'md' });
    await coldPass(h, spec, text);
    // Warm reopen asserting the WRONG candidate identity while the cached
    // extraction carries the true one — a stale manifest, not recoverable bytes.
    const stale: GenerationDocSpecV4 = { ...spec, extraction: { ...spec.extraction, expectedCandidates: 'deadbeef' } };
    await begin(h, [stale], 'warm');
    expect(h.last('error').code).toBe('EXTRACTION_MISMATCH');
    // NOT listed as a byte miss (no refetch loop).
    expect(h.last('generation-ready').missing.find((m) => m.doc === 'a')).toBeUndefined();
  });
});

describe('persisted source re-extraction', () => {
  it('re-extracts a persisted source when no text is cached (no network fetch)', async () => {
    const h = harness();
    const text = 'the wolf ran far over the hill';
    const bytes = utf8(text);
    const sourceHash = await hashSourceBytes(bytes);
    await h.userStore.putSource({ schema: 'texttrends/source/1', hash: sourceHash, byteLength: bytes.length, bytes: bytes.buffer as ArrayBuffer });
    const spec = await docSpec('a', text, { availability: 'persisted' });
    await begin(h, [spec], 'warm');
    const ready = h.last('generation-ready');
    expect(ready.readyDocs).toEqual(['a']);
    expect(ready.missing).toEqual([]);
    const phases = h.all('progress').map((p) => p.phase);
    expect(phases).toEqual(['decode', 'extract', 'segment', 'index', 'structure', 'compose']);
  });

  it('a SAME-LENGTH byte mutation of the persisted copy is classified source-corrupt, not rehydrate-failed', async () => {
    const h = harness();
    const text = 'the wolf ran far over the hill';
    const bytes = utf8(text);
    const sourceHash = await hashSourceBytes(bytes);
    // Store bytes of the RIGHT length under the RIGHT key that do not hash to
    // it — the envelope check (schema/length) passes; the warm path's
    // PRE-EXTRACTION content-hash authentication catches it. That is a
    // DAMAGED DURABLE COPY needing repair.
    const mutated = utf8('the wolf ran far over the hilL');
    await h.userStore.putSource({ schema: 'texttrends/source/1', hash: sourceHash, byteLength: mutated.length, bytes: mutated.buffer as ArrayBuffer });
    const spec = await docSpec('a', text, { availability: 'persisted' });
    await begin(h, [spec], 'warm');
    const ready = h.last('generation-ready');
    expect(ready.missing).toEqual([{ doc: 'a', need: 'source-bytes', reason: 'source-corrupt' }]);
    // Not an EXTRACTION_MISMATCH terminal error, and no cache-vocabulary warning.
    expect(h.all('error').some((e) => e.code === 'EXTRACTION_MISMATCH')).toBe(false);
    expect(h.all('warning').some((w) => w.code === 'CACHE_CORRUPT')).toBe(false);
  });

  it('a same-length mutation that is UNDECODABLE is still source-corrupt — authentication precedes extraction', async () => {
    const h = harness();
    const text = 'the wolf ran far over the hill';
    const bytes = utf8(text);
    const sourceHash = await hashSourceBytes(bytes);
    // Same length, right key, but the bytes begin with a UTF-8 BOM followed by
    // a malformed sequence — decoding would FAIL, so a post-extraction hash
    // check could never run (track-S review mutation). The pre-extraction
    // authentication must classify it as a damaged durable copy regardless.
    const mutated = new Uint8Array(bytes.length);
    mutated.set([0xef, 0xbb, 0xbf, 0xff, 0xfe, 0x80], 0);
    await h.userStore.putSource({ schema: 'texttrends/source/1', hash: sourceHash, byteLength: mutated.length, bytes: mutated.buffer as ArrayBuffer });
    const spec = await docSpec('a', text, { availability: 'persisted' });
    await begin(h, [spec], 'warm');
    const ready = h.last('generation-ready');
    expect(ready.missing).toEqual([{ doc: 'a', need: 'source-bytes', reason: 'source-corrupt' }]);
  });

  it('a corrupt persisted source is reported and RETAINED (never auto-deleted)', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far', { availability: 'persisted' });
    const corruptStore: UserDataStore = {
      getProject: () => Promise.resolve({ kind: 'miss' }),
      putProject: () => Promise.reject(new Error('n/a')),
      getSource: () => Promise.resolve({ kind: 'corrupt', reason: 'bytes do not match' }),
      putSource: () => Promise.resolve(),
      close: () => undefined,
    };
    h.setUserData(() => Promise.resolve({ kind: 'ok', store: corruptStore }));
    await begin(h, [spec], 'warm');
    const ready = h.last('generation-ready');
    // Retention (never auto-delete the user's only durable copy) is enforced by
    // the type system now: UserDataStore has no delete operation at all.
    expect(ready.missing).toEqual([{ doc: 'a', need: 'source-bytes', reason: 'source-corrupt' }]);
    // Durable damage travels ONLY on the warm-miss reason (class-1 repair),
    // never through the artifact-CACHE warning vocabulary (pass-2 Track S2).
    expect(h.all('warning').some((w) => w.code === 'CACHE_CORRUPT')).toBe(false);
  });
});

describe('supersession and the commit gate', () => {
  it('a superseded warm claim cannot warn, publish, or delete; the live ingest wins', async () => {
    const h = harness();
    const text = 'the wolf ran far';
    const spec = await docSpec('a', text);
    // Seed the cache with verified text only (cold pass, then evict shard so
    // warm resolution must read the shard — the point we interleave an ingest).
    await begin(h, [spec], 'cold');
    await coldIngest(h, 'cold', 'a', text, 10);
    await h.flush();
    h.clear();
    // On the warm generation's shard read, deliver a live ingest for the same
    // doc BEFORE the read returns — it bumps the doc epoch and supersedes.
    h.store.hide.shard = true;
    h.store.onShardRead = async () => {
      await h.send({ t: 'ingest', job: 30, generation: 'warm', doc: 'a', bytes: buf(text) });
    };
    await begin(h, [spec], 'warm');
    await h.flush();
    // Exactly one publication — the ingest's. The superseded warm claim did not
    // double-publish or emit a stale error.
    expect(h.all('snapshot-published').length).toBe(1);
    expect(h.last('generation-ready').readyDocs).toEqual(['a']);
    expect(h.all('error').length).toBe(0);
  });

  it('commitDocuments persists ONLY the committed subset when a batched doc is superseded before it commits', async () => {
    const h = harness();
    const ta = 'the wolf ran far';
    const tb = 'a wolf slept nearby';
    const a = await docSpec('a', ta);
    const b = await docSpec('b', tb);
    // Cold-populate both so the warm reopen admits both as exact CHEAP hits,
    // which the loop collects into one batch and commits AFTER the loop.
    await begin(h, [a, b], 'cold');
    await coldIngest(h, 'cold', 'a', ta, 10);
    await coldIngest(h, 'cold', 'b', tb, 11);
    await h.flush();
    h.clear();
    h.store.writes = { text: 0, shard: 0, structure: 0, extraction: 0 };
    h.store.resetReads(); // count text reads within the WARM generation only
    // 'a' is admitted and added to the batch during warm read #1; on warm read
    // #2 (for 'b'), a live ingest for 'a' supersedes the batched warm claim.
    // The post-loop batch commit must DROP 'a' (stale) and persist only 'b'.
    let hookFired = false;
    h.store.onTextRead = async (n) => {
      if (n === 2) { hookFired = true; await h.send({ t: 'ingest', job: 30, generation: 'warm', doc: 'a', bytes: buf(ta) }); }
    };
    await begin(h, [a, b], 'warm');
    await h.flush();
    expect(hookFired).toBe(true); // the supersession actually interleaved
    expect([...h.last('generation-ready').readyDocs].sort()).toEqual(['a', 'b']);
    // 'a' was written once — by the live ingest, NOT again by the batch that
    // dropped it. Old (write-all-prepared) behavior would write 'a' twice, so
    // the total structure writes would be 3, not 2.
    expect(h.store.writes.structure).toBe(2);
    expect(h.store.writes.text).toBe(2);
  });

  it('generation-ready.missing excludes a document accepted in-flight by a concurrent ingest', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far');
    // A concurrent ingest lands DURING the warm probe's text read for the same
    // doc: it claims the doc (bumping the epoch) and commits before the barrier.
    h.store.onTextRead = async (n) => {
      if (n === 1) await h.send({ t: 'ingest', job: 10, generation: 'g', doc: 'a', bytes: buf('the wolf ran far') });
    };
    await begin(h, [spec]);
    const ready = h.last('generation-ready');
    // The doc is READY, not a byte miss — the warm claim was superseded, and
    // the accepted-in-flight document is excluded from `missing`.
    expect(ready.missing.find((m) => m.doc === 'a')).toBeUndefined();
    expect(ready.readyDocs).toContain('a');
    expect(h.all('snapshot-published').length).toBe(1);
  });
});

describe('structure query snapshot binding', () => {
  it('a structure query bound to a superseded snapshot never emits a stale result', async () => {
    const h = harness();
    const a = await docSpec('a', 'the wolf ran far');
    const b = await docSpec('b', 'a wolf slept');
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 10);
    const firstSnap = h.last('snapshot-published').snapshot;
    await coldIngest(h, 'g', 'b', 'a wolf slept', 11); // supersedes the snapshot
    // A structure query against the OLD snapshot must be refused.
    await h.send({ t: 'query', job: 20, snapshot: firstSnap, query: { op: 'structure', request: { doc: 'a' } } });
    expect(h.last('error').code).toBe('SNAPSHOT_UNKNOWN');
  });
});

describe('authoring context + line excerpt queries (8b)', () => {
  const MD = '# Chapter I\n\nthe wolf ran far\n\n# Chapter II\n\na wolf slept';

  it('edit-context echoes base identities + effective override and carries the detected baseline and current rows', async () => {
    const h = harness();
    const spec = await docSpec('a', MD, { format: 'md' });
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', MD, 10);
    const published = h.last('snapshot-published');
    await h.send({ t: 'query', job: 30, snapshot: published.snapshot, query: { op: 'structure-edit-context', request: { doc: 'a' } } });
    const result = h.last('result');
    expect(result.data.op).toBe('structure-edit-context');
    if (result.data.op === 'structure-edit-context') {
      const ctx = result.data.context;
      expect(ctx.doc).toBe('a');
      expect(ctx.base.candidates).toBe(spec.extraction.expectedCandidates);
      expect(ctx.base.baseRecipe).toBe(spec.structure.recipeHash);
      expect(ctx.base.text).toBeTruthy();
      expect(ctx.override).toBeTruthy();
      // Detected baseline: root + two detected chapters, keyed by LINEAGE key.
      expect(ctx.detected.length).toBe(3);
      expect(ctx.detected[0]!.key).toBe('root');
      expect(ctx.detected.some((d) => d.key.startsWith('sec-'))).toBe(true);
      expect(ctx.detected.some((d) => d.title?.includes('Chapter'))).toBe(true);
      // Current composed rows: lineage key + bound section id + token range.
      expect(ctx.current.length).toBe(3);
      expect(ctx.current[0]!.key).toBe('root');
      expect(ctx.current[0]!.section.id).toBeTruthy();
      expect(ctx.current[0]!.section.doc).toBe('a');
      expect(ctx.current.every((r) => r.tokens.end >= r.tokens.start)).toBe(true);
    }
  });

  it('edit-context bound to a superseded snapshot is refused', async () => {
    const h = harness();
    const a = await docSpec('a', MD, { format: 'md' });
    const b = await docSpec('b', 'a wolf slept');
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', MD, 10);
    const firstSnap = h.last('snapshot-published').snapshot;
    await coldIngest(h, 'g', 'b', 'a wolf slept', 11); // supersedes
    await h.send({ t: 'query', job: 31, snapshot: firstSnap, query: { op: 'structure-edit-context', request: { doc: 'a' } } });
    expect(h.last('error').code).toBe('SNAPSHOT_UNKNOWN');
  });

  it('line-excerpt returns the exact source line untruncated; an out-of-range anchor is REQUEST_INVALID', async () => {
    const h = harness();
    const text = 'the wolf ran far';
    const spec = await docSpec('a', text);
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', text, 10);
    const published = h.last('snapshot-published');
    await h.send({ t: 'query', job: 32, snapshot: published.snapshot, query: { op: 'line-excerpt', request: { doc: 'a', anchor: 4, maxChars: 100 } } });
    const result = h.last('result');
    expect(result.data.op).toBe('line-excerpt');
    if (result.data.op === 'line-excerpt') {
      expect(result.data.excerpt.doc).toBe('a');
      expect(result.data.excerpt.text).toBe('the wolf ran far');
      expect(result.data.excerpt.truncatedStart).toBe(false);
      expect(result.data.excerpt.truncatedEnd).toBe(false);
    }
    await h.send({ t: 'query', job: 33, snapshot: published.snapshot, query: { op: 'line-excerpt', request: { doc: 'a', anchor: 9999, maxChars: 100 } } });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
  });

  it('a structurally-invalid active override maps to REQUEST_INVALID (not INTERNAL)', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far');
    // Base identities MATCH (so resolveOverride admits it), but the replace
    // targets a section that does not exist → StructureError in composeStructure.
    const bad: StructureOverrideV1 = {
      schema: 'texttrends/structure-override/1',
      text: spec.extraction.expectedText!,
      candidates: spec.extraction.expectedCandidates!,
      baseRecipe: spec.structure.recipeHash,
      changes: [{ op: 'replace', target: 'sec-404', value: { parent: 'root', level: 1, chars: { start: 1, end: 2 } } }],
    };
    const withOverride = { ...spec, structure: { ...spec.structure, override: { kind: 'active', value: bad, hash: await hashStructureOverride(bad) } as const } };
    await begin(h, [withOverride]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 10);
    expect(h.last('error').code).toBe('REQUEST_INVALID');
    expect(h.all('snapshot-published').length).toBe(0);
  });

  it('an over-cap composed section table maps to CAP_EXCEEDED (not INTERNAL)', async () => {
    const h = harness();
    const text = ' '.repeat(5000);
    const spec = await docSpec('a', text);
    // 2048 disjoint adds + the root = 2049 sections, one over the 2048 cap.
    const changes = Array.from({ length: 2048 }, (_, i) => ({
      op: 'add' as const,
      key: `u${i}`,
      value: { parent: 'root', level: 1, chars: { start: i * 2, end: i * 2 + 1 } },
    }));
    const over: StructureOverrideV1 = {
      schema: 'texttrends/structure-override/1',
      text: spec.extraction.expectedText!,
      candidates: spec.extraction.expectedCandidates!,
      baseRecipe: spec.structure.recipeHash,
      changes,
    };
    const withOverride = { ...spec, structure: { ...spec.structure, override: { kind: 'active', value: over, hash: await hashStructureOverride(over) } as const } };
    await begin(h, [withOverride]);
    await coldIngest(h, 'g', 'a', text, 10);
    expect(h.last('error').code).toBe('CAP_EXCEEDED');
    expect(h.all('snapshot-published').length).toBe(0);
  });
});

describe('section-id binding cache (Phase D workstream D4)', () => {
  const MD = '# Chapter I\n\nthe wolf ran far\n\n# Chapter II\n\na wolf slept';
  const MD_SECTIONS = 3; // root + two detected chapters

  /** The engine internals this suite must reach: the per-generation cache map
   *  and the private binding helper (for inputs the wire cannot carry). */
  interface EngineInternals {
    generation: { sectionIds: Map<string, Map<string, Promise<string>>> } | null;
    cachedSectionId(gen: unknown, doc: string, key: string): Promise<string>;
  }
  const internals = (h: Harness) => h.engine as unknown as EngineInternals;

  /** Intercept ONLY section-id binding digests, recognized by the versioned
   *  method tag in the canonical digest input; every other digest passes
   *  through untouched. `defer` parks each binding until its queued release
   *  fires; `rejectFirst` fails exactly the first binding. */
  function spySectionIdDigests(opts: { defer?: boolean; rejectFirst?: boolean } = {}) {
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    const calls: string[] = [];
    const releases: (() => void)[] = [];
    let rejectArmed = opts.rejectFirst === true;
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(((...args: Parameters<typeof realDigest>) => {
      const input = new TextDecoder().decode(args[1]);
      if (!input.includes('section-id/1')) return realDigest(...args);
      calls.push(input);
      if (rejectArmed) { rejectArmed = false; return Promise.reject(new Error('binding digest failed')); }
      if (!opts.defer) return realDigest(...args);
      return new Promise<ArrayBuffer>((resolve) => { releases.push(() => resolve(realDigest(...args))); });
    }) as typeof crypto.subtle.digest);
    return { calls, releases, restore: () => spy.mockRestore() };
  }

  /** Pump the event loop until `done` (bounded, so a hung engine FAILS the
   *  assertion that follows instead of hanging the suite). */
  async function settle(h: Harness, done: () => boolean, turns = 100) {
    for (let i = 0; i < turns && !done(); i++) await h.flush();
  }

  function structureRows(h: Harness, job: number) {
    const msg = h.all('result').find((m) => m.job === job);
    if (!msg || msg.data.op !== 'structure') throw new Error(`no structure result for job ${job}`);
    return msg.data.structure.rows;
  }
  function currentRows(h: Harness, job: number) {
    const msg = h.all('result').find((m) => m.job === job);
    if (!msg || msg.data.op !== 'structure-edit-context') throw new Error(`no edit-context result for job ${job}`);
    return msg.data.context.current;
  }

  async function publishMd(h: Harness, docs: string[], generation = 'g'): Promise<string> {
    const specs = await Promise.all(docs.map((d) => docSpec(d, MD, { format: 'md' })));
    await begin(h, specs, generation);
    for (let i = 0; i < docs.length; i++) await coldIngest(h, generation, docs[i]!, MD, 10 + i);
    return h.last('snapshot-published').snapshot;
  }

  it("keys containing '\\0' stay distinct — the nested-map shape admits no joined-string collision", async () => {
    const h = harness();
    await begin(h, [await docSpec('a', 'the wolf ran far')]);
    const engine = internals(h);
    const gen = engine.generation!;
    // Joined with '\0' (or any single delimiter) these two pairs collide:
    // 'a\0b' + 'c' and 'a' + 'b\0c' both flatten to 'a\0b\0c'.
    const id1 = await engine.cachedSectionId(gen, 'a\u0000b', 'c');
    const id2 = await engine.cachedSectionId(gen, 'a', 'b\u0000c');
    expect(id1).not.toBe(id2);
    expect(id1).toBe(await bindSectionId('a\u0000b', 'c'));
    expect(id2).toBe(await bindSectionId('a', 'b\u0000c'));
    // The cache keeps them under distinct outer (document) keys.
    expect(gen.sectionIds.get('a\u0000b')?.has('c')).toBe(true);
    expect(gen.sectionIds.get('a')?.has('b\u0000c')).toBe(true);
  });

  it('the same lineage key in two documents binds to separate ids (no wrong-document reuse)', async () => {
    const h = harness();
    const snap = await publishMd(h, ['a', 'b']); // identical text → identical lineage keys
    await h.send({ t: 'query', job: 20, snapshot: snap, query: { op: 'structure', request: { doc: 'a' } } });
    await h.send({ t: 'query', job: 21, snapshot: snap, query: { op: 'structure', request: { doc: 'b' } } });
    const rowsA = structureRows(h, 20);
    const rowsB = structureRows(h, 21);
    expect(rowsA.length).toBe(MD_SECTIONS);
    expect(rowsB.length).toBe(MD_SECTIONS);
    for (let i = 0; i < rowsA.length; i++) {
      expect(rowsA[i]!.section.doc).toBe('a');
      expect(rowsB[i]!.section.doc).toBe('b');
      expect(rowsA[i]!.section.id).not.toBe(rowsB[i]!.section.id); // same key, different doc
    }
  });

  it('cross-snapshot reuse: the same (doc, key) across a supersession digests ONCE and keeps its id', async () => {
    const h = harness();
    const a = await docSpec('a', MD, { format: 'md' });
    const b = await docSpec('b', 'a wolf slept');
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', MD, 10);
    const snap1 = h.last('snapshot-published').snapshot;
    const s = spySectionIdDigests();
    await h.send({ t: 'query', job: 20, snapshot: snap1, query: { op: 'structure', request: { doc: 'a' } } });
    expect(s.calls.length).toBe(MD_SECTIONS); // cold: one digest per section
    await coldIngest(h, 'g', 'b', 'a wolf slept', 11); // supersedes the snapshot, same generation
    const snap2 = h.last('snapshot-published').snapshot;
    expect(snap2).not.toBe(snap1);
    await h.send({ t: 'query', job: 21, snapshot: snap2, query: { op: 'structure', request: { doc: 'a' } } });
    s.restore();
    expect(s.calls.length).toBe(MD_SECTIONS); // warm: ZERO new binding digests
    expect(structureRows(h, 21)).toEqual(structureRows(h, 20)); // ids stable across snapshots
  });

  it('concurrent structure + edit-context queries share ONE pending digest per key', async () => {
    const h = harness();
    const snap = await publishMd(h, ['a']);
    const s = spySectionIdDigests({ defer: true });
    const p1 = h.send({ t: 'query', job: 20, snapshot: snap, query: { op: 'structure', request: { doc: 'a' } } });
    const p2 = h.send({ t: 'query', job: 21, snapshot: snap, query: { op: 'structure-edit-context', request: { doc: 'a' } } });
    // Let BOTH queries reach their binding phase while every digest is parked.
    await settle(h, () => s.releases.length >= MD_SECTIONS);
    await settle(h, () => false, 10); // extra turns: a non-deduplicating engine would digest again
    expect(s.calls.length).toBe(MD_SECTIONS); // one pending digest per key, shared by both queries
    s.releases.forEach((r) => r());
    await Promise.all([p1, p2]);
    s.restore();
    const rows = structureRows(h, 20);
    const current = currentRows(h, 21);
    expect(current.length).toBe(rows.length);
    for (let i = 0; i < rows.length; i++) expect(current[i]!.section).toEqual(rows[i]!.section);
  });

  it('a rejected binding digest is evicted — a retry recomputes ONLY the failed key and succeeds', async () => {
    const h = harness();
    const snap = await publishMd(h, ['a']);
    const s = spySectionIdDigests({ rejectFirst: true });
    await h.send({ t: 'query', job: 20, snapshot: snap, query: { op: 'structure', request: { doc: 'a' } } });
    expect(h.all('result').length).toBe(0);
    expect(h.last('error').code).toBe('INTERNAL');
    expect(s.calls.length).toBe(MD_SECTIONS); // all were launched; one rejected
    await h.send({ t: 'query', job: 21, snapshot: snap, query: { op: 'structure', request: { doc: 'a' } } });
    s.restore();
    // Exactly ONE recomputation: the failed entry was evicted, the survivors reused.
    expect(s.calls.length).toBe(MD_SECTIONS + 1);
    const rows = structureRows(h, 21);
    expect(rows.length).toBe(MD_SECTIONS);
    expect(rows[0]!.section.id).toBe(await bindSectionId('a', 'root'));
  });

  it('eviction compares promise identity — a stale rejection cannot evict a concurrent replacement', async () => {
    const h = harness();
    await begin(h, [await docSpec('a', 'the wolf ran far')]);
    const engine = internals(h);
    const gen = engine.generation!;
    // The FIRST binding digest is held open so its rejection lands LATE —
    // after the cache entry has already been dropped and re-created.
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let rejectHeld: ((e: Error) => void) | null = null;
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(((...args: Parameters<typeof realDigest>) => {
      if (rejectHeld === null && new TextDecoder().decode(args[1]).includes('section-id/1')) {
        return new Promise<ArrayBuffer>((_resolve, reject) => { rejectHeld = reject; });
      }
      return realDigest(...args);
    }) as typeof crypto.subtle.digest);
    const stale = engine.cachedSectionId(gen, 'a', 'root');
    gen.sectionIds.get('a')!.delete('root'); // the entry is replaced while the digest is in flight
    const fresh = engine.cachedSectionId(gen, 'a', 'root');
    expect(fresh).not.toBe(stale);
    rejectHeld!(new Error('late failure'));
    await expect(stale).rejects.toThrow('late failure');
    spy.mockRestore();
    // The stale rejection must NOT have evicted the replacement.
    expect(gen.sectionIds.get('a')!.get('root')).toBe(fresh);
    expect(await fresh).toBe(await bindSectionId('a', 'root'));
  });

  it('replacing the generation drops the cache; a late old-generation completion cannot answer the new one', async () => {
    const h = harness();
    const spec = await docSpec('a', MD, { format: 'md' });
    await begin(h, [spec], 'g1');
    await coldIngest(h, 'g1', 'a', MD, 10);
    const snap1 = h.last('snapshot-published').snapshot;
    const engine = internals(h);
    const gen1 = engine.generation!;
    const s = spySectionIdDigests({ defer: true });
    // Park a g1 query mid-binding, then replace the generation under it.
    const p1 = h.send({ t: 'query', job: 20, snapshot: snap1, query: { op: 'structure', request: { doc: 'a' } } });
    await settle(h, () => s.releases.length >= MD_SECTIONS);
    expect(s.calls.length).toBe(MD_SECTIONS);
    await begin(h, [spec], 'g2'); // warm reopen from the cold pass's cache writes
    const gen2 = engine.generation!;
    expect(gen2).not.toBe(gen1);
    expect(gen2.sectionIds.size).toBe(0); // the new generation starts EMPTY
    const snap2 = h.last('snapshot-published').snapshot;
    // Release the old generation's digests: the parked query dies at its gate,
    // and the late completions land ONLY in the dead generation's map.
    const released = s.releases.length;
    s.releases.forEach((r) => r());
    await p1;
    expect(h.all('result').length).toBe(0);
    expect(gen2.sectionIds.size).toBe(0);
    expect(gen1.sectionIds.get('a')!.size).toBe(MD_SECTIONS);
    // The new generation cannot be answered from the old map: it re-digests.
    const p2 = h.send({ t: 'query', job: 21, snapshot: snap2, query: { op: 'structure', request: { doc: 'a' } } });
    await settle(h, () => s.calls.length >= MD_SECTIONS * 2);
    expect(s.calls.length).toBe(MD_SECTIONS * 2);
    s.releases.slice(released).forEach((r) => r());
    await p2;
    s.restore();
    expect(structureRows(h, 21).length).toBe(MD_SECTIONS);
  });

  it('out-of-order digest resolution preserves row order and parent translation', async () => {
    // Reference rows from an undisturbed engine (binding is deterministic).
    const ref = harness();
    const refSnap = await publishMd(ref, ['a']);
    await ref.send({ t: 'query', job: 20, snapshot: refSnap, query: { op: 'structure', request: { doc: 'a' } } });
    const expected = structureRows(ref, 20);
    expect(expected.length).toBe(MD_SECTIONS);
    expect(expected[1]!.section.parent).toBe(expected[0]!.section.id); // chapters hang off root

    const h = harness();
    const snap = await publishMd(h, ['a']);
    const s = spySectionIdDigests({ defer: true });
    const p = h.send({ t: 'query', job: 20, snapshot: snap, query: { op: 'structure', request: { doc: 'a' } } });
    await settle(h, () => s.releases.length >= MD_SECTIONS);
    expect(s.releases.length).toBe(MD_SECTIONS);
    [...s.releases].reverse().forEach((r) => r()); // resolve LAST-first (root resolves last)
    await p;
    s.restore();
    expect(structureRows(h, 20)).toEqual(expected); // order + parent ids + tokens intact
  });

  it('all missing bindings START before the first digest resolves (parallel launch)', async () => {
    const h = harness();
    const snap = await publishMd(h, ['a']);
    const s = spySectionIdDigests({ defer: true });
    const p = h.send({ t: 'query', job: 20, snapshot: snap, query: { op: 'structure', request: { doc: 'a' } } });
    await settle(h, () => s.calls.length >= MD_SECTIONS);
    // Every binding digest has STARTED while NONE has resolved — a sequential
    // await-per-row implementation would have started only the first.
    expect(s.calls.length).toBe(MD_SECTIONS);
    expect(h.all('result').length).toBe(0);
    s.releases.forEach((r) => r());
    await p;
    s.restore();
    expect(structureRows(h, 20).length).toBe(MD_SECTIONS);
  });
});

describe('cancellation', () => {
  it('a cancel queued at a checkpoint stops a cold ingest before publication', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far');
    await begin(h, [spec]);
    h.clear();
    h.manual();
    const ingestPromise = h.send({ t: 'ingest', job: 10, generation: 'g', doc: 'a', bytes: buf('the wolf ran far') });
    await h.send({ t: 'cancel', job: 10 });
    for (let i = 0; i < 20; i++) h.releaseYield();
    await ingestPromise;
    expect(h.all('cancelled').some((m) => m.job === 10)).toBe(true);
    expect(h.all('snapshot-published').length).toBe(0);
  });
});

describe('user-data lane', () => {
  it('source-persist verifies the claimed hash and acknowledges only a durable write', async () => {
    const h = harness();
    const bytes = buf('durable source bytes');
    const sourceHash = await hashSourceBytes(new Uint8Array(bytes));
    await h.send({ t: 'source-persist', job: 1, sourceHash, bytes });
    expect(h.last('source-persisted').sourceHash).toBe(sourceHash);
    expect((await h.userStore.getSource(sourceHash)).kind).toBe('hit');
  });

  it('source-persist rejects a claimed-hash mismatch with SOURCE_MISMATCH and writes nothing', async () => {
    const h = harness();
    await h.send({ t: 'source-persist', job: 1, sourceHash: 'not-the-hash', bytes: buf('bytes') });
    expect(h.last('user-data-error').code).toBe('SOURCE_MISMATCH');
  });

  it('cancellation before the durable write prevents it', async () => {
    const h = harness();
    const bytes = buf('durable source bytes');
    const sourceHash = await hashSourceBytes(new Uint8Array(bytes));
    // The cancel is delivered while the handler is still hashing/awaiting the
    // provider — the checkpoint before the durable write catches it.
    const persistPromise = h.send({ t: 'source-persist', job: 1, sourceHash, bytes });
    await h.send({ t: 'cancel', job: 1 });
    await persistPromise;
    expect(h.all('cancelled').some((m) => m.job === 1)).toBe(true);
    expect((await h.userStore.getSource(sourceHash)).kind).toBe('miss'); // never written
  });

  it('project-load deep-validates the durable manifest and maps a corrupt record to DATA_CORRUPT', async () => {
    const h = harness();
    // Seed a structurally-plausible but invalid manifest (bad hashes).
    await h.userStore.putProject({ schema: 'texttrends/project/1', id: 'p', revision: 1, order: [], docs: [], indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: 'wrong' } as never, 0);
    await h.send({ t: 'project-load', job: 1, project: 'p' });
    expect(h.last('user-data-error').code).toBe('DATA_CORRUPT');
  });

  it('project-save deep-validates BEFORE any durable write: invalid → REQUEST_INVALID, putProject never called', async () => {
    const h = harness();
    // The worker is the SOLE save-admission authority (the session posts
    // without a main-thread deep pass), so this gate is the only one: an
    // invalid manifest must be refused with a correlated typed error, no ack,
    // and — critically — no durable write attempt at all.
    let puts = 0;
    const store: UserDataStore = {
      getProject: () => Promise.resolve({ kind: 'miss' }),
      putProject: () => { puts++; return Promise.reject(new Error('must never be reached')); },
      getSource: () => Promise.resolve({ kind: 'miss' }),
      putSource: () => Promise.resolve(),
      close: () => undefined,
    };
    h.setUserData(() => Promise.resolve({ kind: 'ok', store }));
    // A manifest that satisfies EVERY downstream check (target id matches,
    // revision === expectedRevision + 1) and fails ONLY deep admission (wrong
    // indexRecipeHash) — so deleting or delaying validateProjectManifest must
    // reach putProject and fail this test (mutation-sensitive by construction).
    await h.send({
      t: 'project-save', job: 9, project: 'p',
      manifest: { schema: 'texttrends/project/1', id: 'p', revision: 1, order: [], docs: [], indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: 'wrong' },
      expectedRevision: 0,
    });
    const err = h.last('user-data-error');
    expect(err.code).toBe('REQUEST_INVALID');
    expect(err.job).toBe(9);
    expect(h.all('project-saved').length).toBe(0);
    expect(puts).toBe(0); // validation gated the write, not the other way round
  });

  it('project-load returns project-missing for an absent project', async () => {
    const h = harness();
    await h.send({ t: 'project-load', job: 1, project: 'absent' });
    expect(h.last('project-missing').project).toBe('absent');
  });

  it('a cancel delivered DURING deep manifest validation suppresses project-loaded', async () => {
    const h = harness();
    // A valid manifest so validation SUCCEEDS — the post-validation cancel check
    // (not the earlier post-read check) is what must win here.
    const manifest = {
      schema: 'texttrends/project/1', id: 'p', revision: 1, order: [], docs: [],
      indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: await hashIndexRecipe(DEFAULT_INDEX_RECIPE),
    };
    await h.userStore.putProject(manifest as never, 0);
    // Fire the cancel from INSIDE the first Web Crypto digest — i.e. once
    // validateProjectManifest has begun (past the post-read check) — so the
    // ONLY check that can catch it is the post-validation one.
    let validationEntered = false;
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(((...args: Parameters<typeof realDigest>) => {
      if (!validationEntered) { validationEntered = true; void h.send({ t: 'cancel', job: 1 }); }
      return realDigest(...args);
    }) as typeof crypto.subtle.digest);
    await h.send({ t: 'project-load', job: 1, project: 'p' });
    spy.mockRestore();
    expect(validationEntered).toBe(true); // validation was actually reached
    // The result is suppressed; a cancel acknowledgement is emitted instead.
    expect(h.all('project-loaded').length).toBe(0);
    expect(h.all('cancelled').some((m) => m.job === 1)).toBe(true);
  });

  it('a pre-write read failure on a CANCELLED job surfaces as cancelled, not a storage error', async () => {
    const h = harness();
    // getProject rejects (a cancellable pre-write await); the job is cancelled
    // before it settles, so cancellation must win over the storage error.
    const store: UserDataStore = {
      getProject: () => {
        void Promise.resolve().then(() => h.send({ t: 'cancel', job: 1 }));
        return Promise.reject(new UserDataError('PERSISTENCE_UNAVAILABLE', 'read blew up'));
      },
      putProject: () => Promise.reject(new Error('n/a')),
      getSource: () => Promise.resolve({ kind: 'miss' }),
      putSource: () => Promise.resolve(),
      close: () => undefined,
    };
    h.setUserData(() => Promise.resolve({ kind: 'ok', store }));
    await h.send({ t: 'project-load', job: 1, project: 'p' });
    expect(h.all('cancelled').some((m) => m.job === 1)).toBe(true);
    expect(h.all('user-data-error').length).toBe(0);
  });

  it('durable unavailability yields a precise user-data error while analysis queries keep working', async () => {
    const h = harness();
    h.setUserData(() => Promise.resolve({ kind: 'unavailable', message: 'no durable storage' }));
    await h.send({ t: 'project-load', job: 1, project: 'p' });
    expect(h.last('user-data-error').code).toBe('PERSISTENCE_UNAVAILABLE');
    // Analysis is entirely independent of the durable lane.
    const spec = await docSpec('a', 'the wolf ran far');
    await begin(h, [spec], 'g2');
    await coldIngest(h, 'g2', 'a', 'the wolf ran far', 10);
    const snap = h.last('snapshot-published').snapshot;
    await h.send({ t: 'query', job: 20, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 4 } } });
    const result = h.last('result');
    expect(result.data.op).toBe('trend');
  });
});

// ---------------------------------------------------------------------------
// Legacy engine invariants translated from the retired v3 suite (6c). The 6b
// tests own the new pipeline; these preserve query/protocol/locale/corruption/
// transfer/late-cancel coverage the v3 engine.test.ts proved, in v4 shapes.
// ---------------------------------------------------------------------------

/** A spec with NO expected identities — a first cold ingest that asserts
 *  nothing, for decode-path and freeze tests. */
async function freshTxtSpec(doc: string, byteLength: number): Promise<GenerationDocSpecV4> {
  const { txt } = await defaultExtractionRecipes();
  return {
    doc, language: 'en',
    source: { byteLength, format: 'txt', availability: 'external' },
    extraction: { recipe: txt, recipeHash: await hashExtractionRecipe(txt) },
    structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: await hashStructureRecipe(DEFAULT_STRUCTURE_RECIPE), override: { kind: 'none' } },
  };
}

const innerShards = (h: Harness) =>
  (h.store.inner as unknown as { shards: Map<string, { lengths8: Uint8Array; startsUtf16: Uint32Array }> }).shards;

describe('protocol narrowing and dispatch (v4)', () => {
  it('rejects a protocol version mismatch with PROTOCOL_VERSION', async () => {
    const h = harness();
    await h.engine.handle({ v: 99, t: 'cancel', job: 1 });
    expect(h.last('error').code).toBe('PROTOCOL_VERSION');
  });

  it('a malformed envelope and an unknown message type are PARSE_FAILED at the wire boundary', async () => {
    const h = harness();
    await h.engine.handle(null);
    expect(h.last('error').code).toBe('PARSE_FAILED');
    await h.engine.handle({ v: PROTOCOL_VERSION_V4, t: 'nonsense', job: 1 });
    expect(h.last('error').code).toBe('PARSE_FAILED'); // parseToWorkerV4 rejects the whole message
    await h.engine.handle({ v: PROTOCOL_VERSION_V4, t: 'begin-generation', job: 1, generation: 'g', docs: null, indexRecipe: DEFAULT_INDEX_RECIPE });
    expect(h.last('error').code).toBe('PARSE_FAILED');
  });

  it('malformed query payloads are rejected at the wire (PARSE_FAILED); kernel-invalid ones map by type', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran');
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', 'the wolf ran', 10);
    const snap = h.last('snapshot-published').snapshot;
    // Wire-level malformation: the whole message fails narrowing → PARSE_FAILED.
    for (const bad of [
      { op: 'trend', selection: { docs: ['a'] }, group: null, request: { coordinate: 'document-relative', binsPerDoc: 1 } },
      { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: null },
      { op: 'trend', selection: { docs: ['a'] }, group: { id: 'g', members: [null], countOverlaps: false }, request: { coordinate: 'document-relative', binsPerDoc: 1 } },
      { op: 'trend', selection: { docs: ['a'] }, group: { ...wolfGroup, countOverlaps: 'false' }, request: { coordinate: 'document-relative', binsPerDoc: 1 } },
      { op: 'bogus' },
      null,
    ]) {
      await h.send({ t: 'query', job: 20, snapshot: snap, query: bad });
      expect(h.last('error').code, JSON.stringify(bad)).toBe('PARSE_FAILED');
    }
    // Narrowing-valid but KERNEL-invalid: mapped deterministically BY TYPE. An
    // empty-phrase member whose id is 'cap' must be REQUEST_INVALID, never
    // CAP_EXCEEDED (message-text independence).
    await h.send({
      t: 'query', job: 21, snapshot: snap,
      query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 0 } },
    });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
    await h.send({
      t: 'query', job: 22, snapshot: snap,
      query: { op: 'trend', selection: { docs: ['a'] }, group: { id: 'g', members: [{ id: 'cap', kind: 'phrase', surfaces: [], match: FOLD, crossSentence: false }], countOverlaps: false }, request: { coordinate: 'document-relative', binsPerDoc: 1 } },
    });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
  });
});

describe('locale identity (v4)', () => {
  it('a fixed-locale recipe overrides document language, and the warm key does not alias across locales', async () => {
    const fixed = { ...DEFAULT_INDEX_RECIPE, locale: { mode: 'fixed' as const, value: 'en' } };
    const h = harness();
    const a = await docSpec('a', 'the wolf ran');
    // A fixed 'en' recipe on a fr-declared doc must build without error.
    await h.send({ t: 'begin-generation', job: 1, generation: 'g', docs: [{ ...a, language: 'fr' }], indexRecipe: fixed });
    await coldIngest(h, 'g', 'a', 'the wolf ran', 10);
    expect(h.all('error')).toEqual([]);
    expect(h.last('snapshot-published').readyDocs).toEqual(['a']);
    // Warm reopen under the SAME fixed recipe is an exact hit (no build work).
    await h.flush();
    h.clear();
    await h.send({ t: 'begin-generation', job: 2, generation: 'g2', docs: [{ ...a, language: 'fr' }], indexRecipe: fixed });
    expect(h.all('progress').length).toBe(0);
    expect(h.last('generation-ready').readyDocs).toEqual(['a']);
  });

  it('the same text under two locales does NOT alias the shard cache (full segmenter fingerprint keys)', async () => {
    const h = harness();
    const en = await docSpec('en-doc', 'the wolf ran');
    const fr = { ...(await docSpec('fr-doc', 'the wolf ran')), language: 'fr' };
    await begin(h, [en, fr]);
    await coldIngest(h, 'g', 'en-doc', 'the wolf ran', 10);
    const before = h.all('progress').length;
    await coldIngest(h, 'g', 'fr-doc', 'the wolf ran', 11);
    const frPhases = h.all('progress').slice(before).map((p) => p.phase);
    // No cross-locale hit: fr must segment/index itself.
    expect(frPhases).toContain('segment');
    expect(frPhases).toContain('index');
  });

  it('document-metadata mode falls back when a document declares no language', async () => {
    const h = harness();
    const a = { ...(await docSpec('a', 'the wolf ran')), language: '' };
    await begin(h, [a]);
    await coldIngest(h, 'g', 'a', 'the wolf ran', 10);
    expect(h.all('error')).toEqual([]);
    expect(h.last('snapshot-published').readyDocs).toEqual(['a']);
  });
});

describe('cache corruption repair (v4)', () => {
  async function coldThenCorrupt(mutate: (shard: { lengths8: Uint8Array; startsUtf16: Uint32Array }) => void, text = 'the wolf ran') {
    const h = harness();
    const spec = await docSpec('a', text);
    await begin(h, [spec], 'g1');
    await coldIngest(h, 'g1', 'a', text, 10);
    await h.flush();
    const [key] = innerShards(h).keys();
    mutate(innerShards(h).get(key!)!);
    h.clear();
    return { h, spec };
  }

  it('same-key STRUCTURAL corruption warns CACHE_CORRUPT and rebuilds', async () => {
    const { h, spec } = await coldThenCorrupt((s) => { s.lengths8[0] = 0; });
    await begin(h, [spec], 'g2');
    expect(h.all('warning').some((w) => w.code === 'CACHE_CORRUPT')).toBe(true);
    const phases = h.all('progress').map((p) => p.phase);
    expect(phases).toContain('segment'); // rebuilt, not silently served
    expect(h.last('generation-ready').readyDocs).toEqual(['a']);
  });

  it('same-key IN-DOMAIN geometry past the text end warns and rebuilds', async () => {
    const { h, spec } = await coldThenCorrupt((s) => { s.startsUtf16[1] = 100; }, 'alpha wolf');
    await begin(h, [spec], 'g2');
    expect(h.all('warning').some((w) => w.code === 'CACHE_CORRUPT')).toBe(true);
    expect(h.all('progress').map((p) => p.phase)).toContain('segment');
    expect(h.last('generation-ready').readyDocs).toEqual(['a']);
  });

  it('a store-reported corrupt envelope is deleted (exact-record repair) and rebuilt', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran');
    await begin(h, [spec], 'g1');
    await coldIngest(h, 'g1', 'a', 'the wolf ran', 10);
    await h.flush();
    h.clear();
    h.store.corruptShardOnce = true;
    const deletesBefore = h.store.shardDeletes;
    await begin(h, [spec], 'g2');
    expect(h.all('warning').some((w) => w.code === 'CACHE_CORRUPT')).toBe(true);
    expect(h.store.shardDeletes).toBeGreaterThan(deletesBefore); // exact-record repair
    expect(h.last('generation-ready').readyDocs).toEqual(['a']);
  });

  it('after a rebuild the corrupt record is overwritten: the next reopen is warm and clean', async () => {
    const { h, spec } = await coldThenCorrupt((s) => { s.lengths8[0] = 0; });
    await begin(h, [spec], 'g2'); // repairs
    await h.flush();
    h.clear();
    await begin(h, [spec], 'g3'); // reopen: must be clean
    expect(h.all('warning').some((w) => w.code === 'CACHE_CORRUPT')).toBe(false);
    expect(h.all('progress').length).toBe(0); // exact warm hit
  });
});

describe('queries and excerpts (v4)', () => {
  async function ready(text = 'the wolf ran far. a wolf slept.') {
    const h = harness();
    const spec = await docSpec('a', text);
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', text, 10);
    return { h, snap: h.last('snapshot-published').snapshot };
  }

  it('answers trend and KWIC against the published snapshot', async () => {
    const { h, snap } = await ready();
    await h.send({ t: 'query', job: 20, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 2 } } });
    const trend = h.last('result');
    expect(trend.data.op).toBe('trend');
    if (trend.data.op === 'trend') expect(Array.from(trend.data.trend.count)).toEqual([1, 1]);
    await h.send({ t: 'query', job: 21, snapshot: snap, query: { op: 'kwic', selection: { docs: ['a'] }, tracks: [{ seriesId: 's', group: wolfGroup }], request: { contextTokens: 1, sort: [{ at: 'pos', dir: 1 }], page: { offset: 0, limit: 10 } } } });
    const kwic = h.last('result');
    expect(kwic.data.op).toBe('kwic');
    if (kwic.data.op === 'kwic') {
      expect(kwic.data.total).toBe(2);
      expect(kwic.data.rows[0]!.nodeText).toBe('wolf');
      expect(kwic.data.rows[0]!.seriesId).toBe('s'); // rows are track-tagged
    }
  });

  it('kwic/2 merges two tracks and orders by proximity to an axis center', async () => {
    const { h, snap } = await ready();
    // The default corpus doc 'a' is 'the wolf runs and the wolf sleeps' (wolf@1, wolf@5).
    // Two tracks over the same term produce two independently-tagged rows per hit;
    // a center near the end orders the later hit first.
    await h.send({ t: 'query', job: 22, snapshot: snap, query: { op: 'kwic', selection: { docs: ['a'] }, tracks: [{ seriesId: 'A', group: wolfGroup }, { seriesId: 'B', group: { ...wolfGroup, id: 'gB' } }], request: { contextTokens: 1, center: { doc: 'a', token: 5 }, sort: [{ at: 'pos', dir: 1 }], page: { offset: 0, limit: 10 } } } });
    const kwic = h.last('result');
    expect(kwic.data.op).toBe('kwic');
    if (kwic.data.op === 'kwic') {
      expect(kwic.data.total).toBe(4); // 2 hits × 2 tracks
      // Nearest to token 5 first (pos 5 before pos 1); both tracks tagged.
      expect(kwic.data.rows.map((r) => [r.pos, r.seriesId])).toEqual([[5, 'A'], [5, 'B'], [1, 'A'], [1, 'B']]);
    }
  });

  // The kwic/2 dispatch adds checkpoints the trend cancellation tests never
  // reach. These tests tie the cancel to the actual PHASE (not a fragile yield
  // ordinal) so deleting the per-track gate or moving the final gate before
  // materialization makes them fail.
  const twoTrackKwic = {
    op: 'kwic' as const,
    selection: { docs: ['a'] },
    tracks: [{ seriesId: 'A', group: wolfGroup }, { seriesId: 'B', group: { ...wolfGroup, id: 'gB' } }],
    request: { contextTokens: 1, sort: [{ at: 'pos' as const, dir: 1 as const }], page: { offset: 0, limit: 10 } },
  };

  it('the per-track gate stops BEFORE the next track computes (a cancel raised DURING track A)', async () => {
    const { h, snap } = await ready();
    h.clear();
    // Track A resolves a UNIQUE surface absent from the corpus; track B passes
    // the wire schema (narrowMember accepts an empty-surfaces phrase) but THROWS
    // inside `occurrences`. The cancel is raised from inside track A's own
    // `resolveToken` fold (String.toLocaleLowerCase on that unique surface — a
    // call the resolver-prep vocab folding never makes). So the gate that must
    // catch it is the one AFTER track A: move it before the loop (or delete it)
    // and track B computes and throws instead of cancelling cleanly.
    const MARKER = 'zzsentinelalpha';
    const trackA = { seriesId: 'A', group: { id: 'gA', countOverlaps: false, members: [{ id: 'a', kind: 'token', surface: MARKER, match: { case: 'folded', diacritics: 'sensitive' } }] } };
    const throwingB = { seriesId: 'B', group: { id: 'gThrow', countOverlaps: false, members: [{ id: 'p', kind: 'phrase', surfaces: [], crossSentence: false, match: { case: 'folded', diacritics: 'sensitive' } }] } };
    const query = { op: 'kwic', selection: { docs: ['a'] }, tracks: [trackA, throwingB], request: { contextTokens: 1, sort: [{ at: 'pos', dir: 1 }], page: { offset: 0, limit: 10 } } };
    const origLower = String.prototype.toLocaleLowerCase;
    let firedDuringA = false;
    String.prototype.toLocaleLowerCase = function (this: string, ...args: [(string | string[])?]) {
      if (!firedDuringA && String(this) === MARKER) { firedDuringA = true; void h.send({ t: 'cancel', job: 52 }); }
      return origLower.apply(this, args) as string;
    } as typeof String.prototype.toLocaleLowerCase;
    try {
      await h.send({ t: 'query', job: 52, snapshot: snap, query });
    } finally {
      String.prototype.toLocaleLowerCase = origLower;
    }
    expect(firedDuringA).toBe(true); // track A's surface was resolved (A computed) before the cancel
    expect(h.all('cancelled').some((m) => m.job === 52)).toBe(true);
    expect(h.all('result').some((m) => m.job === 52)).toBe(false);
    expect(h.all('error').some((m) => m.job === 52)).toBe(false); // track B never computed → never threw
  });

  it('the FINAL gate catches a cancel raised DURING materialization', async () => {
    const { h, snap } = await ready(); // doc 'a' text contains 'the wolf ran far'
    h.clear();
    // Fire the cancel the first time the doc text is sliced — i.e. INSIDE
    // materializeKwicPage, after numeric planning + its checkpoint. Only a gate
    // AFTER materialization can catch it; a gate moved before it would already
    // have passed and the result would emit.
    const origSlice = String.prototype.slice;
    let sliced = false;
    String.prototype.slice = function (this: string, ...args: [number?, number?]) {
      if (!sliced && this.includes('the wolf ran far')) { sliced = true; void h.send({ t: 'cancel', job: 51 }); }
      return origSlice.apply(this, args) as string;
    } as typeof String.prototype.slice;
    try {
      await h.send({ t: 'query', job: 51, snapshot: snap, query: twoTrackKwic });
    } finally {
      String.prototype.slice = origSlice;
    }
    expect(sliced).toBe(true); // materialization was actually reached (not vacuous)
    expect(h.all('cancelled').some((m) => m.job === 51)).toBe(true);
    expect(h.all('result').some((m) => m.job === 51)).toBe(false);
  });

  it('re-querying with a REUSED group.id but different members returns FRESH rows (cache keys on matching identity)', async () => {
    // group.id is caller-owned provenance. A memo keyed on it would serve the
    // first query's occurrences for the second — the exact stale-row bug.
    const { h, snap } = await ready(); // 'the wolf ran far. a wolf slept.'
    const kwic = (surface: string, job: number) => h.send({
      t: 'query', job, snapshot: snap, query: {
        op: 'kwic', selection: { docs: ['a'] },
        // SAME group.id 'REUSED' both times; only the member surface changes.
        tracks: [{ seriesId: 's', group: { id: 'REUSED', countOverlaps: false, members: [{ id: 'm', kind: 'token', surface, match: FOLD }] } }],
        request: { contextTokens: 1, sort: [{ at: 'pos', dir: 1 }], page: { offset: 0, limit: 10 } },
      },
    });
    await kwic('wolf', 60);
    const first = h.last('result');
    expect(first.data.op === 'kwic' && first.data.rows.map((r) => r.nodeText)).toEqual(['wolf', 'wolf']);
    await kwic('ran', 61);
    const second = h.last('result');
    expect(second.data.op === 'kwic' && second.data.rows.map((r) => r.nodeText)).toEqual(['ran']);
  });

  it('bounds the occurrence cache at MAX_KWIC_TRACKS even under overlapping, interleaving KWIC jobs', async () => {
    const { h, snap } = await ready('the wolf ran far. a wolf slept. i saw the fox and the owl.');
    const cache = () => (h.engine as unknown as { generation: { kwicOccCache: Map<string, unknown> } | null }).generation!.kwicOccCache;
    const kwicQuery = (surfaces: string[]) => ({
      op: 'kwic' as const, selection: { docs: ['a'] },
      tracks: surfaces.map((surface, i) => ({ seriesId: `s${i}`, group: { id: `g${i}`, countOverlaps: false, members: [{ id: 'm', kind: 'token' as const, surface, match: FOLD }] } })),
      request: { contextTokens: 1, sort: [{ at: 'pos' as const, dir: 1 as const }], page: { offset: 0, limit: 10 } },
    });
    // Two DISTINCT 4-track jobs (8 unique groups > MAX_KWIC_TRACKS=5). In manual
    // yield mode each per-track checkpoint parks; releasing them round-robin
    // interleaves A and B so a prune-before-the-loop would let the map grow past
    // the cap. Drive them to completion and assert the hard bound held throughout.
    h.manual();
    const pA = h.send({ t: 'query', job: 80, snapshot: snap, query: kwicQuery(['the', 'wolf', 'ran', 'far']) });
    const pB = h.send({ t: 'query', job: 81, snapshot: snap, query: kwicQuery(['a', 'i', 'saw', 'fox']) });
    let guard = 0;
    while (guard++ < 200) {
      expect(cache().size).toBeLessThanOrEqual(MAX_KWIC_TRACKS);
      h.releaseYield();
      // eslint-disable-next-line no-await-in-loop
      await h.flush();
      const done = h.all('result').filter((m) => m.job === 80 || m.job === 81).length;
      if (done >= 2) break;
    }
    await Promise.all([pA, pB]);
    expect(cache().size).toBeLessThanOrEqual(MAX_KWIC_TRACKS);
    expect(h.all('result').filter((m) => m.data.op === 'kwic' && (m.job === 80 || m.job === 81))).toHaveLength(2);
  });

  it('answers passage with marks, per-token extents, and a center span', async () => {
    const { h, snap } = await ready();
    await h.send({ t: 'query', job: 25, snapshot: snap, query: { op: 'passage', request: { doc: 'a', centerToken: 3, maxTokens: 200, tracks: [{ seriesId: 's1', group: wolfGroup }] } } });
    const r = h.last('result');
    expect(r.data.op).toBe('passage');
    if (r.data.op === 'passage') {
      const p = r.data.passage;
      expect(p.text).toBe('the wolf ran far. a wolf slept');
      expect(p.marks.length).toBe(2);
      expect(p.marks.every((m) => m.seriesId === 's1')).toBe(true);
      expect(p.marks.map((m) => p.text.slice(m.charsUtf16.start, m.charsUtf16.end))).toEqual(['wolf', 'wolf']);
    }
  });

  it('rejects an out-of-range passage center as REQUEST_INVALID, and duplicate track ids at the wire', async () => {
    const { h, snap } = await ready('only four tokens here');
    await h.send({ t: 'query', job: 26, snapshot: snap, query: { op: 'passage', request: { doc: 'a', centerToken: 40, maxTokens: 10, tracks: [] } } });
    expect(h.last('error').code).toBe('REQUEST_INVALID'); // kernel range check
    await h.send({ t: 'query', job: 27, snapshot: snap, query: { op: 'passage', request: { doc: 'a', centerToken: 1, maxTokens: 10, tracks: [{ seriesId: 'dup', group: wolfGroup }, { seriesId: 'dup', group: { ...wolfGroup, id: 'g9' } }] } } });
    expect(h.last('error').code).toBe('PARSE_FAILED'); // duplicate seriesId rejected by the narrower
  });

  it('a passage track with an empty phrase is REQUEST_INVALID (kernel), matching the trend path', async () => {
    const { h, snap } = await ready('the wolf ran');
    await h.send({ t: 'query', job: 28, snapshot: snap, query: { op: 'passage', request: { doc: 'a', centerToken: 1, maxTokens: 10, tracks: [{ seriesId: 's-bad', group: { id: 'g-bad', members: [{ id: 'p', kind: 'phrase', surfaces: [], match: FOLD, crossSentence: false }], countOverlaps: false } }] } } });
    expect(h.last('error').code).toBe('REQUEST_INVALID');
  });

  it('rejects queries against a superseded snapshot (SNAPSHOT_UNKNOWN) and invalid selections (SELECTION_INVALID)', async () => {
    const h = harness();
    const a = await docSpec('a', 'wolf one');
    const b = await docSpec('b', 'wolf two');
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', 'wolf one', 10);
    const first = h.last('snapshot-published').snapshot;
    await coldIngest(h, 'g', 'b', 'wolf two', 11); // supersedes the snapshot
    await h.send({ t: 'query', job: 30, snapshot: first, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 1 } } });
    expect(h.last('error').code).toBe('SNAPSHOT_UNKNOWN');
    const snap = h.last('snapshot-published').snapshot;
    await h.send({ t: 'query', job: 31, snapshot: snap, query: { op: 'trend', selection: { docs: ['zz'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 1 } } });
    expect(h.last('error').code).toBe('SELECTION_INVALID');
  });

  it('trend results carry an EXPLICIT transfer list; canonical shard buffers never do', async () => {
    const { h, snap } = await ready();
    await h.send({ t: 'query', job: 50, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 2 } } });
    const idx = h.messages.findIndex((m) => m.t === 'result');
    const transfers = h.transferLists[idx];
    expect(transfers).toBeDefined();
    const result = h.messages[idx]!;
    if (result.t === 'result' && result.data.op === 'trend') {
      const t = result.data.trend;
      const views = [t.docOrdinal, t.binIndex, t.binStartToken, t.binTokens, t.count, t.ratePer10k];
      expect(new Set(transfers as ArrayBuffer[])).toEqual(new Set(views.map((v) => v.buffer)));
      // No canonical shard buffer is ever transferred (collected recursively).
      const shardBuffers = new Set<ArrayBuffer>();
      const collect = (v: unknown): void => {
        if (ArrayBuffer.isView(v)) shardBuffers.add(v.buffer as ArrayBuffer);
        else if (v !== null && typeof v === 'object') for (const n of Object.values(v)) collect(n);
      };
      for (const shard of innerShards(h).values()) collect(shard);
      expect(shardBuffers.size).toBeGreaterThanOrEqual(9);
      for (const buf of transfers as ArrayBuffer[]) expect(shardBuffers.has(buf)).toBe(false);
    }
    // A second identical query still answers — the canonical index was not detached.
    await h.send({ t: 'query', job: 51, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 2 } } });
    const results = h.all('result');
    expect(results.length).toBe(2);
  });

  it('re-ingesting a document replaces its resolver cache atomically', async () => {
    const h = harness();
    const spec = await docSpec('a', 'wolf');
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', 'wolf', 10);
    const snap1 = h.last('snapshot-published').snapshot;
    await h.send({ t: 'query', job: 70, snapshot: snap1, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 1 } } });
    expect(h.last('result').data.op).toBe('trend');
    // Replace the document under the SAME generation (a fresh spec with no
    // asserted identity so different bytes are accepted).
    const fresh = await freshTxtSpec('a', 4);
    await h.send({ t: 'begin-generation', job: 71, generation: 'g2', docs: [fresh], indexRecipe: DEFAULT_INDEX_RECIPE });
    await coldIngest(h, 'g2', 'a', 'bear', 72);
    const snap2 = h.last('snapshot-published').snapshot;
    expect(snap2).not.toBe(snap1);
    const bearGroup = { id: 'g2', members: [{ id: 'm', kind: 'token' as const, surface: 'bear', match: FOLD }], countOverlaps: false };
    await h.send({ t: 'query', job: 73, snapshot: snap2, query: { op: 'trend', selection: { docs: ['a'] }, group: bearGroup, request: { coordinate: 'document-relative', binsPerDoc: 1 } } });
    const r = h.last('result');
    expect(r.data.op).toBe('trend');
    if (r.data.op === 'trend') expect(Array.from(r.data.trend.count)).toEqual([1]);
    expect(h.all('error').some((e) => /different shard/.test(e.message))).toBe(false);
  });

  it('a late cancel for a finished job is dropped; job bookkeeping does not accrete', async () => {
    const { h, snap } = await ready('the wolf ran');
    await h.send({ t: 'query', job: 40, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 1 } } });
    expect(h.last('result').data.op).toBe('trend');
    await h.send({ t: 'cancel', job: 40 }); // job already finished
    const internals = h.engine as unknown as { activeJobs: Set<number>; cancelledJobs: Set<number> };
    expect(internals.activeJobs.size).toBe(0);
    expect(internals.cancelledJobs.size).toBe(0);
  });
});

describe('decode policy at the wire (v4)', () => {
  it('authoritatively BOM-declared malformed Unicode is DECODE_FAILED', async () => {
    const h = harness();
    await begin(h, [await freshTxtSpec('a', 5)]);
    // A UTF-8 BOM declares UTF-8; the invalid continuation makes the strict
    // (fatal) decode fail — with the encoding authoritatively declared, there
    // is no windows-1252 fallback.
    const bad = Uint8Array.from([0xef, 0xbb, 0xbf, 0xc3, 0x28]);
    await h.send({ t: 'ingest', job: 10, generation: 'g', doc: 'a', bytes: bad.buffer as ArrayBuffer });
    expect(h.last('error').code).toBe('DECODE_FAILED');
  });

  it('invalid UTF-8 with NO BOM falls back to windows-1252 (honest evidence)', async () => {
    const h = harness();
    await begin(h, [await freshTxtSpec('a', 1)]);
    // 0xff is not a valid UTF-8 start byte and there is no BOM → total
    // windows-1252 fallback ('ÿ'), with zero decoder replacements.
    await h.send({ t: 'ingest', job: 10, generation: 'g', doc: 'a', bytes: Uint8Array.from([0xff]).buffer as ArrayBuffer });
    const sr = h.last('source-ready');
    if (sr.source.kind !== 'text') throw new Error('expected a text source descriptor');
    expect(sr.source.encoding.detected).toBe('windows-1252');
    expect(sr.source.encoding.hadReplacementChars).toBe(false);
    expect(sr.decoderReplacementCount).toBe(0);
    expect(h.last('snapshot-published').readyDocs).toEqual(['a']);
  });
});

describe('composition and query races (v4)', () => {
  it('a generation replaced DURING composition suppresses publication', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran');
    await begin(h, [spec], 'g1');
    // Replace the generation from inside the compose progress emission.
    h.onEmit((m) => {
      if (m.t === 'progress' && m.phase === 'compose') {
        h.onEmit(null);
        void h.send({ t: 'begin-generation', job: 9, generation: 'g2', docs: [], indexRecipe: DEFAULT_INDEX_RECIPE });
      }
    });
    await coldIngest(h, 'g1', 'a', 'the wolf ran', 2);
    expect(h.all('snapshot-published').length).toBe(0);
    expect(h.all('error').some((e) => e.code === 'GENERATION_STALE')).toBe(true);
  });

  it('a query whose generation is replaced mid-flight never emits a result (SNAPSHOT_UNKNOWN)', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran');
    await begin(h, [spec], 'g1');
    await coldIngest(h, 'g1', 'a', 'the wolf ran', 10);
    const snap = h.last('snapshot-published').snapshot;
    // Park the query at its first checkpoint, replace the generation, release.
    let replaced = false;
    h.onYield(async () => {
      if (!replaced) { replaced = true; await h.send({ t: 'begin-generation', job: 4, generation: 'g2', docs: [], indexRecipe: DEFAULT_INDEX_RECIPE }); }
    });
    await h.send({ t: 'query', job: 3, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 1 } } });
    expect(h.all('result').length).toBe(0);
    expect(h.all('error').some((e) => e.code === 'SNAPSHOT_UNKNOWN')).toBe(true);
  });

  it('a cancel queued during the FINAL kernel checkpoint is observed before emission', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran');
    await begin(h, [spec], 'g1');
    await coldIngest(h, 'g1', 'a', 'the wolf ran', 10);
    const snap = h.last('snapshot-published').snapshot;
    let yields = 0;
    h.onYield(async () => { yields++; if (yields === 4) await h.send({ t: 'cancel', job: 3 }); });
    await h.send({ t: 'query', job: 3, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', binsPerDoc: 1 } } });
    expect(yields).toBeGreaterThanOrEqual(4);
    expect(h.all('result').length).toBe(0);
    expect(h.all('cancelled').some((m) => m.job === 3)).toBe(true);
  });
});

describe('legacy race parity (v4)', () => {
  it('a cancel delivered DURING composition (after the initial gate) is caught by the FINAL commit gate', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran');
    await begin(h, [spec], 'g1');
    // The cancel must land AFTER commitDocuments' initial gate but BEFORE its
    // post-compose/bind commit gate — otherwise a regression deleting the final
    // gate would still pass. Activate only once `compose` progress fires, then
    // deliver the cancel from inside composeSnapshot's own hashing.
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let active = false;
    let fired = false;
    h.onEmit((m) => { if (m.t === 'progress' && m.phase === 'compose') active = true; });
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(((...args: Parameters<typeof realDigest>) => {
      if (active && !fired) { fired = true; void h.send({ t: 'cancel', job: 2 }); }
      return realDigest(...args);
    }) as typeof crypto.subtle.digest);
    await coldIngest(h, 'g1', 'a', 'the wolf ran', 2);
    spy.mockRestore();
    expect(fired).toBe(true); // the cancel landed inside composition (past the initial gate)
    expect(h.all('snapshot-published').length).toBe(0);
    expect(h.all('cancelled').some((m) => m.job === 2)).toBe(true);
  });

  it('a stale CORRUPT text read observed across a concurrent ingest commit cannot warn or delete', async () => {
    const h = harness();
    const text = 'the wolf ran';
    const spec = await docSpec('a', text);
    await begin(h, [spec], 'g1');
    await coldIngest(h, 'g1', 'a', text, 10);
    await h.flush();
    h.clear();
    // Warm reopen: the TEXT read reports corrupt, but a LIVE ingest supersedes
    // the document during that read. The stale corrupt observation may have
    // been replaced by the ingest's valid write — it must NOT warn or deleteText.
    h.store.corruptTextOnce = true;
    h.store.resetReads(); // count text reads within the WARM generation only
    const deletesBefore = h.store.textDeletes;
    h.store.onTextRead = async (n) => {
      if (n === 1) await h.send({ t: 'ingest', job: 30, generation: 'g2', doc: 'a', bytes: buf(text) });
    };
    await begin(h, [spec], 'g2');
    await h.flush();
    expect(h.all('warning').some((w) => w.code === 'CACHE_CORRUPT')).toBe(false);
    expect(h.store.textDeletes).toBe(deletesBefore); // the valid replacement was not repaired away
    expect(h.last('generation-ready').readyDocs).toEqual(['a']);
    expect(h.all('error')).toEqual([]);
  });

  it('a stale CORRUPT shard read observed across a concurrent ingest commit cannot warn or delete', async () => {
    const h = harness();
    const text = 'the wolf ran';
    const spec = await docSpec('a', text);
    await begin(h, [spec], 'g1');
    await coldIngest(h, 'g1', 'a', text, 10);
    await h.flush();
    h.clear();
    // Warm reopen: the shard read reports corrupt, but a LIVE ingest supersedes
    // the document during that read. The stale corrupt observation may have
    // been replaced by the ingest's valid write — it must NOT warn or delete.
    h.store.corruptShardOnce = true;
    const deletesBefore = h.store.shardDeletes;
    h.store.onShardRead = async () => {
      await h.send({ t: 'ingest', job: 30, generation: 'g2', doc: 'a', bytes: buf(text) });
    };
    await begin(h, [spec], 'g2');
    await h.flush();
    expect(h.all('warning').some((w) => w.code === 'CACHE_CORRUPT')).toBe(false);
    expect(h.store.shardDeletes).toBe(deletesBefore); // the valid replacement was not repaired away
    expect(h.last('generation-ready').readyDocs).toEqual(['a']);
    expect(h.all('error')).toEqual([]);
  });

  it('a cancel during source hashing reports cancelled, never SOURCE_MISMATCH', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran'); // asserts expectedText/expectedHash
    await begin(h, [spec], 'g1');
    // Park the ingest's FIRST digest (source-byte hashing), cancel the job,
    // then release: the ownership/cancel gate after hashing must win over the
    // identity check (a cancel must not surface as SOURCE_MISMATCH).
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release: (() => void) | null = null;
    let armed = true;
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(((...args: Parameters<typeof realDigest>) => {
      if (!armed) return realDigest(...args);
      armed = false;
      return new Promise<ArrayBuffer>((resolve) => { release = () => resolve(realDigest(...args)); });
    }) as typeof crypto.subtle.digest);
    const ingestPromise = h.send({ t: 'ingest', job: 2, generation: 'g1', doc: 'a', bytes: buf('different content') });
    while (release === null) await new Promise((r) => setTimeout(r));
    await h.send({ t: 'cancel', job: 2 });
    (release as unknown as () => void)();
    await ingestPromise;
    spy.mockRestore();
    expect(h.all('error').map((e) => e.code)).not.toContain('SOURCE_MISMATCH');
    expect(h.all('cancelled').some((m) => m.job === 2)).toBe(true);
  });
});

describe('single text-hash threading (Phase D / D2 — VerifiedText)', () => {
  /** Count digests whose input is EXACTLY the encoded text; every other digest
   *  (source bytes, recipes, fingerprints, artifact identities) passes through
   *  uncounted — byte-equality is the discriminator (same seam as the
   *  decode-table-hash and section-binding suites). */
  function spyTextDigests(text: string) {
    const expected = utf8(text);
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let count = 0;
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(((...args: Parameters<typeof realDigest>) => {
      const data = args[1];
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      if (bytes.length === expected.length && bytes.every((b, i) => b === expected[i])) count++;
      return realDigest(...args);
    }) as typeof crypto.subtle.digest);
    return { count: () => count, restore: () => spy.mockRestore() };
  }

  it('a COLD ingest performs exactly ONE text digest across extract→segment→index→bind→commit', async () => {
    const h = harness();
    const text = 'the wolf ran far over the hill';
    // A UTF-8 BOM makes the SOURCE bytes differ from the encoded text, so the
    // ingest's source-byte digest can never be mistaken for a text digest.
    const bomBytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(text)]);
    const recipes = await defaultExtractionRecipes();
    const extracted = await extractDocument(bomBytes, recipes.txt);
    const spec: GenerationDocSpecV4 = {
      doc: 'a', language: 'en',
      source: { expectedHash: extracted.artifact.source, byteLength: bomBytes.length, format: 'txt', availability: 'external' },
      extraction: {
        recipe: recipes.txt,
        recipeHash: await hashExtractionRecipe(recipes.txt),
        expectedText: extracted.artifact.text,
        expectedTextLengthUtf16: extracted.artifact.textLengthUtf16,
        expectedCandidates: extracted.artifact.candidateHash,
      },
      structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: await hashStructureRecipe(DEFAULT_STRUCTURE_RECIPE), override: { kind: 'none' } },
    };
    await begin(h, [spec]); // nothing cached — the barrier reports a byte miss
    expect(h.last('generation-ready').missing).toEqual([{ doc: 'a', need: 'source-bytes', reason: 'extraction-miss' }]);
    const spy = spyTextDigests(text);
    try {
      await h.send({ t: 'ingest', job: 10, generation: 'g', doc: 'a', bytes: bomBytes.buffer as ArrayBuffer });
      expect(h.last('snapshot-published').readyDocs).toEqual(['a']);
      expect(h.all('error').length).toBe(0);
      // ONE digest: minted at extraction; segmentVerified /
      // createDocumentIndexVerified / bindTextsVerified consume the proof.
      expect(spy.count()).toBe(1);
    } finally {
      spy.restore();
    }
  });

  it('a WARM stored-text load performs exactly ONE text digest (mint at the expected-hash check)', async () => {
    const h = harness();
    const text = '# Ch\n\nthe wolf ran far';
    const spec = await docSpec('a', text, { format: 'md' });
    await begin(h, [spec], 'cold');
    await coldIngest(h, 'cold', 'a', text, 10);
    await h.flush(); // let the disposable cache writes settle
    h.clear();
    const spy = spyTextDigests(text);
    try {
      await begin(h, [spec], 'warm');
      const ready = h.last('generation-ready');
      expect(ready.readyDocs).toEqual(['a']);
      expect(ready.missing).toEqual([]);
      expect(h.all('progress').length).toBe(0); // pure admission — exact hit
      // ONE digest: verifyText(storedText, expectedHash) at admission; the
      // cached-extraction admission and the commit bind consume the proof.
      expect(spy.count()).toBe(1);
    } finally {
      spy.restore();
    }
  });
});
