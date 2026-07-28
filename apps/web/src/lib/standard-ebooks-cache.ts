/**
 * IndexedDB acquisition cache for Standard Ebooks INGESTION ARCHIVES — the
 * write-through layer behind `standard-ebooks.ts`'s `downloadEbookArchive`.
 *
 * WHAT IS CACHED: only the assembled deterministic ingestion-archive bytes
 * (the `.epub`-shaped ZIP the archive subpath produces) plus minimal metadata
 * — never per-file GitHub responses, and never anything the project system
 * owns. This cache is an acquisition ACCELERATOR for repeated adds, retries,
 * and offline fallback; the project system stays authoritative for imported
 * sources, and the ingest pipeline revalidates everything downstream — the
 * cache never mints or bypasses any proof (the stored digest detects local
 * storage corruption, not remote authenticity).
 *
 * DATABASE: a NEW disposable app-owned database (`…-cache-v1`), unrelated to
 * the worker's artifact db2 and the durable user-data database — neither is
 * ever touched from here. One `archives` store under a structured compound
 * key, an index on `lastAccessedAt` for byte-weighted LRU eviction, and a
 * `meta` ledger record carrying the byte total, maintained in the SAME
 * transaction as every put/delete/eviction.
 *
 * POLICY: cache-first with a 24-hour TTL. A verified fresh hit answers with
 * NO network and NO archive-chunk import (this module is itself dynamically
 * imported by the facade, and the `@texttrends/standard-ebooks/archive`
 * dynamic import happens only on miss/refresh — the build-shape e2e test in
 * catalog.spec.ts holds both). After expiry the network is retried; on a
 * TRANSIENT failure (network error, rate limit, 408/timeout, 5xx) a
 * previously integrity-verified stale entry is returned instead — never on
 * caller abort, invalid input, cap trips, malformed content, or a definitive
 * 4xx. Every read recomputes SHA-256 over the stored bytes before returning
 * them; any envelope or digest mismatch is best-effort deleted and treated
 * as a miss. Cache failure of any kind must never fail a successful add:
 * open/read/touch failures degrade to misses, quota pressure evicts from
 * THIS cache and ultimately degrades to uncached downloads for the session.
 */

import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { isNonNegSafeInt, isRecord, isString } from '@texttrends/core';

export const SE_ARCHIVE_CACHE_DB_NAME = 'texttrends-standard-ebooks-cache-v1';
export const SE_ARCHIVE_CACHE_DB_VERSION = 1;
export const SE_ARCHIVE_CACHE_SCHEMA = 'texttrends/se-archive-cache/1';
/**
 * The construction recipe of the cached bytes. The library's archive module
 * documents that identical inputs produce byte-identical archives and that
 * any recipe change (member order, timestamps, container bytes) must be
 * versioned — bump THIS literal when the library's archive recipe changes.
 */
export const SE_ARCHIVE_RECIPE = 'se-ingest-archive/1';
export const SE_ARCHIVE_FRESH_TTL_MS = 24 * 60 * 60 * 1000;
export const SE_ARCHIVE_CACHE_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const SE_ARCHIVE_CACHE_LEDGER_KEY = 'ledger';

/**
 * Production source coordinates. The facade exposes no origin/org/ref knobs,
 * so these hardcode the DEFAULTS of `downloadEbookArchive` in
 * `@texttrends/standard-ebooks/src/archive.ts` (`githubRawBase`,
 * `githubOrganization`, `ref`). If the library defaults ever change, these
 * must change with them — old entries then simply miss (different key) and
 * age out via LRU; there is no migration of a disposable cache.
 */
export const SE_SOURCE_ORIGIN = 'https://raw.githubusercontent.com';
export const SE_ORGANIZATION = 'standardebooks';
export const SE_REF = 'master';

const LEDGER_SCHEMA = 'texttrends/se-archive-cache-ledger/1';
const DIGEST_HEX = /^[0-9a-f]{64}$/u;
/** Mirrors REPOSITORY_NAME in `@texttrends/standard-ebooks` (repository-name.ts). */
const REPOSITORY_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const OPEN_TIMEOUT_MS = 2000;
/** Canonicalized once, by construction — the key component is URL#origin. */
const CANONICAL_SOURCE_ORIGIN = new URL(SE_SOURCE_ORIGIN).origin;

export interface EbookArchivePayload {
  readonly bytes: Uint8Array;
  readonly title: string;
}

/** The network path. Receives the caller's signal; the archive-chunk dynamic
 *  import lives inside the production implementation, so a fresh cache hit
 *  never loads it. */
export type EbookArchiveDownloader = (
  name: string,
  signal: AbortSignal | undefined,
) => Promise<EbookArchivePayload>;

/** Compound cache key: [cacheSchema, sourceOrigin, organization,
 *  repositoryName, ref, archiveRecipe]. */
export type ArchiveCacheKey = [string, string, string, string, string, string];

export interface StoredEbookArchiveV1 {
  readonly cacheSchema: typeof SE_ARCHIVE_CACHE_SCHEMA;
  readonly sourceOrigin: string;
  readonly organization: string;
  readonly repositoryName: string;
  readonly ref: string;
  readonly archiveRecipe: typeof SE_ARCHIVE_RECIPE;
  /** Validated title from the archive's parsed OPF — lets a hit answer
   *  `{ bytes, title }` without loading the library at all. */
  readonly title: string;
  readonly byteLength: number;
  readonly fetchedAt: number;
  readonly lastAccessedAt: number;
  /** 64-hex SHA-256 over `bytes` — storage-corruption detection only. */
  readonly digest: string;
  /** An EXACT ArrayBuffer slice — never a view retaining a larger buffer. */
  readonly bytes: ArrayBuffer;
}

interface ArchiveCacheLedgerV1 {
  readonly schema: typeof LEDGER_SCHEMA;
  readonly totalBytes: number;
}

export interface StandardEbooksArchiveCacheDb extends DBSchema {
  archives: {
    key: ArchiveCacheKey;
    value: StoredEbookArchiveV1;
    indexes: { lastAccessedAt: number };
  };
  meta: {
    key: string;
    value: ArchiveCacheLedgerV1;
  };
}

type CacheDatabase = IDBPDatabase<StandardEbooksArchiveCacheDb>;
type CacheWriteTx = IDBPTransaction<StandardEbooksArchiveCacheDb, ('archives' | 'meta')[], 'readwrite'>;

/** Abort surfaced by the cache itself — carries the library's ABORTED code so
 *  the facade maps it identically to a library abort. */
class CacheAbortedError extends Error {
  readonly code = 'ABORTED';
  constructor() {
    super('Standard Ebooks download aborted');
    this.name = 'CacheAbortedError';
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CacheAbortedError();
}

function isAbortShaped(error: unknown): boolean {
  return (
    (isRecord(error) && error.code === 'ABORTED') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/**
 * Stale-fallback eligibility. TRANSIENT: NETWORK_ERROR (offline, DNS,
 * transport drop), RATE_LIMITED (429 / rate-limit 403 — a retry-later
 * condition), and HTTP_ERROR with 408 or a 5xx status. Everything else is
 * DEFINITIVE and must never be papered over with a stale copy: ABORTED
 * (handled separately, before this check), CAP_EXCEEDED, INVALID_RESPONSE,
 * INVALID_EPUB, INVALID_REPOSITORY, and definitive 4xx statuses.
 */
function isTransientFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === 'NETWORK_ERROR' || error.code === 'RATE_LIMITED') return true;
  if (error.code !== 'HTTP_ERROR') return false;
  const status = error.status;
  return status === 408 || status === 429 || (typeof status === 'number' && status >= 500);
}

function isQuotaError(error: unknown): boolean {
  return isRecord(error) && (error as { name?: unknown }).name === 'QuotaExceededError';
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Every component validated/canonicalized BEFORE any transaction opens; an
 *  invalid repository name bypasses the cache entirely (the library then
 *  rejects it with its own INVALID_REPOSITORY). */
function cacheKeyFor(name: string): ArchiveCacheKey | null {
  if (!REPOSITORY_NAME.test(name)) return null;
  return [SE_ARCHIVE_CACHE_SCHEMA, CANONICAL_SOURCE_ORIGIN, SE_ORGANIZATION, name, SE_REF, SE_ARCHIVE_RECIPE];
}

function keysEqual(candidate: unknown, key: ArchiveCacheKey): boolean {
  return Array.isArray(candidate) && candidate.length === key.length && key.every((c, i) => candidate[i] === c);
}

/** The bytes a record actually occupies — ledger accounting uses the ACTUAL
 *  stored buffer length, immune to a lying `byteLength` field. */
function storedByteSize(record: unknown): number {
  return isRecord(record) && record.bytes instanceof ArrayBuffer ? record.bytes.byteLength : 0;
}

/**
 * Full envelope validation: key-field agreement, schema/recipe
 * discriminators, metadata shape, and exact length agreement between the
 * `byteLength` field and the stored buffer. The digest itself is recomputed
 * separately (it is async).
 */
function validStoredArchive(record: unknown, key: ArchiveCacheKey): record is StoredEbookArchiveV1 {
  if (!isRecord(record)) return false;
  if (
    record.cacheSchema !== key[0] ||
    record.sourceOrigin !== key[1] ||
    record.organization !== key[2] ||
    record.repositoryName !== key[3] ||
    record.ref !== key[4] ||
    record.archiveRecipe !== key[5]
  ) {
    return false;
  }
  if (!isString(record.title)) return false;
  if (!(record.bytes instanceof ArrayBuffer)) return false;
  if (!isNonNegSafeInt(record.byteLength) || record.byteLength !== record.bytes.byteLength) return false;
  if (typeof record.fetchedAt !== 'number' || !Number.isFinite(record.fetchedAt)) return false;
  if (typeof record.lastAccessedAt !== 'number' || !Number.isFinite(record.lastAccessedAt)) return false;
  if (!isString(record.digest) || !DIGEST_HEX.test(record.digest)) return false;
  return true;
}

/** Swallow the tx.done rejection and abort — an intentionally discarded
 *  transaction must not surface an unhandled rejection. */
function discardTx(tx: { abort(): void; readonly done: Promise<void> }): void {
  tx.done.catch(() => undefined);
  try {
    tx.abort();
  } catch {
    // already aborted/finished
  }
}

/**
 * Arm a mutation transaction against the caller's signal: an abort landing at
 * ANY point while the transaction is alive — including between the final put
 * and the auto-commit — synchronously aborts it, so no mutation of an aborted
 * operation ever commits. Returns a release function that MUST run after the
 * transaction settles (success or failure) to detach the listener.
 */
function guardTx(
  tx: { abort(): void; readonly done: Promise<void> },
  signal: AbortSignal | undefined,
): () => void {
  tx.done.catch(() => undefined);
  if (signal === undefined) return () => undefined;
  const onAbort = (): void => {
    try {
      tx.abort();
    } catch {
      // already committed/aborted
    }
  };
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/** The default (production) opener. Exported for tests that plant or inspect
 *  records through the real schema. */
export function openStandardEbooksArchiveCacheDb(): Promise<CacheDatabase> {
  return openDB<StandardEbooksArchiveCacheDb>(SE_ARCHIVE_CACHE_DB_NAME, SE_ARCHIVE_CACHE_DB_VERSION, {
    upgrade(db) {
      const archives = db.createObjectStore('archives', {
        keyPath: ['cacheSchema', 'sourceOrigin', 'organization', 'repositoryName', 'ref', 'archiveRecipe'],
      });
      archives.createIndex('lastAccessedAt', 'lastAccessedAt');
      db.createObjectStore('meta');
    },
  });
}

export interface StandardEbooksArchiveCacheOptions {
  /** Injectable clock (freshness + LRU stamps). Defaults to Date.now. */
  readonly now?: () => number;
  /** Injectable database opener (tests wrap the real one with failure seams). */
  readonly open?: () => Promise<CacheDatabase>;
  /** Byte cap for the whole cache. Defaults to 128 MiB. */
  readonly maxTotalBytes?: number;
  /** Bound on a (theoretically) blocked open — never stall an add. */
  readonly openTimeoutMs?: number;
}

export class StandardEbooksArchiveCache {
  private readonly now: () => number;
  private readonly open: () => Promise<CacheDatabase>;
  private readonly maxTotalBytes: number;
  private readonly openTimeoutMs: number;
  private dbPromise: Promise<CacheDatabase | null> | null = null;
  /** After quota pressure survives aggressive eviction + one retry, writes
   *  degrade to uncached for the session; reads keep working. */
  private uncachedWrites = false;

  constructor(options: StandardEbooksArchiveCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.open = options.open ?? openStandardEbooksArchiveCacheDb;
    this.maxTotalBytes = options.maxTotalBytes ?? SE_ARCHIVE_CACHE_MAX_TOTAL_BYTES;
    this.openTimeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS;
  }

  /**
   * Cache-first download. The signal is checked after EVERY await; an abort
   * rejects with an ABORTED-coded error, never falls back to a stale entry,
   * and never lets a write or touch survive.
   */
  async download(
    name: string,
    download: EbookArchiveDownloader,
    signal?: AbortSignal,
  ): Promise<EbookArchivePayload> {
    throwIfAborted(signal);
    const key = cacheKeyFor(name);
    let db: CacheDatabase | null = null;
    let cached: StoredEbookArchiveV1 | null = null;
    if (key !== null) {
      db = await this.database();
      throwIfAborted(signal);
      if (db !== null) {
        cached = await this.readVerified(db, key, signal);
        throwIfAborted(signal);
        if (cached !== null && this.isFresh(cached.fetchedAt)) {
          // Verified fresh hit: no network, no archive chunk.
          await this.touch(db, key, cached.digest, signal);
          throwIfAborted(signal);
          return { bytes: new Uint8Array(cached.bytes), title: cached.title };
        }
      }
    }
    const fetchedAt = this.now(); // as-of the network attempt's START (latest-wins ordering)
    let payload: EbookArchivePayload;
    try {
      payload = await download(name, signal);
    } catch (error) {
      if (isAbortShaped(error)) throw error; // a genuine abort keeps its shape
      // Caller cancellation takes PRECEDENCE over whatever the network path
      // happened to throw: an aborted operation is ABORTED, never a
      // transient failure eligible for stale fallback.
      throwIfAborted(signal);
      if (cached !== null && isTransientFailure(error)) {
        // Transient network-path failure: serve the integrity-verified stale
        // entry (verified by the read above, this same operation).
        await this.touch(db as CacheDatabase, key as ArchiveCacheKey, cached.digest, signal);
        throwIfAborted(signal);
        return { bytes: new Uint8Array(cached.bytes), title: cached.title };
      }
      throw error;
    }
    throwIfAborted(signal);
    if (db !== null && key !== null) await this.writeThrough(db, key, payload, fetchedAt, signal);
    throwIfAborted(signal);
    return payload;
  }

  /** Close the underlying connection (test hygiene). */
  async close(): Promise<void> {
    const pending = this.dbPromise;
    this.dbPromise = null;
    (await pending)?.close();
  }

  private isFresh(fetchedAt: number): boolean {
    const age = this.now() - fetchedAt;
    return age >= 0 && age < SE_ARCHIVE_FRESH_TTL_MS;
  }

  private database(): Promise<CacheDatabase | null> {
    this.dbPromise ??= this.openDatabase();
    return this.dbPromise;
  }

  /** Open failures — missing IndexedDB, a synchronous SecurityError, a
   *  rejected or (theoretical) blocked open — all degrade to `null`: the
   *  session runs uncached and an add still succeeds. */
  private openDatabase(): Promise<CacheDatabase | null> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (db: CacheDatabase | null): void => {
        if (settled) return;
        settled = true;
        resolve(db);
      };
      const timer = setTimeout(() => settle(null), this.openTimeoutMs);
      let opening: Promise<CacheDatabase>;
      try {
        opening = this.open();
      } catch {
        clearTimeout(timer);
        settle(null);
        return;
      }
      opening.then(
        (db) => {
          clearTimeout(timer);
          if (settled) {
            db.close(); // the timeout already degraded this session
            return;
          }
          db.addEventListener('versionchange', () => {
            // Another context is upgrading/deleting the database: yield the
            // connection; later operations lazily reopen.
            db.close();
            this.dbPromise = null;
          });
          settle(db);
        },
        () => {
          clearTimeout(timer);
          settle(null);
        },
      );
    });
  }

  /**
   * Read + verify: envelope validation, then SHA-256 recomputed over the
   * stored bytes on EVERY read. Read failures degrade to a miss; any
   * envelope/digest mismatch is best-effort deleted (with ledger rebuild)
   * and reported as a miss. A digest that cannot be computed at all (no
   * WebCrypto) is an environment failure: miss WITHOUT deleting.
   */
  private async readVerified(
    db: CacheDatabase,
    key: ArchiveCacheKey,
    signal: AbortSignal | undefined,
  ): Promise<StoredEbookArchiveV1 | null> {
    let record: unknown;
    try {
      record = await db.get('archives', key);
    } catch {
      return null;
    }
    throwIfAborted(signal);
    if (record === undefined) return null;
    if (validStoredArchive(record, key)) {
      let digest: string | null;
      try {
        digest = await sha256Hex(record.bytes);
      } catch {
        digest = null;
      }
      throwIfAborted(signal);
      if (digest === null) return null;
      if (digest === record.digest) return record;
    }
    await this.repair(db, key, signal);
    return null;
  }

  /** LRU touch. Guarded by the digest so a concurrent replacement is never
   *  clobbered; a touch failure NEVER invalidates a good hit — INCLUDING a
   *  synchronous InvalidStateError from transaction() itself (connection
   *  closed under a version-change/delete race), which is why acquisition
   *  happens INSIDE the protected boundary. An abort still rejects, and the
   *  armed transaction guarantees no touch of an aborted operation commits
   *  (even between the put and the auto-commit). */
  private async touch(
    db: CacheDatabase,
    key: ArchiveCacheKey,
    expectedDigest: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const accessedAt = this.now();
    let tx: IDBPTransaction<StandardEbooksArchiveCacheDb, ['archives'], 'readwrite'> | null = null;
    let release: (() => void) | null = null;
    try {
      tx = db.transaction('archives', 'readwrite');
      release = guardTx(tx, signal);
      const store = tx.objectStore('archives');
      const existing = await store.get(key);
      throwIfAborted(signal);
      if (existing !== undefined && existing.digest === expectedDigest && existing.lastAccessedAt < accessedAt) {
        await store.put({ ...existing, lastAccessedAt: accessedAt });
        throwIfAborted(signal);
      }
      await tx.done;
      throwIfAborted(signal);
    } catch (error) {
      if (tx !== null) discardTx(tx);
      if (signal?.aborted === true || error instanceof CacheAbortedError) throw new CacheAbortedError();
      // best-effort: the hit stands
    } finally {
      release?.();
    }
  }

  /** Best-effort corruption repair: delete the record and rebuild the ledger
   *  from the actual survivors, in ONE transaction. An abort rejects and the
   *  armed transaction rolls the repair back whole; ANY other failure —
   *  including a synchronous InvalidStateError from transaction() itself —
   *  degrades to a miss, which is why acquisition happens INSIDE the
   *  protected boundary. */
  private async repair(
    db: CacheDatabase,
    key: ArchiveCacheKey,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let tx: CacheWriteTx | null = null;
    let release: (() => void) | null = null;
    try {
      tx = db.transaction(['archives', 'meta'], 'readwrite');
      release = guardTx(tx, signal);
      const archives = tx.objectStore('archives');
      await archives.delete(key);
      throwIfAborted(signal);
      let total = 0;
      let cursor = await archives.openCursor();
      while (cursor !== null) {
        throwIfAborted(signal);
        total += storedByteSize(cursor.value);
        cursor = await cursor.continue();
      }
      await tx
        .objectStore('meta')
        .put({ schema: LEDGER_SCHEMA, totalBytes: total }, SE_ARCHIVE_CACHE_LEDGER_KEY);
      throwIfAborted(signal);
      await tx.done;
      throwIfAborted(signal);
    } catch (error) {
      if (tx !== null) discardTx(tx);
      if (signal?.aborted === true || error instanceof CacheAbortedError) throw new CacheAbortedError();
      // best-effort otherwise
    } finally {
      release?.();
    }
  }

  /**
   * Write-through after a successful download. NEVER fails a successful add:
   * every failure path swallows (except abort, which rejects the operation).
   * Quota pressure evicts aggressively from THIS cache, retries once, then
   * degrades to uncached writes for the session.
   */
  private async writeThrough(
    db: CacheDatabase,
    key: ArchiveCacheKey,
    payload: EbookArchivePayload,
    fetchedAt: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (this.uncachedWrites) return;
    // An EXACT copy: `slice()` allocates a buffer of precisely byteLength, so
    // the record never retains a view over a larger source buffer.
    const bytes = payload.bytes.slice().buffer;
    if (bytes.byteLength > this.maxTotalBytes) return; // larger than the whole cap: uncached
    let digest: string;
    try {
      digest = await sha256Hex(bytes);
    } catch {
      return; // no WebCrypto: unverifiable entries are never stored
    }
    throwIfAborted(signal);
    const record: StoredEbookArchiveV1 = {
      cacheSchema: SE_ARCHIVE_CACHE_SCHEMA,
      sourceOrigin: key[1],
      organization: key[2],
      repositoryName: key[3],
      ref: key[4],
      archiveRecipe: SE_ARCHIVE_RECIPE,
      title: payload.title,
      byteLength: bytes.byteLength,
      fetchedAt,
      lastAccessedAt: this.now(),
      digest,
      bytes,
    };
    try {
      await this.commitWrite(db, key, record, signal);
    } catch (error) {
      if (error instanceof CacheAbortedError) throw error;
      if (!isQuotaError(error)) return; // cache failure never fails the add
      try {
        await this.clearAll(db, signal); // aggressive eviction: drop every cached archive
        await this.commitWrite(db, key, record, signal);
      } catch (retryError) {
        if (retryError instanceof CacheAbortedError) throw retryError;
        this.uncachedWrites = true; // degrade to uncached writes for the session
      }
    }
  }

  /** Aggressive quota response: drop EVERY cached archive (this cache only)
   *  and zero the ledger, atomically. An abort rejects and rolls it back. */
  private async clearAll(db: CacheDatabase, signal: AbortSignal | undefined): Promise<void> {
    const tx: CacheWriteTx = db.transaction(['archives', 'meta'], 'readwrite');
    const release = guardTx(tx, signal);
    try {
      throwIfAborted(signal);
      await tx.objectStore('archives').clear();
      throwIfAborted(signal);
      await tx
        .objectStore('meta')
        .put({ schema: LEDGER_SCHEMA, totalBytes: 0 }, SE_ARCHIVE_CACHE_LEDGER_KEY);
      throwIfAborted(signal);
      await tx.done;
      throwIfAborted(signal);
    } catch (error) {
      discardTx(tx);
      if (signal?.aborted === true || error instanceof CacheAbortedError) throw new CacheAbortedError();
      throw error;
    } finally {
      release();
    }
  }

  /**
   * One transaction: latest-wins check, ledger accounting, byte-weighted LRU
   * eviction until the incoming entry fits, the put, and the ledger update.
   * An abort at any await — armed by guardTx even between the final put and
   * the auto-commit — discards the whole transaction atomically.
   */
  private async commitWrite(
    db: CacheDatabase,
    key: ArchiveCacheKey,
    record: StoredEbookArchiveV1,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const tx: CacheWriteTx = db.transaction(['archives', 'meta'], 'readwrite');
    const release = guardTx(tx, signal);
    try {
      throwIfAborted(signal);
      const archives = tx.objectStore('archives');
      const existing = await archives.get(key);
      throwIfAborted(signal);
      if (
        existing !== undefined &&
        typeof existing.fetchedAt === 'number' &&
        existing.fetchedAt > record.fetchedAt
      ) {
        await tx.done; // latest wins: a concurrent writer stored a NEWER fetch
        throwIfAborted(signal);
        return;
      }
      // AUTHORITATIVE total: sum the PRIMARY store inside this transaction.
      // The ledger is maintained (written below) for observability and
      // repair-time consistency, but the hard-cap decision must never trust
      // it — a shape-valid but understated ledger would defeat the cap. The
      // store is small by construction (cap / multi-MB entries), so the
      // cursor pass is cheap.
      let total = record.byteLength;
      {
        let cursor = await archives.openCursor();
        while (cursor !== null) {
          throwIfAborted(signal);
          if (!keysEqual(cursor.primaryKey, key)) total += storedByteSize(cursor.value);
          cursor = await cursor.continue();
        }
      }
      throwIfAborted(signal);
      if (total > this.maxTotalBytes) {
        let cursor = await archives.index('lastAccessedAt').openCursor();
        while (cursor !== null && total > this.maxTotalBytes) {
          throwIfAborted(signal);
          if (!keysEqual(cursor.primaryKey, key)) {
            total -= storedByteSize(cursor.value);
            await cursor.delete();
          }
          cursor = await cursor.continue();
        }
        throwIfAborted(signal);
      }
      if (total > this.maxTotalBytes) {
        // The indexed sweep exhausted while still over budget: a record whose
        // lastAccessedAt is not a valid key (corruption) is OMITTED from the
        // index, so LRU never saw it. The HARD CAP must hold — sweep the
        // PRIMARY store and delete every remaining record except the one
        // being written (every indexed record LRU wanted gone is already
        // deleted; what remains is anomalous). The true total is then exactly
        // the incoming entry.
        let cursor = await archives.openCursor();
        while (cursor !== null) {
          throwIfAborted(signal);
          if (!keysEqual(cursor.primaryKey, key)) await cursor.delete();
          cursor = await cursor.continue();
        }
        throwIfAborted(signal);
        total = record.byteLength;
      }
      await archives.put(record);
      throwIfAborted(signal);
      await tx
        .objectStore('meta')
        .put({ schema: LEDGER_SCHEMA, totalBytes: total }, SE_ARCHIVE_CACHE_LEDGER_KEY);
      throwIfAborted(signal);
      await tx.done;
      throwIfAborted(signal);
    } catch (error) {
      discardTx(tx);
      if (signal?.aborted === true) throw new CacheAbortedError();
      throw error;
    } finally {
      release();
    }
  }
}

/** The production network path: the ONLY place the archive chunk loads. */
async function downloadViaLibrary(
  name: string,
  signal: AbortSignal | undefined,
): Promise<EbookArchivePayload> {
  const archive = await import('@texttrends/standard-ebooks/archive');
  const { bytes, metadata } = await archive.downloadEbookArchive(name, signal ? { signal } : {});
  return { bytes, title: metadata.title };
}

let sharedCache: StandardEbooksArchiveCache | null = null;

/** The facade's entry point: the shared cache over the library downloader. */
export function downloadEbookArchiveCached(
  name: string,
  signal?: AbortSignal,
): Promise<EbookArchivePayload> {
  sharedCache ??= new StandardEbooksArchiveCache();
  return sharedCache.download(name, downloadViaLibrary, signal);
}
