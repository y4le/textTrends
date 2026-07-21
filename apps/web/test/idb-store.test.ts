/**
 * IdbArtifactStore envelope/lifecycle tests against fake-indexeddb.
 * REAL-browser structured clone, reload, and multi-context behavior are
 * Milestone 6 (Playwright) scope — these tests cover the adapter's envelope
 * validation, repair semantics, and failure policy.
 */
import 'fake-indexeddb/auto'; // installs the full IDB* global surface idb needs
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  ARTIFACT_DB_NAME,
  ARTIFACT_DB_VERSION,
  IdbArtifactStore,
  openArtifactStore,
} from '../src/worker/idb-store.ts';
import type { StorageWarningCodeV4 as StorageWarningCode } from '../src/worker/protocol-v4.ts';
import { InMemoryArtifactStore, type DocumentIndexCacheKey } from '../src/worker/store.ts';
import type { DocumentIndexV1 } from '@texttrends/core';
import { openDB } from 'idb';

const KEY: DocumentIndexCacheKey = {
  schema: 'texttrends/document-index/1',
  text: 'texthash',
  recipe: 'recipehash',
  segmenter: 'seghash',
};

// The adapter treats the shard as an opaque payload; the engine validates ABI.
const SHARD = { schema: 'texttrends/document-index/1', marker: 42 } as unknown as DocumentIndexV1;

interface Warning {
  code: StorageWarningCode;
  message: string;
}

beforeEach(() => {
  // A fresh factory per test — no cross-test database state.
  globalThis.indexedDB = new IDBFactory() as unknown as typeof indexedDB;
});

async function open(warnings: Warning[] = []) {
  const store = await openArtifactStore((code, message) => warnings.push({ code, message }));
  expect(store).toBeInstanceOf(IdbArtifactStore);
  return store as IdbArtifactStore;
}

describe('IdbArtifactStore', () => {
  it('round-trips texts and shards and misses on absent keys', async () => {
    const store = await open();
    expect((await store.getText('texthash')).kind).toBe('miss');
    await store.putText('texthash', 'the wolf ran');
    expect(await store.getText('texthash')).toEqual({ kind: 'hit', value: 'the wolf ran' });

    expect((await store.getShard(KEY)).kind).toBe('miss');
    await store.putShard(KEY, SHARD);
    const read = await store.getShard(KEY);
    expect(read.kind).toBe('hit');
    if (read.kind === 'hit') {
      expect((read.value as { marker: number }).marker).toBe(42);
    }
    // Every key component discriminates, including the artifact schema.
    for (const variant of [
      { ...KEY, schema: 'texttrends/document-index/2' as never },
      { ...KEY, text: 'other' },
      { ...KEY, recipe: 'other' },
      { ...KEY, segmenter: 'other' },
    ]) {
      expect((await store.getShard(variant)).kind).toBe('miss');
    }
    store.close();
  });

  it('round-trips extractions and structures with schema-bearing compound keys', async () => {
    const store = await open();
    const extractionKey = { schema: 'texttrends/extraction/1' as const, source: 'src', recipe: 'erec' };
    const structureKey = {
      schema: 'texttrends/structure/2' as const,
      text: 'th', candidates: 'ch', recipe: 'srec', override: 'oh',
    };
    expect((await store.getExtraction(extractionKey)).kind).toBe('miss');
    await store.putExtraction(extractionKey, { schema: 'texttrends/extraction/1', marker: 1 });
    const ex = await store.getExtraction(extractionKey);
    expect(ex.kind).toBe('hit');
    if (ex.kind === 'hit') expect((ex.value as { marker: number }).marker).toBe(1);

    expect((await store.getStructure(structureKey)).kind).toBe('miss');
    await store.putStructure(structureKey, { schema: 'texttrends/structure/2', marker: 2 });
    const st = await store.getStructure(structureKey);
    expect(st.kind).toBe('hit');
    if (st.kind === 'hit') expect((st.value as { marker: number }).marker).toBe(2);

    // Every key component discriminates.
    for (const v of [{ ...extractionKey, source: 'x' }, { ...extractionKey, recipe: 'x' }]) {
      expect((await store.getExtraction(v)).kind).toBe('miss');
    }
    for (const v of [
      { ...structureKey, text: 'x' }, { ...structureKey, candidates: 'x' },
      { ...structureKey, recipe: 'x' }, { ...structureKey, override: 'x' },
    ]) {
      expect((await store.getStructure(v)).kind).toBe('miss');
    }
    await store.deleteExtraction(extractionKey);
    await store.deleteStructure(structureKey);
    expect((await store.getExtraction(extractionKey)).kind).toBe('miss');
    expect((await store.getStructure(structureKey)).kind).toBe('miss');
    store.close();
  });

  it('persists across store instances over the same database', async () => {
    const first = await open();
    await first.putText('texthash', 'persisted');
    await first.putShard(KEY, SHARD);
    first.close();
    const second = await open();
    expect(await second.getText('texthash')).toEqual({ kind: 'hit', value: 'persisted' });
    expect((await second.getShard(KEY)).kind).toBe('hit');
    second.close();
  });

  it('reports envelope corruption with a reason and repairs by exact delete', async () => {
    const store = await open();
    // Plant a record whose envelope disagrees with its key (raw write).
    const db = await openDB(ARTIFACT_DB_NAME, ARTIFACT_DB_VERSION);
    await db.put('shards', {
      schema: 'texttrends/stored-shard/1',
      artifactSchema: KEY.schema,
      textHash: 'DIFFERENT', // planted under KEY's path via explicit key
      recipeHash: KEY.recipe,
      segmenterHash: KEY.segmenter,
      shard: { schema: KEY.schema },
    } as never, undefined); // keyPath-derived key uses textHash 'DIFFERENT'
    db.close();
    // The planted record lives under its own (wrong) key — reading THAT key
    // must yield a key-disagreement... construct the matching cache key:
    const plantedKey = { ...KEY, text: 'DIFFERENT' };
    const okRead = await store.getShard(plantedKey);
    expect(okRead.kind).toBe('hit'); // envelope agrees with ITS OWN key

    // Now corrupt the payload type under KEY.
    const db2 = await openDB(ARTIFACT_DB_NAME, ARTIFACT_DB_VERSION);
    await db2.put('shards', {
      schema: 'texttrends/stored-shard/1',
      artifactSchema: KEY.schema,
      textHash: KEY.text,
      recipeHash: KEY.recipe,
      segmenterHash: KEY.segmenter,
      shard: 'not-an-object',
    } as never);
    db2.close();
    const corrupt = await store.getShard(KEY);
    expect(corrupt.kind).toBe('corrupt');
    if (corrupt.kind === 'corrupt') expect(corrupt.reason).toMatch(/payload/);
    await store.deleteShard(KEY);
    expect((await store.getShard(KEY)).kind).toBe('miss');
    store.close();
  });

  it('rejects unknown stored-record schemas as corrupt', async () => {
    const store = await open();
    const db = await openDB(ARTIFACT_DB_NAME, ARTIFACT_DB_VERSION);
    await db.put('texts', {
      schema: 'texttrends/stored-text/1',
      hash: 'texthash',
      text: 123, // wrong payload type
    } as never);
    db.close();
    const read = await store.getText('texthash');
    expect(read.kind).toBe('corrupt');
    store.close();
  });

  it('a write failure disables further writes but leaves reads working', async () => {
    const warnings: Warning[] = [];
    const store = await open(warnings);
    await store.putText('kept', 'still readable');
    // Force the next write to fail: stub the underlying db.put.
    const internal = store as unknown as { db: { put: (...a: unknown[]) => Promise<unknown> } };
    const realPut = internal.db.put.bind(internal.db);
    let failNext = true;
    internal.db.put = (...args: unknown[]) => {
      if (failNext) return Promise.reject(new DOMException('quota', 'QuotaExceededError'));
      return realPut(...(args as Parameters<typeof realPut>));
    };
    await store.putText('lost', 'never lands');
    expect(warnings.some((w) => w.code === 'CACHE_WRITE_FAILED')).toBe(true);
    failNext = false;
    await store.putText('also-lost', 'suppressed after first failure');
    expect((await store.getText('lost')).kind).toBe('miss');
    expect((await store.getText('also-lost')).kind).toBe('miss'); // writes stayed off
    expect(await store.getText('kept')).toEqual({ kind: 'hit', value: 'still readable' }); // reads intact
    // The environmental warning fired exactly once.
    expect(warnings.filter((w) => w.code === 'CACHE_WRITE_FAILED').length).toBe(1);
    store.close();
  });

  it('falls back to the in-memory store when IndexedDB is unavailable', async () => {
    globalThis.indexedDB = undefined as never;
    const warnings: Warning[] = [];
    const store = await openArtifactStore((code, message) => warnings.push({ code, message }));
    expect(store).toBeInstanceOf(InMemoryArtifactStore);
    expect(warnings.some((w) => w.code === 'CACHE_UNAVAILABLE')).toBe(true);
    // The fallback still honors full cache semantics for the session.
    await store.putText('texthash', 'in memory');
    expect(await store.getText('texthash')).toEqual({ kind: 'hit', value: 'in memory' });
  });

  it('an open rejected with VersionError falls back to in-memory', async () => {
    // A database already at a higher version rejects a version-1 open
    // immediately (this is NOT the blocked path — that race is below).
    const holder = await openDB(ARTIFACT_DB_NAME, ARTIFACT_DB_VERSION + 1, {
      upgrade(db) {
        db.createObjectStore('texts', { keyPath: ['schema', 'hash'] });
        db.createObjectStore('shards', {
          keyPath: ['artifactSchema', 'textHash', 'recipeHash', 'segmenterHash'],
        });
      },
    });
    const warnings: Warning[] = [];
    const store = await openArtifactStore((code, message) => warnings.push({ code, message }));
    expect(store).toBeInstanceOf(InMemoryArtifactStore);
    expect(warnings.some((w) => w.code === 'CACHE_UNAVAILABLE')).toBe(true);
    holder.close();
  });

  it('a SYNCHRONOUS indexedDB.open throw falls back with a warning, never rejecting', async () => {
    // SecurityError in storage-disabled/opaque contexts throws before any
    // promise exists (review P1) — the factory must still resolve.
    const realIdb = globalThis.indexedDB;
    globalThis.indexedDB = {
      open() {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as typeof indexedDB;
    try {
      const warnings: Warning[] = [];
      const store = await openArtifactStore((code, message) => warnings.push({ code, message }));
      expect(store).toBeInstanceOf(InMemoryArtifactStore);
      expect(warnings.some((w) => w.code === 'CACHE_UNAVAILABLE' && /denied/.test(w.message))).toBe(true);
    } finally {
      globalThis.indexedDB = realIdb;
    }
  });

  it('a PENDING open loses the timeout race; the late connection is closed, not swapped in', async () => {
    // The genuinely-blocked race cannot be produced deterministically with a
    // real IndexedDB, so the opener seam injects a controllable open.
    let closed = 0;
    let releaseOpen: ((db: never) => void) | null = null;
    const lateDb = { close: () => void closed++ };
    const warnings: Warning[] = [];
    const storePromise = openArtifactStore(
      (code, message) => warnings.push({ code, message }),
      30, // the timer must win
      () =>
        new Promise((resolve) => {
          releaseOpen = resolve as never;
        }),
    );
    const store = await storePromise;
    expect(store).toBeInstanceOf(InMemoryArtifactStore);
    expect(warnings.some((w) => w.code === 'CACHE_UNAVAILABLE' && /timed out/.test(w.message))).toBe(true);
    // The store is live in-memory NOW; the real database arriving later must
    // be closed rather than switching stores under a live generation.
    await store.putText('texthash', 'owned by the fallback');
    (releaseOpen as unknown as (db: unknown) => void)(lateDb);
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toBe(1);
    expect(await store.getText('texthash')).toEqual({ kind: 'hit', value: 'owned by the fallback' });
  });

  it('closes after a versionchange and degrades to misses', async () => {
    const warnings: Warning[] = [];
    const store = await open(warnings);
    await store.putText('texthash', 'soon unavailable');
    store.handleVersionChange();
    expect(warnings.some((w) => w.code === 'CACHE_UNAVAILABLE')).toBe(true);
    expect((await store.getText('texthash')).kind).toBe('miss');
    await store.putText('texthash', 'dropped'); // must not throw
  });
});
