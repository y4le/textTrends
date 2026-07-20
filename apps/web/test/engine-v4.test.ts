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
  type IngestCapsV0,
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
  constructor(private readonly inner: InMemoryArtifactStore) {}
  async getText(h: string): Promise<CacheRead<string>> {
    this.textReads++;
    if (this.onTextRead) await this.onTextRead(this.textReads);
    return this.hide.text ? { kind: 'miss' } : this.inner.getText(h);
  }
  putText(h: string, t: string) { this.writes.text++; return this.inner.putText(h, t); }
  deleteText(h: string) { return this.inner.deleteText(h); }
  async getShard(k: never): Promise<CacheRead<unknown>> {
    if (this.onShardRead) { const cb = this.onShardRead; this.onShardRead = null; await cb(); }
    return this.hide.shard ? { kind: 'miss' } : this.inner.getShard(k);
  }
  putShard(k: never, s: never) { this.writes.shard++; return this.inner.putShard(k, s); }
  deleteShard(k: never) { return this.inner.deleteShard(k); }
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
  store: FilterStore;
  userStore: InMemoryUserDataStore;
  setUserData(p: UserDataProvider): void;
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
  const store = sharedStore ?? new FilterStore(new InMemoryArtifactStore());
  const userStore = new InMemoryUserDataStore();
  let provider: UserDataProvider = () => Promise.resolve({ kind: 'ok', store: userStore } as UserDataAccess);
  let auto = true;
  const pending: (() => void)[] = [];
  const engine = new WorkerEngineV4(
    store,
    () => provider(),
    (m) => messages.push(m),
    () => (auto ? Promise.resolve() : new Promise<void>((resolve) => pending.push(resolve))),
    caps,
  );
  return {
    engine,
    messages,
    store,
    userStore,
    setUserData: (p) => { provider = p; },
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

  it('a corrupt persisted source is reported and RETAINED (never auto-deleted)', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far', { availability: 'persisted' });
    let deleted = 0;
    const corruptStore: UserDataStore = {
      getProject: () => Promise.resolve({ kind: 'miss' }),
      putProject: () => Promise.reject(new Error('n/a')),
      getSource: () => Promise.resolve({ kind: 'corrupt', reason: 'bytes do not match' }),
      putSource: () => Promise.resolve(),
      deleteSource: () => { deleted++; return Promise.resolve(); },
      close: () => undefined,
    };
    h.setUserData(() => Promise.resolve({ kind: 'ok', store: corruptStore }));
    await begin(h, [spec], 'warm');
    const ready = h.last('generation-ready');
    expect(ready.missing).toEqual([{ doc: 'a', need: 'source-bytes', reason: 'source-corrupt' }]);
    expect(deleted).toBe(0); // the durable source is the user's only copy
    expect(h.all('warning').some((w) => w.code === 'CACHE_CORRUPT')).toBe(true);
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
      deleteSource: () => Promise.resolve(),
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
