/**
 * IndexedDB ArtifactStore — Phase 1 Milestone 5 (plan §b; Codex M5 consult).
 *
 * PROVISIONAL NAMESPACE: the index recipe is still
 * 'texttrends/index-recipe/0-provisional', so every record in this database
 * is disposable by design. The database name carries 'index0-provisional';
 * the trailing 'db1' is the DATABASE LAYOUT version, not IndexRecipeV1.
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
import type { DocumentIndexV1 } from '@texttrends/core';
import type { StorageWarningCodeV4 as StorageWarningCode } from './protocol-v4.ts';
import {
  InMemoryArtifactStore,
  type ArtifactStore,
  type CacheRead,
  type DocumentIndexCacheKey,
  type ExtractionCacheKey,
  type StructureCacheKey,
} from './store.ts';

/**
 * NEW database NAME (not just a version bump): db2 adds the `extractions`
 * and `structures` stores, an ADDITIVE layout change — but the M5 rule
 * (honored for additive stores too, per the ingest/structure consult) is
 * that any layout change to the disposable artifact database opens a new
 * name. The db1 database is simply abandoned (one cold rebuild, no user
 * data); this also avoids a cross-tab upgrade being blocked by an open db1.
 */
export const ARTIFACT_DB_NAME = 'texttrends-artifacts-provisional-db2';
export const ARTIFACT_DB_VERSION = 1;

export type WarnStorage = (code: StorageWarningCode, message: string) => void;

interface StoredTextV1 {
  readonly schema: 'texttrends/stored-text/1';
  readonly hash: string;
  readonly text: string;
}

interface StoredShardV1 {
  readonly schema: 'texttrends/stored-shard/1';
  readonly artifactSchema: 'texttrends/document-index/1';
  readonly textHash: string;
  readonly recipeHash: string;
  readonly segmenterHash: string;
  readonly shard: DocumentIndexV1;
}

interface StoredExtractionV1 {
  readonly schema: 'texttrends/stored-extraction/1';
  readonly artifactSchema: 'texttrends/extraction/1';
  readonly sourceHash: string;
  readonly recipeHash: string;
  readonly artifact: unknown;
}

interface StoredStructureV2 {
  readonly schema: 'texttrends/stored-structure/2';
  readonly artifactSchema: 'texttrends/structure/2';
  readonly textHash: string;
  readonly candidateHash: string;
  readonly recipeHash: string;
  readonly overrideHash: string;
  readonly artifact: unknown;
}

interface ArtifactDb extends DBSchema {
  texts: {
    key: ['texttrends/stored-text/1', string];
    value: StoredTextV1;
  };
  shards: {
    key: ['texttrends/document-index/1', string, string, string];
    value: StoredShardV1;
  };
  extractions: {
    key: ['texttrends/extraction/1', string, string];
    value: StoredExtractionV1;
  };
  structures: {
    key: ['texttrends/structure/2', string, string, string, string];
    value: StoredStructureV2;
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object';

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

function checkExtractionEnvelope(record: unknown, key: ExtractionCacheKey): string | null {
  if (!isRecord(record)) return 'stored extraction is not an object';
  if (record.schema !== 'texttrends/stored-extraction/1') return `unknown stored-extraction schema '${String(record.schema)}'`;
  if (record.artifactSchema !== key.schema) return 'stored extraction artifact-schema disagreement';
  if (record.sourceHash !== key.source || record.recipeHash !== key.recipe) return 'stored extraction key disagreement';
  if (!isRecord(record.artifact)) return 'stored extraction payload is not an object';
  return null;
}

function checkStructureEnvelope(record: unknown, key: StructureCacheKey): string | null {
  if (!isRecord(record)) return 'stored structure is not an object';
  if (record.schema !== 'texttrends/stored-structure/2') return `unknown stored-structure schema '${String(record.schema)}'`;
  if (record.artifactSchema !== key.schema) return 'stored structure artifact-schema disagreement';
  if (
    record.textHash !== key.text || record.candidateHash !== key.candidates ||
    record.recipeHash !== key.recipe || record.overrideHash !== key.override
  ) {
    return 'stored structure key disagreement';
  }
  if (!isRecord(record.artifact)) return 'stored structure payload is not an object';
  return null;
}

export class IdbArtifactStore implements ArtifactStore {
  private readonly warn: WarnStorage;
  private db: IDBPDatabase<ArtifactDb> | null;
  /** After a quota (or any) write failure, further writes are suppressed for
   *  the session; reads keep working — the open database is still valid. */
  private writesDisabled = false;
  private readonly warnedOnce = new Set<StorageWarningCode>();

  constructor(db: IDBPDatabase<ArtifactDb>, warn: WarnStorage) {
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

  private async write(op: (db: IDBPDatabase<ArtifactDb>) => Promise<unknown>): Promise<void> {
    if (!this.db || this.writesDisabled) return;
    try {
      await op(this.db);
    } catch (e) {
      this.writesDisabled = true;
      this.warnOnce(
        'CACHE_WRITE_FAILED',
        `cache write failed (persistence disabled for this session; results unaffected): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  getText(hash: string): Promise<CacheRead<string>> {
    return this.read(
      (db) => db.get('texts', ['texttrends/stored-text/1', hash]),
      (record) => {
        const reason = checkTextEnvelope(record, hash);
        return reason === null
          ? { kind: 'hit', value: (record as StoredTextV1).text }
          : { kind: 'corrupt', reason };
      },
    );
  }

  putText(hash: string, text: string): Promise<void> {
    const record: StoredTextV1 = { schema: 'texttrends/stored-text/1', hash, text };
    return this.write((db) => db.put('texts', record));
  }

  deleteText(hash: string): Promise<void> {
    // Deletion is corruption REPAIR, not eviction — it must not be gated by
    // writesDisabled, or a corrupt record would warn forever. Best-effort.
    if (!this.db) return Promise.resolve();
    return this.db.delete('texts', ['texttrends/stored-text/1', hash]).catch(() => undefined);
  }

  getShard(key: DocumentIndexCacheKey): Promise<CacheRead<unknown>> {
    return this.read(
      (db) => db.get('shards', [key.schema, key.text, key.recipe, key.segmenter]),
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
    return this.write((db) => db.put('shards', record));
  }

  deleteShard(key: DocumentIndexCacheKey): Promise<void> {
    if (!this.db) return Promise.resolve();
    return this.db
      .delete('shards', [key.schema, key.text, key.recipe, key.segmenter])
      .catch(() => undefined);
  }

  getExtraction(key: ExtractionCacheKey): Promise<CacheRead<unknown>> {
    return this.read(
      (db) => db.get('extractions', [key.schema, key.source, key.recipe]),
      (record) => {
        const reason = checkExtractionEnvelope(record, key);
        return reason === null ? { kind: 'hit', value: (record as StoredExtractionV1).artifact } : { kind: 'corrupt', reason };
      },
    );
  }
  putExtraction(key: ExtractionCacheKey, artifact: unknown): Promise<void> {
    const record: StoredExtractionV1 = {
      schema: 'texttrends/stored-extraction/1',
      artifactSchema: key.schema,
      sourceHash: key.source,
      recipeHash: key.recipe,
      artifact,
    };
    return this.write((db) => db.put('extractions', record));
  }
  deleteExtraction(key: ExtractionCacheKey): Promise<void> {
    if (!this.db) return Promise.resolve();
    return this.db.delete('extractions', [key.schema, key.source, key.recipe]).catch(() => undefined);
  }

  getStructure(key: StructureCacheKey): Promise<CacheRead<unknown>> {
    return this.read(
      (db) => db.get('structures', [key.schema, key.text, key.candidates, key.recipe, key.override]),
      (record) => {
        const reason = checkStructureEnvelope(record, key);
        return reason === null ? { kind: 'hit', value: (record as StoredStructureV2).artifact } : { kind: 'corrupt', reason };
      },
    );
  }
  putStructure(key: StructureCacheKey, artifact: unknown): Promise<void> {
    const record: StoredStructureV2 = {
      schema: 'texttrends/stored-structure/2',
      artifactSchema: key.schema,
      textHash: key.text,
      candidateHash: key.candidates,
      recipeHash: key.recipe,
      overrideHash: key.override,
      artifact,
    };
    return this.write((db) => db.put('structures', record));
  }
  deleteStructure(key: StructureCacheKey): Promise<void> {
    if (!this.db) return Promise.resolve();
    return this.db
      .delete('structures', [key.schema, key.text, key.candidates, key.recipe, key.override])
      .catch(() => undefined);
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
 * generation. This factory NEVER rejects — the fallback is the answer.
 *
 * `opener` is an injection seam for the pending-open race, which cannot be
 * produced deterministically with a real IndexedDB.
 */
export async function openArtifactStore(
  warn: WarnStorage,
  blockedTimeoutMs = 2000,
  opener?: () => Promise<IDBPDatabase<ArtifactDb>>,
): Promise<ArtifactStore> {
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
        const store = new IdbArtifactStore(db, warn);
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
      db.createObjectStore('texts', { keyPath: ['schema', 'hash'] });
      db.createObjectStore('shards', {
        keyPath: ['artifactSchema', 'textHash', 'recipeHash', 'segmenterHash'],
      });
      db.createObjectStore('extractions', {
        keyPath: ['artifactSchema', 'sourceHash', 'recipeHash'],
      });
      db.createObjectStore('structures', {
        keyPath: ['artifactSchema', 'textHash', 'candidateHash', 'recipeHash', 'overrideHash'],
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
