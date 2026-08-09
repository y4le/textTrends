/**
 * WorkerEngineV4 lifecycle/race suite. Exercises ingestion, cache admission,
 * publication and cancellation over injected boundaries.
 */
import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION_V4, type GenerationDocSpecV4 } from '../src/worker/protocol-v4.ts';
import { begin, buf, coldIngest, FOLD, harness, utf8, wolfGroup, type Harness } from './support/engine-harness.ts';
import { buildDocSpec as docSpec, extractLiteral as extractDocument } from './support/spec-fixtures.ts';
import {
  bindShardsIncremental,
  createBindingSession,
  DEFAULT_INDEX_RECIPE,
  INGEST_CAPS_V0,
  defaultExtractionRecipes,
  hashExtractionRecipe,
} from '@texttrends/core';

// D1 wiring seam: pass-through spies on the shard-binding entry points, so the
// incremental-binding suite below can observe WHICH bind path the publication
// mutex uses and WHICH session object it carries. Phase E adds the same
// pass-through treatment to `occurrences`, so the occurrence-cache suite can
// count exactly how many times the engine pays for a full per-doc match.
// Every wrapper delegates to the real implementation — behavior is unchanged
// for all other tests.
vi.mock('@texttrends/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@texttrends/core')>();
  return {
    ...actual,
    bindShardsIncremental: vi.fn(actual.bindShardsIncremental),
    createBindingSession: vi.fn(actual.createBindingSession),
    occurrences: vi.fn(actual.occurrences),
  };
});


describe('generation resolution and plan validation', () => {
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

  it('keeps the engine authoritative for the generation document cap', async () => {
    const h = harness();
    const base = await docSpec('d0', 'same admitted source');
    const docs = Array.from(
      { length: INGEST_CAPS_V0.maxDocsPerProject + 1 },
      (_, i) => ({ ...base, doc: `d${i}` }),
    );
    await begin(h, docs);
    expect(h.last('error').code).toBe('CAP_EXCEEDED');
    expect(h.last('error').message).toMatch(/65 documents.*64 cap/);
    expect(h.all('generation-ready')).toHaveLength(0);
  });

  it('enforces the project caps for FRESH imports that carry no text assertion (byteLength bounds text)', async () => {
    const recipes = await defaultExtractionRecipes();
    // A fresh import: source only, with no expected text identity.
    const fresh = async (doc: string, byteLength: number): Promise<GenerationDocSpecV4> => ({
      doc, language: 'en',
      source: { byteLength, format: 'txt' },
      extraction: { recipe: recipes.txt, recipeHash: await hashExtractionRecipe(recipes.txt) },
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
      source: { byteLength: 8, format: 'txt' },
      extraction: { recipe: recipes.txt, recipeHash: await hashExtractionRecipe(recipes.txt) },
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
  it('a first cold ingest publishes the document with honest progress', async () => {
    const h = harness();
    const spec = await docSpec('a', '# Part I\n\nthe wolf ran far\n\n# Part II\n\na wolf slept', { format: 'md' });
    await begin(h, [spec]);
    const ready = h.last('generation-ready');
    expect(ready.missingDocs).toEqual(['a']);
    await coldIngest(h, 'g', 'a', '# Part I\n\nthe wolf ran far\n\n# Part II\n\na wolf slept', 10);
    const published = h.last('snapshot-published');
    expect(published.readyDocs).toEqual(['a']);

    // Honest cold progress includes decode and extract.
    const phases = h.all('progress').map((p) => p.phase);
    expect(phases).toEqual(['decode', 'extract', 'segment', 'index', 'compose']);
  });

  it('emits source-ready with honest decoder evidence and the full descriptor', async () => {
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far');
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', 'the wolf ran far', 10);
    const sr = h.last('source-ready');
    expect(sr.source.hash).toBe(spec.source.expectedHash);
    expect(sr.text).toBe(spec.extraction.expectedText);
    expect(sr.decoderReplacementCount).toBe(0);
    if (sr.source.kind !== 'text') throw new Error('expected a text source descriptor');
    expect(sr.source.encoding.hadReplacementChars).toBe(false);
  });

  it('two same-generation ingests with different bytes cannot change the document identity in place', async () => {
    const h = harness();
    // No asserted text identity: the FIRST accepted bytes freeze the meaning.
    const recipes = await defaultExtractionRecipes();
    const spec: GenerationDocSpecV4 = {
      doc: 'a', language: 'en',
      source: { byteLength: 16, format: 'txt' },
      extraction: { recipe: recipes.txt, recipeHash: await hashExtractionRecipe(recipes.txt) },
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
      source: { byteLength: 16, format: 'txt' },
      extraction: { recipe: recipes.txt, recipeHash: await hashExtractionRecipe(recipes.txt) },
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

describe('warm reopen (deep admission across text and index)', () => {
  async function coldPass(h: Harness, spec: GenerationDocSpecV4, text: string) {
    await begin(h, [spec], 'cold');
    await coldIngest(h, 'cold', spec.doc, text, 10);
    await h.flush(); // let best-effort disposable writes settle
    h.clear();
  }

  it('an exact warm reopen performs no decode, extract, segment, or index work', async () => {
    const h = harness();
    const text = '# Ch\n\nthe wolf ran far';
    const spec = await docSpec('a', text, { format: 'md' });
    await coldPass(h, spec, text);
    await begin(h, [spec], 'warm');
    const ready = h.last('generation-ready');
    expect(ready.readyDocs).toEqual(['a']);
    expect(ready.missingDocs).toEqual([]);
    expect(h.all('progress').length).toBe(0); // pure admission
    expect(h.all('snapshot-published').length).toBe(1);
  });

  it('text present, shard missing → rebuilds the shard with no source fetch', async () => {
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
    h.store.writes = { text: 0, shard: 0 };
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
    // 'a' was written once — by the live ingest, not again by the batch that
    // dropped it. Both committed documents account for two text writes total.
    expect(h.store.writes.text).toBe(2);
  });

  it('generation-ready.missingDocs excludes a document accepted in-flight by a concurrent ingest', async () => {
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
    expect(ready.missingDocs).not.toContain('a');
    expect(ready.readyDocs).toContain('a');
    expect(h.all('snapshot-published').length).toBe(1);
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
    source: { byteLength, format: 'txt' },
    extraction: { recipe: txt, recipeHash: await hashExtractionRecipe(txt) },
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
      { op: 'trend', selection: { docs: ['a'] }, group: null, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } },
      { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: null },
      { op: 'trend', selection: { docs: ['a'] }, group: { id: 'g', members: [null], countOverlaps: false }, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } },
      { op: 'trend', selection: { docs: ['a'] }, group: { ...wolfGroup, countOverlaps: 'false' }, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } },
      { op: 'bogus' },
      null,
    ]) {
      await h.send({ t: 'query', job: 20, snapshot: snap, query: bad });
      expect(h.last('error').code, JSON.stringify(bad)).toBe('PARSE_FAILED');
    }
    // The V1 group bounds are enforced AT THE WIRE (TERM_GROUP_LIMITS_V1, one
    // authority with the kernel): an empty phrase / empty stem / oversized
    // member list is a malformed message, not a kernel error.
    for (const badGroup of [
      { id: 'g', members: [{ id: 'p', kind: 'phrase', surfaces: [], match: FOLD, crossSentence: false }], countOverlaps: false },
      { id: 'g', members: [{ id: 'p', kind: 'prefix', stem: '', match: FOLD }], countOverlaps: false },
    ]) {
      await h.send({
        t: 'query', job: 20, snapshot: snap,
        query: { op: 'trend', selection: { docs: ['a'] }, group: badGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } },
      });
      expect(h.last('error').code, JSON.stringify(badGroup)).toBe('PARSE_FAILED');
    }
    // A bin count outside the closed wire range is malformed before dispatch.
    await h.send({
      t: 'query', job: 21, snapshot: snap,
      query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 3 } } },
    });
    expect(h.last('error').code).toBe('PARSE_FAILED');
    // Narrowing-valid but KERNEL-invalid: mapped deterministically BY TYPE. A
    // duplicate member id 'cap' (the one semantic check the narrower leaves to
    // the kernel) must be REQUEST_INVALID, never CAP_EXCEEDED.
    await h.send({
      t: 'query', job: 22, snapshot: snap,
      query: { op: 'trend', selection: { docs: ['a'] }, group: { id: 'g', members: [{ id: 'cap', kind: 'token', surface: 'x', match: FOLD }, { id: 'cap', kind: 'token', surface: 'y', match: FOLD }], countOverlaps: false }, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } },
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

describe('query dispatch and emission (engine-retained after the executor extraction)', () => {
  async function ready(text = 'the wolf ran far. a wolf slept.') {
    const h = harness();
    const spec = await docSpec('a', text);
    await begin(h, [spec]);
    await coldIngest(h, 'g', 'a', text, 10);
    return { h, snap: h.last('snapshot-published').snapshot };
  }

  it('rejects queries against a superseded snapshot (SNAPSHOT_UNKNOWN) and invalid selections (SELECTION_INVALID)', async () => {
    const h = harness();
    const a = await docSpec('a', 'wolf one');
    const b = await docSpec('b', 'wolf two');
    await begin(h, [a, b]);
    await coldIngest(h, 'g', 'a', 'wolf one', 10);
    const first = h.last('snapshot-published').snapshot;
    await coldIngest(h, 'g', 'b', 'wolf two', 11); // supersedes the snapshot
    await h.send({ t: 'query', job: 30, snapshot: first, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } } });
    expect(h.last('error').code).toBe('SNAPSHOT_UNKNOWN');
    const snap = h.last('snapshot-published').snapshot;
    await h.send({ t: 'query', job: 31, snapshot: snap, query: { op: 'trend', selection: { docs: ['zz'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } } });
    expect(h.last('error').code).toBe('SELECTION_INVALID');
  });
  it('trend results carry an EXPLICIT transfer list; canonical shard buffers never do', async () => {
    const { h, snap } = await ready();
    await h.send({ t: 'query', job: 50, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } } });
    const idx = h.messages.findIndex((m: { t: string }) => m.t === 'result');
    const transfers = h.transferLists[idx];
    expect(transfers).toBeDefined();
    const result = h.messages[idx]!;
    if (result.t === 'result' && result.data.op === 'trend') {
      const t = result.data.trend;
      const views = [t.rowOffsets, t.docOrdinal, t.binIndex, t.binStartToken, t.binTokens, t.count, t.ratePer10k];
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
    await h.send({ t: 'query', job: 51, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } } });
    const results = h.all('result');
    expect(results.length).toBe(2);
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
    await h.send({ t: 'query', job: 3, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } } });
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
    await h.send({ t: 'query', job: 3, snapshot: snap, query: { op: 'trend', selection: { docs: ['a'] }, group: wolfGroup, request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } } } });
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
      source: { expectedHash: extracted.artifact.source, byteLength: bomBytes.length, format: 'txt' },
      extraction: {
        recipe: recipes.txt,
        recipeHash: await hashExtractionRecipe(recipes.txt),
        expectedText: extracted.artifact.text,
        expectedTextLengthUtf16: extracted.artifact.textLengthUtf16,
      },
    };
    await begin(h, [spec]); // nothing cached — the barrier reports a byte miss
    expect(h.last('generation-ready').missingDocs).toEqual(['a']);
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
      expect(ready.missingDocs).toEqual([]);
      expect(h.all('progress').length).toBe(0); // pure admission — exact hit
      // ONE digest: verifyText(storedText, expectedHash) at admission; the
      // cached-extraction admission and the commit bind consume the proof.
      expect(spy.count()).toBe(1);
    } finally {
      spy.restore();
    }
  });
});

describe('generation-scoped incremental binding (Phase D workstream D1)', () => {
  it('every publication binds through bindShardsIncremental with the ONE session created at beginGeneration', async () => {
    const inc = vi.mocked(bindShardsIncremental);
    const mkSession = vi.mocked(createBindingSession);
    inc.mockClear();
    mkSession.mockClear();
    const h = harness();
    await begin(h, [await docSpec('a', 'wolf one'), await docSpec('b', 'wolf two')]);
    await coldIngest(h, 'g', 'a', 'wolf one', 2);
    await coldIngest(h, 'g', 'b', 'wolf two', 3);
    expect(h.all('snapshot-published')).toHaveLength(2);
    expect(h.all('error')).toHaveLength(0);
    // One session, minted at beginGeneration, carried by BOTH publications.
    expect(mkSession).toHaveBeenCalledTimes(1);
    const session = mkSession.mock.results[0]!.value;
    expect(inc).toHaveBeenCalledTimes(2);
    for (const call of inc.mock.calls) expect(call[0]).toBe(session);
    // The always-fresh bindShards path is no longer package surface at all —
    // the engine reaching it would be a compile error, not just a test failure.
  });

  it('a replacement generation mints a FRESH session and publishes only through it', async () => {
    const inc = vi.mocked(bindShardsIncremental);
    const mkSession = vi.mocked(createBindingSession);
    inc.mockClear();
    mkSession.mockClear();
    const h = harness();
    const spec = await docSpec('a', 'the wolf ran far');
    await begin(h, [spec], 'g1');
    await coldIngest(h, 'g1', 'a', 'the wolf ran far', 2);
    await h.flush(); // let the disposable cache writes settle for the warm reopen
    h.clear();
    await begin(h, [spec], 'g2'); // warm exact hit — publishes during begin
    expect(h.last('generation-ready').readyDocs).toEqual(['a']);
    expect(mkSession).toHaveBeenCalledTimes(2);
    const s1 = mkSession.mock.results[0]!.value;
    const s2 = mkSession.mock.results[1]!.value;
    expect(s2).not.toBe(s1);
    // g1's publication used g1's session; g2's warm publication used g2's —
    // per-generation cache entries can never cross a generation replacement.
    expect(inc.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(inc.mock.calls[0]![0]).toBe(s1);
    expect(inc.mock.calls.at(-1)![0]).toBe(s2);
    for (const call of inc.mock.calls.slice(1)) expect(call[0]).toBe(s2);
  });
});
