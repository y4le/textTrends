/**
 * IndexedDB ArtifactStore — Phase 1 Milestone 5 (plan §b; Codex M5 consult).
 *
 * PROVISIONAL NAMESPACE: the index recipe is still
 * 'texttrends/index-recipe/0-provisional', so every record in this database
 * is disposable by design. The database name's trailing 'db5' is the DATABASE
 * LAYOUT version, not IndexRecipeV1.
 * Recipe graduation opens a NEW database name and never reads provisional
 * records as canonical — there will never be a migration of these records.
 *
 * Boundary discipline:
 * - The adapter shallow-validates its own storage envelope (record shape,
 *   schema tags, key agreement) and reports 'corrupt' with a reason; the
 *   ENGINE remains the authority for artifact ABI/semantic admission.
 * - One short transaction per get/put/delete; all CPU work happens outside
 *   transactions (IDB transactions auto-close when control leaves the
 *   request chain).
 * - Storage failure is never fatal to analysis: an open failure falls back
 *   to the in-memory store (factory below); a quota/write failure disables
 *   further writes but keeps reads; a read failure degrades to a miss.
 *   Each environmental failure class warns ONCE per worker session.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { isRecord } from '@texttrends/core';
import type { DocumentIndexV1 } from '@texttrends/core';
import type { StorageWarningCodeV4 as StorageWarningCode } from './protocol-v4.ts';
import {
  InMemoryArtifactStore,
  type ArtifactStore,
  type CacheRead,
  type DocumentIndexCacheKey,
  type ExtractionCacheKey,
} from './store.ts';
import { ARTIFACT_DB_NAME, ARTIFACT_DB_VERSION } from '../shared/storage-schema.ts';

export { ARTIFACT_DB_NAME, ARTIFACT_DB_VERSION } from '../shared/storage-schema.ts';

export type WarnStorage = (code: StorageWarningCode, message: string) => void;

interface StoredTextV1 {
  readonly schema: 'texttrends/stored-text/1';
  readonly hash: string;
  readonly text: string;
}

interface StoredExtractionV1 {
  readonly schema: 'texttrends/stored-extraction/1';
  readonly sourceHash: string;
  readonly recipeHash: string;
  readonly textHash: string;
}

interface StoredShardV1 {
  readonly schema: 'texttrends/stored-shard/1';
  readonly artifactSchema: 'texttrends/document-index/1';
  readonly textHash: string;
  readonly recipeHash: string;
  readonly segmenterHash: string;
  readonly shard: DocumentIndexV1;
}

export const ARTIFACT_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export const ARTIFACT_CACHE_MAX_ENTRIES = 1536;
export interface ArtifactCachePolicy { readonly maxBytes: number; readonly maxEntries: number }
const DEFAULT_CACHE_POLICY: ArtifactCachePolicy = { maxBytes: ARTIFACT_CACHE_MAX_BYTES, maxEntries: ARTIFACT_CACHE_MAX_ENTRIES };
function validateCachePolicy(policy: ArtifactCachePolicy): void {
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0 || policy.maxBytes > ARTIFACT_CACHE_MAX_BYTES
    || !Number.isSafeInteger(policy.maxEntries) || policy.maxEntries <= 0 || policy.maxEntries > ARTIFACT_CACHE_MAX_ENTRIES) throw new RangeError('artifact cache policy may only reduce the positive hard bounds');
}
type ArtifactTable = 'texts' | 'shards' | 'extractions';
interface CacheEntry {
  readonly id: string;
  readonly store: ArtifactTable;
  readonly key: readonly string[];
  readonly bytes: number;
  readonly usedAt: number;
}
function entryId(store: ArtifactTable, key: readonly string[]): string { return JSON.stringify([store, ...key]); }
function validCacheEntry(value: unknown): value is CacheEntry {
  if (!isRecord(value) || !['texts', 'shards', 'extractions'].includes(String(value.store))
    || !Array.isArray(value.key) || !value.key.every((key) => typeof key === 'string' && key.length <= 256)
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0
    || !Number.isSafeInteger(value.usedAt) || (value.usedAt as number) < 0) return false;
  const store = value.store as ArtifactTable;
  const count = store === 'texts' ? 2 : store === 'extractions' ? 3 : 4;
  return value.key.length === count && value.id === entryId(store, value.key as string[]);
}
/** Conservative payload accounting; no JSON expansion of typed arrays. */
function shardBytes(shard: DocumentIndexV1): number {
  let bytes = 256;
  for (const value of Object.values(shard)) {
    if (ArrayBuffer.isView(value)) bytes += value.byteLength;
  }
  if (Array.isArray(shard.vocabulary)) for (const key of shard.vocabulary) bytes += 16 + key.length * 2;
  if (shard.postings) for (const value of Object.values(shard.postings)) if (ArrayBuffer.isView(value)) bytes += value.byteLength;
  return bytes;
}

interface ArtifactDb extends DBSchema {
  entries: { key: string; value: CacheEntry; indexes: { usedAt: number } };
  extractions: {
    key: ['texttrends/stored-extraction/1', string, string];
    value: StoredExtractionV1;
  };
  texts: {
    key: ['texttrends/stored-text/1', string];
    value: StoredTextV1;
  };
  shards: {
    key: ['texttrends/document-index/1', string, string, string];
    value: StoredShardV1;
  };
}


/** Shallow storage-envelope validation for a text record. */
function checkTextEnvelope(record: unknown, hash: string): string | null {
  if (!isRecord(record)) return 'stored text is not an object';
  if (record.schema !== 'texttrends/stored-text/1') return `unknown stored-text schema '${String(record.schema)}'`;
  if (record.hash !== hash) return 'stored text key disagreement';
  if (typeof record.text !== 'string') return 'stored text payload is not a string';
  return null;
}

/** Shallow storage-envelope validation for a shard record. */
function checkShardEnvelope(record: unknown, key: DocumentIndexCacheKey): string | null {
  if (!isRecord(record)) return 'stored shard is not an object';
  if (record.schema !== 'texttrends/stored-shard/1') return `unknown stored-shard schema '${String(record.schema)}'`;
  if (record.artifactSchema !== key.schema) return 'stored shard artifact-schema disagreement';
  if (record.textHash !== key.text || record.recipeHash !== key.recipe || record.segmenterHash !== key.segmenter) {
    return 'stored shard key disagreement';
  }
  if (!isRecord(record.shard)) return 'stored shard payload is not an object';
  return null;
}

export class IdbArtifactStore implements ArtifactStore {
  private readonly warn: WarnStorage;
  private db: IDBPDatabase<ArtifactDb> | null;
  /** After a quota (or any) write failure, further writes are suppressed for
   *  the session; reads keep working — the open database is still valid. */
  private writesDisabled = false;
  private writing: Promise<void> = Promise.resolve();
  private accessClock = 0;
  private readonly warnedOnce = new Set<StorageWarningCode>();

  constructor(db: IDBPDatabase<ArtifactDb>, warn: WarnStorage, private readonly policy: ArtifactCachePolicy = DEFAULT_CACHE_POLICY) {
    validateCachePolicy(policy);
    this.db = db;
    this.warn = warn;
  }

  private warnOnce(code: StorageWarningCode, message: string): void {
    if (this.warnedOnce.has(code)) return;
    this.warnedOnce.add(code);
    this.warn(code, message);
  }

  private async read<T>(
    fetch: (db: IDBPDatabase<ArtifactDb>) => Promise<unknown>,
    admit: (record: unknown) => CacheRead<T>,
  ): Promise<CacheRead<T>> {
    if (!this.db) return { kind: 'miss' };
    let record: unknown;
    try {
      record = await fetch(this.db);
    } catch (e) {
      // A failed read (terminated connection, tx abort) degrades to a miss:
      // the artifact is recomputable and a rebuild is always safe.
      this.warnOnce('CACHE_READ_FAILED', `cache read failed: ${e instanceof Error ? e.message : String(e)}`);
      return { kind: 'miss' };
    }
    if (record === undefined) return { kind: 'miss' };
    return admit(record);
  }

  private write(op: (db: IDBPDatabase<ArtifactDb>) => Promise<unknown>): Promise<void> {
    const run = this.writing.then(async () => {
      if (!this.db || this.writesDisabled) return;
      try { await op(this.db); }
      catch (error) {
        this.writesDisabled = true;
        this.warnOnce('CACHE_WRITE_FAILED', `cache write failed (persistence disabled for this session; results unaffected): ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    this.writing = run;
    return run;
  }

  private stamp(): number { return this.accessClock = Math.max(Date.now(), this.accessClock + 1); }

  private touch(store: ArtifactTable, key: readonly string[]): void {
    void this.write(async (db) => {
      const tx = db.transaction('entries', 'readwrite');
      const entry = await tx.store.get(entryId(store, key));
      const newest = await tx.store.index('usedAt').openCursor(null, 'prev');
      if (newest && validCacheEntry(newest.value)) this.accessClock = Math.max(this.accessClock, newest.value.usedAt);
      if (validCacheEntry(entry)) await tx.store.put({ ...entry, usedAt: this.stamp() });
      await tx.done;
    });
  }

  /** Payload and eviction metadata commit atomically. Only metadata is read
   * during pruning; resident shards are never cloned merely to measure them. */
  private putRecord(store: ArtifactTable, key: readonly string[], record: StoredTextV1 | StoredShardV1 | StoredExtractionV1, bytes: number): Promise<void> {
    return this.write(async (db) => {
      const tx = db.transaction(['texts', 'shards', 'extractions', 'entries'], 'readwrite');
      const id = entryId(store, key);
      const storedEntries = await tx.objectStore('entries').getAll();
      const tables = ['texts', 'shards', 'extractions'] as const;
      const counts = await Promise.all(tables.map((table) => tx.objectStore(table).count()));
      let entries: CacheEntry[];
      if (storedEntries.some((entry) => !validCacheEntry(entry))
        || tables.some((table, index) => counts[index] !== storedEntries.filter((entry) => entry.store === table).length)) {
        // A damaged ledger cannot account for its payloads: discard only the
        // recomputable cache, then admit the current write into a fresh ledger.
        for (const table of ['texts', 'shards', 'extractions', 'entries'] as const) await tx.objectStore(table).clear();
        this.warnOnce('CACHE_CORRUPT', 'cache accounting was damaged; disposable artifacts were cleared');
        entries = [];
      } else entries = storedEntries.filter((entry) => entry.id !== id);
      this.accessClock = entries.reduce((clock, entry) => Math.max(clock, entry.usedAt), this.accessClock);
      let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      let count = entries.length;
      await tx.objectStore(store).delete(key as never);
      await tx.objectStore('entries').delete(id);
      if (bytes <= this.policy.maxBytes) {
        entries.sort((left, right) => left.usedAt - right.usedAt || left.id.localeCompare(right.id));
        for (const victim of entries) {
          if (total + bytes <= this.policy.maxBytes && count + 1 <= this.policy.maxEntries) break;
          await tx.objectStore(victim.store).delete(victim.key as never);
          await tx.objectStore('entries').delete(victim.id);
          total -= victim.bytes;
          count--;
        }
        await tx.objectStore(store).put(record as never);
        await tx.objectStore('entries').put({ id, store, key, bytes, usedAt: this.stamp() });
      }
      await tx.done;
    });
  }

  private deleteRecord(store: ArtifactTable, key: readonly string[]): Promise<void> {
    // Corruption repair stays available even when cache writes are disabled.
    const run = this.writing.then(async () => {
      if (!this.db) return;
      const tx = this.db.transaction([store, 'entries'], 'readwrite');
      await tx.objectStore(store).delete(key as never);
      await tx.objectStore('entries').delete(entryId(store, key));
      await tx.done;
    }).catch(() => {});
    this.writing = run;
    return run;
  }

  getText(hash: string): Promise<CacheRead<string>> {
    return this.read(
      async (db) => {
        const key = ['texttrends/stored-text/1', hash];
        const record = await db.get('texts', key as never);
        if (record !== undefined) this.touch('texts', key);
        return record;
      },
      (record) => {
        const reason = checkTextEnvelope(record, hash);
        return reason === null
          ? { kind: 'hit', value: (record as StoredTextV1).text }
          : { kind: 'corrupt', reason };
      },
    );
  }

  getExtraction(key: ExtractionCacheKey): Promise<CacheRead<string>> {
    return this.read(
      async (db) => {
        const id = ['texttrends/stored-extraction/1', key.source, key.recipe];
        const record = await db.get('extractions', id as never);
        if (record !== undefined) this.touch('extractions', id);
        return record;
      },
      (record) => {
        if (!isRecord(record) || record.schema !== 'texttrends/stored-extraction/1'
          || record.sourceHash !== key.source || record.recipeHash !== key.recipe
          || typeof record.textHash !== 'string' || !/^[0-9a-f]{64}$/u.test(record.textHash)) {
          return { kind: 'corrupt', reason: 'stored extraction identity is invalid' };
        }
        return { kind: 'hit', value: record.textHash };
      },
    );
  }

  putExtraction(key: ExtractionCacheKey, textHash: string): Promise<void> {
    const record: StoredExtractionV1 = {
      schema: 'texttrends/stored-extraction/1', sourceHash: key.source,
      recipeHash: key.recipe, textHash,
    };
    return this.putRecord('extractions', ['texttrends/stored-extraction/1', key.source, key.recipe], record, 384);
  }

  deleteExtraction(key: ExtractionCacheKey): Promise<void> {
    return this.deleteRecord('extractions', ['texttrends/stored-extraction/1', key.source, key.recipe]);
  }

  putText(hash: string, text: string): Promise<void> {
    const record: StoredTextV1 = { schema: 'texttrends/stored-text/1', hash, text };
    return this.putRecord('texts', ['texttrends/stored-text/1', hash], record, 128 + text.length * 2);
  }

  deleteText(hash: string): Promise<void> {
    return this.deleteRecord('texts', ['texttrends/stored-text/1', hash]);
  }

  getShard(key: DocumentIndexCacheKey): Promise<CacheRead<unknown>> {
    return this.read(
      async (db) => {
        const id = [key.schema, key.text, key.recipe, key.segmenter];
        const record = await db.get('shards', id as never);
        if (record !== undefined) this.touch('shards', id);
        return record;
      },
      (record) => {
        const reason = checkShardEnvelope(record, key);
        return reason === null
          ? { kind: 'hit', value: (record as StoredShardV1).shard }
          : { kind: 'corrupt', reason };
      },
    );
  }

  putShard(key: DocumentIndexCacheKey, shard: DocumentIndexV1): Promise<void> {
    const record: StoredShardV1 = {
      schema: 'texttrends/stored-shard/1',
      artifactSchema: key.schema,
      textHash: key.text,
      recipeHash: key.recipe,
      segmenterHash: key.segmenter,
      shard,
    };
    return this.putRecord('shards', [key.schema, key.text, key.recipe, key.segmenter], record, shardBytes(shard));
  }

  deleteShard(key: DocumentIndexCacheKey): Promise<void> {
    return this.deleteRecord('shards', [key.schema, key.text, key.recipe, key.segmenter]);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /** versionchange from another context: close so the other context can
   *  proceed; this session degrades to misses (recomputable artifacts). */
  handleVersionChange(): void {
    this.warnOnce('CACHE_UNAVAILABLE', 'cache closed: the database was upgraded by another context');
    this.close();
  }
}

/**
 * Open the persistent store, falling back to in-memory on ANY open failure
 * (private mode, quota, blocked upgrade, missing IndexedDB — including a
 * SYNCHRONOUS throw from indexedDB.open in storage-disabled contexts). A
 * blocked open must never stall generation processing, so the open races a
 * bounded timer; if the real database arrives after the fallback won, the
 * late connection is CLOSED rather than switching stores under a live
 * generation. Environmental failures never reject; invalid policy is a
 * programming error and rejects before any database is opened.
 *
 * `opener` is an injection seam for the pending-open race, which cannot be
 * produced deterministically with a real IndexedDB.
 */
export async function openArtifactStore(
  warn: WarnStorage,
  blockedTimeoutMs = 2000,
  opener?: () => Promise<IDBPDatabase<ArtifactDb>>,
  policy: ArtifactCachePolicy = DEFAULT_CACHE_POLICY,
): Promise<ArtifactStore> {
  validateCachePolicy(policy);
  if (typeof indexedDB === 'undefined') {
    warn('CACHE_UNAVAILABLE', 'IndexedDB is not available; results are not persisted');
    return new InMemoryArtifactStore();
  }
  let settled = false;
  return new Promise<ArtifactStore>((resolve) => {
    const fallBack = (message: string): void => {
      if (settled) return;
      settled = true;
      warn('CACHE_UNAVAILABLE', message);
      resolve(new InMemoryArtifactStore());
    };
    const timer = setTimeout(
      () => fallBack('cache open timed out (blocked by another context?); results are not persisted'),
      blockedTimeoutMs,
    );
    // idb calls indexedDB.open SYNCHRONOUSLY before returning its promise —
    // a sync throw (e.g. SecurityError in an opaque origin) must take the
    // same fallback path, never reject this factory (review finding P1).
    let opening: Promise<IDBPDatabase<ArtifactDb>>;
    try {
      opening = (opener ?? defaultOpen)();
    } catch (e) {
      clearTimeout(timer);
      fallBack(`cache unavailable (${e instanceof Error ? e.message : String(e)}); results are not persisted`);
      return;
    }
    opening.then(
      (db) => {
        clearTimeout(timer);
        if (settled) {
          db.close(); // fallback already won — never swap stores mid-generation
          return;
        }
        settled = true;
        const store = new IdbArtifactStore(db, warn, policy);
        db.addEventListener('versionchange', () => store.handleVersionChange());
        resolve(store);
      },
      (e) => {
        clearTimeout(timer);
        fallBack(`cache unavailable (${e instanceof Error ? e.message : String(e)}); results are not persisted`);
      },
    );
  });
}

function defaultOpen(): Promise<IDBPDatabase<ArtifactDb>> {
  return openDB<ArtifactDb>(ARTIFACT_DB_NAME, ARTIFACT_DB_VERSION, {
    upgrade(db) {
      // Layout version 1: creation only. A future layout bump opens a NEW
      // database name — provisional records are never migrated.
      db.createObjectStore('entries', { keyPath: 'id' }).createIndex('usedAt', 'usedAt');
      db.createObjectStore('texts', { keyPath: ['schema', 'hash'] });
      db.createObjectStore('extractions', { keyPath: ['schema', 'sourceHash', 'recipeHash'] });
      db.createObjectStore('shards', {
        keyPath: ['artifactSchema', 'textHash', 'recipeHash', 'segmenterHash'],
      });
    },
    blocked() {
      // Keep waiting until the timer decides; the other tab may close.
    },
    terminated() {
      // Browser force-closed the connection; per-op catches degrade reads
      // to misses and disable writes from here on.
    },
  });
}
