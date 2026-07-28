/**
 * The Standard Ebooks archive cache (Phase F commit 3 ruling) against
 * fake-indexeddb, with an injectable clock, downloader, and database opener.
 * Risk list under test: compound-key separation; fresh/expired/refresh;
 * transient-vs-definitive stale fallback (abort NEVER falls back); corrupt
 * storage deletes + refetches; byte-weighted LRU + replacement accounting +
 * quota retry + uncached-degrade + ledger consistency under aborted
 * transactions; abort at every async stage with no surviving write/touch;
 * unavailable IndexedDB still succeeding uncached; latest-wins concurrent
 * writes. (A key-field/envelope mismatch AT a key is unreachable through the
 * real schema — the compound keyPath derives the key FROM the record fields —
 * so key separation is proven across keys and the remaining envelope checks
 * on plantable fields.)
 */
import 'fake-indexeddb/auto'; // installs the full IDB* global surface idb needs
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  openStandardEbooksArchiveCacheDb,
  StandardEbooksArchiveCache,
  SE_ARCHIVE_CACHE_LEDGER_KEY,
  SE_ARCHIVE_CACHE_SCHEMA,
  SE_ARCHIVE_FRESH_TTL_MS,
  SE_ARCHIVE_RECIPE,
  SE_ORGANIZATION,
  SE_REF,
  SE_SOURCE_ORIGIN,
  type EbookArchivePayload,
  type StandardEbooksArchiveCacheOptions,
} from '../src/lib/standard-ebooks-cache.ts';

type CacheDb = Awaited<ReturnType<typeof openStandardEbooksArchiveCacheDb>>;

const NAME = 'mary-shelley_frankenstein';
const OTHER = 'arthur-conan-doyle_a-study-in-scarlet';
const HOUR = 60 * 60 * 1000;

let clock: { t: number };

beforeEach(() => {
  // A fresh factory per test — no cross-test database state.
  globalThis.indexedDB = new IDBFactory() as unknown as typeof indexedDB;
  clock = { t: 1_000_000 };
  vi.restoreAllMocks();
});

const makeCache = (options: StandardEbooksArchiveCacheOptions = {}) =>
  new StandardEbooksArchiveCache({ now: () => clock.t, ...options });

const payload = (fill: number, size = 8, title = 'Frankenstein'): EbookArchivePayload => ({
  bytes: new Uint8Array(size).fill(fill),
  title,
});

const ok = (p: EbookArchivePayload) => vi.fn(async () => p);

const coded = (code: string, status?: number): Error =>
  Object.assign(new Error(code), status === undefined ? { code } : { code, status });

async function withDb<T>(use: (db: CacheDb) => Promise<T>): Promise<T> {
  const db = await openStandardEbooksArchiveCacheDb();
  try {
    return await use(db);
  } finally {
    db.close();
  }
}

const allRecords = () => withDb((db) => db.getAll('archives'));
const ledger = () =>
  withDb(async (db) => (await db.get('meta', SE_ARCHIVE_CACHE_LEDGER_KEY))?.totalBytes ?? null);

/** Tamper with every stored record IN PLACE (key fields untouched — the
 *  compound keyPath re-derives the key on update). */
async function mutateRecords(mutate: (record: Record<string, unknown>) => void): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction('archives', 'readwrite');
    let cursor = await tx.objectStore('archives').openCursor();
    while (cursor !== null) {
      const value = cursor.value as unknown as Record<string, unknown>;
      mutate(value);
      await cursor.update(value as never);
      cursor = await cursor.continue();
    }
    await tx.done;
  });
}

/** Pass-through Proxy with method overrides — the failure/abort seams tests
 *  wrap around a REAL fake-indexeddb database. */
function passthrough<T extends object>(target: T, overrides: Record<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (prop in overrides) return overrides[prop];
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
}

const seamOpen = (wrap: (db: CacheDb) => CacheDb) => async () =>
  wrap(await openStandardEbooksArchiveCacheDb());

/** Make readwrite puts into `archives` reject with QuotaExceededError while
 *  `gate.remaining > 0`. */
function quotaWrapped(db: CacheDb, gate: { remaining: number }): CacheDb {
  return passthrough(db, {
    transaction: (names: unknown, mode?: unknown, options?: unknown) => {
      const tx = (db.transaction as (...a: unknown[]) => never)(names as never, mode as never, options as never) as {
        objectStore: (name: unknown) => object & { put: (...a: unknown[]) => unknown };
      };
      if (mode !== 'readwrite') return tx;
      return passthrough(tx as object, {
        objectStore: (name: unknown) => {
          const store = tx.objectStore(name);
          if (name !== 'archives') return store;
          return passthrough(store, {
            put: (...args: unknown[]) => {
              if (gate.remaining > 0) {
                gate.remaining -= 1;
                return Promise.reject(new DOMException('quota', 'QuotaExceededError'));
              }
              return store.put(...args);
            },
          });
        },
      });
    },
  });
}

/** Intercept ONE mutation method on the readwrite `archives` store: ISSUE the
 *  real request, THEN abort the caller — Codex's probe shape (the mutation is
 *  already in flight when the abort lands; it must not commit). */
function abortAfterArchivesMutation(
  db: CacheDb,
  controller: AbortController,
  method: 'put' | 'delete' | 'clear',
): CacheDb {
  return passthrough(db, {
    transaction: (names: unknown, mode?: unknown, options?: unknown) => {
      const tx = (db.transaction as (...a: unknown[]) => unknown)(
        names as never,
        mode as never,
        options as never,
      ) as { objectStore: (name: unknown) => object };
      if (mode !== 'readwrite') return tx;
      return passthrough(tx as object, {
        objectStore: (name: unknown) => {
          const store = tx.objectStore(name) as Record<string, (...a: unknown[]) => unknown> & object;
          if (name !== 'archives') return store;
          return passthrough(store, {
            [method]: (...args: unknown[]) => {
              const issued = store[method]!(...args); // the request is REALLY issued…
              controller.abort(); // …then the caller aborts, mid-flight
              return issued;
            },
          });
        },
      });
    },
  });
}

/** A connection closed under a version-change/delete race makes transaction()
 *  THROW SYNCHRONOUSLY (InvalidStateError) — readwrite only here, since the
 *  cache's reads go through db.get. */
function throwOnReadwriteTx(db: CacheDb): CacheDb {
  return passthrough(db, {
    transaction: (names: unknown, mode?: unknown, options?: unknown) => {
      if (mode === 'readwrite') {
        throw new DOMException('The database connection is closing.', 'InvalidStateError');
      }
      return (db.transaction as (...a: unknown[]) => unknown)(
        names as never,
        mode as never,
        options as never,
      );
    },
  });
}

describe('key identity and separation', () => {
  it('stores one record per full compound key and separates repository names', async () => {
    const cache = makeCache();
    await cache.download(NAME, ok(payload(1, 8, 'Frankenstein')));
    await cache.download(OTHER, ok(payload(2, 8, 'A Study in Scarlet')));

    const records = await allRecords();
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.cacheSchema).toBe(SE_ARCHIVE_CACHE_SCHEMA);
      expect(record.sourceOrigin).toBe(SE_SOURCE_ORIGIN);
      expect(record.organization).toBe(SE_ORGANIZATION);
      expect(record.ref).toBe(SE_REF);
      expect(record.archiveRecipe).toBe(SE_ARCHIVE_RECIPE);
      expect(record.byteLength).toBe(record.bytes.byteLength);
    }
    expect(await ledger()).toBe(16);

    // A hit answers with ITS key's bytes, not a neighbor's.
    const miss = vi.fn();
    const hit = await cache.download(NAME, miss as never);
    expect(miss).not.toHaveBeenCalled();
    expect(hit.title).toBe('Frankenstein');
    expect(Array.from(hit.bytes)).toEqual(Array.from(new Uint8Array(8).fill(1)));
  });

  it('an invalid repository name bypasses the cache entirely', async () => {
    const cache = makeCache();
    const downloader = ok(payload(3));
    await cache.download('Bad/Name', downloader);
    await cache.download('Bad/Name', downloader);
    expect(downloader).toHaveBeenCalledTimes(2); // nothing was cached
    expect(await allRecords()).toHaveLength(0);
  });
});

describe('freshness with an injected clock', () => {
  it('a verified fresh hit answers without the downloader and touches lastAccessedAt', async () => {
    const cache = makeCache();
    const t0 = clock.t;
    await cache.download(NAME, ok(payload(1, 8, 'Frankenstein')));

    clock.t = t0 + HOUR;
    const miss = vi.fn();
    const hit = await cache.download(NAME, miss as never);
    expect(miss).not.toHaveBeenCalled();
    expect(hit.title).toBe('Frankenstein');

    const [record] = await allRecords();
    expect(record!.fetchedAt).toBe(t0);
    expect(record!.lastAccessedAt).toBe(t0 + HOUR); // LRU touch, ledger untouched
    expect(await ledger()).toBe(8);
  });

  it('an expired entry refreshes over the network and REPLACES the record (ledger accounting follows)', async () => {
    const cache = makeCache();
    const t0 = clock.t;
    await cache.download(NAME, ok(payload(1, 8)));

    clock.t = t0 + SE_ARCHIVE_FRESH_TTL_MS; // exactly the TTL: no longer fresh
    const refreshed = ok(payload(9, 16, 'Frankenstein (rev)'));
    const result = await cache.download(NAME, refreshed);
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(result.title).toBe('Frankenstein (rev)');

    const records = await allRecords();
    expect(records).toHaveLength(1); // replaced, never accumulated
    expect(records[0]!.fetchedAt).toBe(t0 + SE_ARCHIVE_FRESH_TTL_MS);
    expect(records[0]!.byteLength).toBe(16);
    expect(await ledger()).toBe(16); // old 8 released, new 16 charged
  });

  it('a FUTURE fetchedAt (clock skew) is not fresh and refreshes', async () => {
    const cache = makeCache();
    await cache.download(NAME, ok(payload(1)));
    await mutateRecords((r) => {
      r.fetchedAt = clock.t + HOUR;
    });
    const refreshed = ok(payload(2));
    await cache.download(NAME, refreshed);
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
});

describe('transient vs definitive failure classification', () => {
  const populateExpired = async (cache: StandardEbooksArchiveCache) => {
    await cache.download(NAME, ok(payload(1, 8, 'Frankenstein')));
    clock.t += SE_ARCHIVE_FRESH_TTL_MS + HOUR;
  };

  it('transient failures serve the previously integrity-verified stale entry', async () => {
    const cache = makeCache();
    await populateExpired(cache);
    for (const error of [
      coded('NETWORK_ERROR'),
      coded('RATE_LIMITED', 429),
      coded('HTTP_ERROR', 503),
      coded('HTTP_ERROR', 500),
      coded('HTTP_ERROR', 408),
    ]) {
      const failing = vi.fn(async () => {
        throw error;
      });
      const stale = await cache.download(NAME, failing);
      expect(failing).toHaveBeenCalledTimes(1); // the network WAS retried first
      expect(stale.title).toBe('Frankenstein');
      expect(Array.from(stale.bytes)).toEqual(Array.from(new Uint8Array(8).fill(1)));
    }
  });

  it('definitive failures reject — the stale entry is never used to paper them over', async () => {
    const cache = makeCache();
    await populateExpired(cache);
    for (const error of [
      coded('HTTP_ERROR', 404),
      coded('HTTP_ERROR', 403),
      coded('CAP_EXCEEDED'),
      coded('INVALID_RESPONSE'),
      coded('INVALID_EPUB'),
      coded('INVALID_REPOSITORY'),
      new Error('uncoded'),
    ]) {
      await expect(
        cache.download(NAME, async () => {
          throw error;
        }),
      ).rejects.toBe(error);
    }
  });

  it('abort NEVER falls back to a stale entry — even when the failure looks transient', async () => {
    const cache = makeCache();
    await populateExpired(cache);

    const controller = new AbortController();
    const abortingDownloader = vi.fn(async () => {
      controller.abort();
      throw coded('ABORTED');
    });
    await expect(cache.download(NAME, abortingDownloader, controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });

    // Caller cancellation takes PRECEDENCE: a transport error thrown while
    // the caller's signal is aborted is classified ABORTED — never surfaced
    // as (or fallen back from) a transient failure.
    const controller2 = new AbortController();
    await expect(
      cache.download(
        NAME,
        async () => {
          controller2.abort();
          throw coded('NETWORK_ERROR');
        },
        controller2.signal,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('corrupt storage detection', () => {
  it('a digest mismatch is a miss: refetched when the network works, deleted (with ledger rebuild) when it does not', async () => {
    const cache = makeCache();
    await cache.download(NAME, ok(payload(1, 8, 'Frankenstein')));

    // Flip a stored byte: envelope intact, digest now wrong.
    await mutateRecords((r) => {
      new Uint8Array(r.bytes as ArrayBuffer)[0]! ^= 0xff;
    });
    const refetch = ok(payload(2, 8, 'Frankenstein'));
    const result = await cache.download(NAME, refetch); // still inside the fresh window
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(Array.from(result.bytes)).toEqual(Array.from(new Uint8Array(8).fill(2)));

    // Corrupt again; a DEFINITIVE network failure now surfaces, and the
    // corrupt record is already gone (best-effort delete on read).
    await mutateRecords((r) => {
      new Uint8Array(r.bytes as ArrayBuffer)[0]! ^= 0xff;
    });
    await expect(
      cache.download(NAME, async () => {
        throw coded('HTTP_ERROR', 404);
      }),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    expect(await allRecords()).toHaveLength(0);
    expect(await ledger()).toBe(0); // rebuilt in the same repair transaction
  });

  it('a synchronously THROWING readwrite transaction cannot invalidate a fresh hit (touch stays best-effort)', async () => {
    const seeded = makeCache();
    const t0 = clock.t;
    await seeded.download(NAME, ok(payload(1, 8, 'Frankenstein')));

    const cache = makeCache({ open: seamOpen(throwOnReadwriteTx) });
    clock.t = t0 + HOUR;
    const downloader = vi.fn();
    const hit = await cache.download(NAME, downloader as never); // must RESOLVE, not reject
    expect(downloader).not.toHaveBeenCalled();
    expect(hit.title).toBe('Frankenstein');
    expect(Array.from(hit.bytes)).toEqual(Array.from(new Uint8Array(8).fill(1)));
    const [record] = await allRecords();
    expect(record!.lastAccessedAt).toBe(t0); // the touch simply did not happen
  });

  it('a synchronously THROWING readwrite transaction during repair still degrades to miss + refetch', async () => {
    const seeded = makeCache();
    await seeded.download(NAME, ok(payload(1, 8)));
    await mutateRecords((r) => {
      new Uint8Array(r.bytes as ArrayBuffer)[0]! ^= 0xff; // digest mismatch → read wants repair
    });

    const cache = makeCache({ open: seamOpen(throwOnReadwriteTx) });
    const refetch = ok(payload(2, 8, 'Frankenstein'));
    const result = await cache.download(NAME, refetch); // must RESOLVE via refetch
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(result.title).toBe('Frankenstein');
    expect(Array.from(result.bytes)).toEqual(Array.from(new Uint8Array(8).fill(2)));
  });

  it('a stored-length disagreement is corrupt and refetches', async () => {
    const cache = makeCache();
    await cache.download(NAME, ok(payload(1, 8)));
    await mutateRecords((r) => {
      r.byteLength = 9;
    });
    const refetch = ok(payload(3, 8));
    await cache.download(NAME, refetch);
    expect(refetch).toHaveBeenCalledTimes(1);
    const [record] = await allRecords();
    expect(record!.byteLength).toBe(8); // rewritten valid
  });

  it('missing or wrong-shaped metadata fields are corrupt and refetch', async () => {
    const cache = makeCache();
    await cache.download(NAME, ok(payload(1, 8)));

    await mutateRecords((r) => {
      delete r.title;
    });
    const afterMissingField = ok(payload(2, 8));
    await cache.download(NAME, afterMissingField);
    expect(afterMissingField).toHaveBeenCalledTimes(1);

    await mutateRecords((r) => {
      r.fetchedAt = 'yesterday';
    });
    const afterBadShape = ok(payload(3, 8));
    await cache.download(NAME, afterBadShape);
    expect(afterBadShape).toHaveBeenCalledTimes(1);

    await mutateRecords((r) => {
      r.digest = 'not-64-hex';
    });
    const afterBadDigestShape = ok(payload(4, 8));
    await cache.download(NAME, afterBadDigestShape);
    expect(afterBadDigestShape).toHaveBeenCalledTimes(1);
  });
});

describe('eviction, quota, and the ledger', () => {
  it('byte-weighted LRU evicts by lastAccessedAt until the incoming entry fits', async () => {
    const cache = makeCache({ maxTotalBytes: 100 });
    clock.t = 1000;
    await cache.download('aaa', ok(payload(1, 40, 'A')));
    clock.t = 2000;
    await cache.download('bbb', ok(payload(2, 40, 'B')));
    clock.t = 3000;
    await cache.download('aaa', vi.fn() as never); // fresh hit → A is now most recent
    clock.t = 4000;
    await cache.download('ccc', ok(payload(3, 40, 'C'))); // 120 > 100 → evict LRU

    const names = (await allRecords()).map((r) => r.repositoryName).sort();
    expect(names).toEqual(['aaa', 'ccc']); // B was least-recently ACCESSED, despite A being older
    expect(await ledger()).toBe(80);
  });

  it('a corrupt record hidden from the LRU index cannot defeat the hard byte cap', async () => {
    // IndexedDB OMITS records whose lastAccessedAt is not a valid key from
    // the index, so the LRU sweep never sees them; the fallback primary-store
    // sweep must still enforce the cap (Codex probe: 60B+40B under a 100B
    // cap, the 60B record's timestamp nulled, insert 50B).
    const cache = makeCache({ maxTotalBytes: 100 });
    clock.t = 1000;
    await cache.download('aaa', ok(payload(1, 60, 'A')));
    clock.t = 2000;
    await cache.download('bbb', ok(payload(2, 40, 'B')));
    await mutateRecords((r) => {
      if (r.repositoryName === 'aaa') r.lastAccessedAt = null; // hidden from the index
    });

    clock.t = 3000;
    await cache.download('ccc', ok(payload(3, 50, 'C')));

    const records = await allRecords();
    const storedTotal = records.reduce((sum, r) => sum + r.bytes.byteLength, 0);
    expect(storedTotal).toBeLessThanOrEqual(100); // the HARD cap held in the store itself
    expect(await ledger()).toBe(storedTotal); // and the ledger tells the truth
    expect(records.map((r) => r.repositoryName)).toEqual(['ccc']); // bbb via LRU, anomalous aaa via the fallback sweep
    expect(await ledger()).toBe(50);
  });

  it('an UNDERSTATED ledger cannot defeat the hard byte cap — the primary-store sum is authoritative', async () => {
    // Codex probe: valid 60B+40B records, ledger manually zeroed, insert 50B.
    // The cap decision must come from summing the store, never from the
    // (shape-valid but lying) ledger.
    const cache = makeCache({ maxTotalBytes: 100 });
    clock.t = 1000;
    await cache.download('aaa', ok(payload(1, 60, 'A')));
    clock.t = 2000;
    await cache.download('bbb', ok(payload(2, 40, 'B')));
    await withDb(async (db) => {
      await db.put(
        'meta',
        { schema: 'texttrends/se-archive-cache-ledger/1', totalBytes: 0 },
        SE_ARCHIVE_CACHE_LEDGER_KEY,
      );
    });

    clock.t = 3000;
    await cache.download('ccc', ok(payload(3, 50, 'C')));

    const records = await allRecords();
    const storedTotal = records.reduce((sum, r) => sum + r.bytes.byteLength, 0);
    expect(storedTotal).toBeLessThanOrEqual(100); // the HARD cap held in the store itself
    expect(await ledger()).toBe(storedTotal); // and the ledger was rebuilt to the truth
    expect(records.map((r) => r.repositoryName).sort()).toEqual(['bbb', 'ccc']); // aaa LRU-evicted off the TRUE total
    expect(await ledger()).toBe(90);
  });

  it('an entry larger than the whole cap is returned uncached', async () => {
    const cache = makeCache({ maxTotalBytes: 100 });
    const big = await cache.download(NAME, ok(payload(1, 101, 'Big')));
    expect(big.bytes.byteLength).toBe(101); // the add itself succeeded
    expect(await allRecords()).toHaveLength(0);
  });

  it('quota: aggressive eviction + one retry, then uncached writes for the session — adds always succeed', async () => {
    const gate = { remaining: 0 };
    const cache = makeCache({ open: seamOpen((db) => quotaWrapped(db, gate)) });

    await cache.download('aaa', ok(payload(1, 8, 'A'))); // gate closed: stored normally
    expect(await allRecords()).toHaveLength(1);

    // One quota failure: evict everything from THIS cache, retry once, succeed.
    gate.remaining = 1;
    await cache.download('bbb', ok(payload(2, 8, 'B')));
    const afterRetry = await allRecords();
    expect(afterRetry.map((r) => r.repositoryName)).toEqual(['bbb']); // aaa was evicted aggressively
    expect(await ledger()).toBe(8);

    // Persistent quota failure: the add still succeeds; writes degrade for the session.
    gate.remaining = Number.POSITIVE_INFINITY;
    const survived = await cache.download('ccc', ok(payload(3, 8, 'C')));
    expect(survived.title).toBe('C');
    expect(await allRecords()).toHaveLength(0); // cleared by eviction; retry failed
    expect(await ledger()).toBe(0);

    gate.remaining = 0; // even with quota healthy again, the session stays uncached
    await cache.download('ddd', ok(payload(4, 8, 'D')));
    expect(await allRecords()).toHaveLength(0);
  });

  it('an aborted write transaction leaves no record and a consistent ledger', async () => {
    const controller = new AbortController();
    const abortOnWriteTx = (db: CacheDb): CacheDb =>
      passthrough(db, {
        transaction: (names: unknown, mode?: unknown, options?: unknown) => {
          if (mode === 'readwrite' && Array.isArray(names)) controller.abort(); // mid-write abort
          return (db.transaction as (...a: unknown[]) => unknown)(
            names as never,
            mode as never,
            options as never,
          );
        },
      });
    const seeded = makeCache();
    await seeded.download('aaa', ok(payload(1, 8, 'A'))); // seeded WITHOUT the seam

    const cache = makeCache({ open: seamOpen(abortOnWriteTx) });
    await expect(
      cache.download('bbb', ok(payload(2, 8, 'B')), controller.signal),
    ).rejects.toMatchObject({ code: 'ABORTED' });

    const records = await allRecords();
    expect(records.map((r) => r.repositoryName)).toEqual(['aaa']); // no bbb write survived
    const total = records.reduce((sum, r) => sum + r.bytes.byteLength, 0);
    expect(await ledger()).toBe(total); // ledger agrees with the surviving records
  });
});

describe('abort at every async stage', () => {
  it('an already-aborted signal rejects immediately; the downloader never runs', async () => {
    const cache = makeCache();
    const controller = new AbortController();
    controller.abort();
    const downloader = vi.fn();
    await expect(cache.download(NAME, downloader as never, controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(downloader).not.toHaveBeenCalled();
  });

  it('abort landing during the cache READ rejects: no downloader, no touch', async () => {
    const seeded = makeCache();
    const t0 = clock.t;
    await seeded.download(NAME, ok(payload(1, 8)));

    const controller = new AbortController();
    const abortOnGet = (db: CacheDb): CacheDb =>
      passthrough(db, {
        get: (store: unknown, key: unknown) => {
          controller.abort();
          return (db.get as (...a: unknown[]) => unknown)(store as never, key as never);
        },
      });
    const cache = makeCache({ open: seamOpen(abortOnGet) });
    clock.t = t0 + HOUR;
    const downloader = vi.fn();
    await expect(cache.download(NAME, downloader as never, controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(downloader).not.toHaveBeenCalled();
    const [record] = await allRecords();
    expect(record!.lastAccessedAt).toBe(t0); // the aborted operation left no touch
  });

  it('abort landing during DIGEST verification rejects: no downloader, no touch', async () => {
    const cache = makeCache();
    const t0 = clock.t;
    await cache.download(NAME, ok(payload(1, 8)));

    const controller = new AbortController();
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      controller.abort();
      return realDigest(algorithm as never, data as never);
    });
    clock.t = t0 + HOUR;
    const downloader = vi.fn();
    await expect(cache.download(NAME, downloader as never, controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(downloader).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const [record] = await allRecords();
    expect(record!.lastAccessedAt).toBe(t0);
  });

  it('abort landing while the TOUCH put is in flight rejects; the touch does not commit', async () => {
    const seeded = makeCache();
    const t0 = clock.t;
    await seeded.download(NAME, ok(payload(1, 8)));

    const controller = new AbortController();
    const cache = makeCache({
      open: seamOpen((db) => abortAfterArchivesMutation(db, controller, 'put')),
    });
    clock.t = t0 + HOUR;
    const downloader = vi.fn();
    await expect(cache.download(NAME, downloader as never, controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(downloader).not.toHaveBeenCalled();
    const [record] = await allRecords();
    expect(record!.lastAccessedAt).toBe(t0); // the issued put was rolled back whole
  });

  it('abort landing while the WRITE put is in flight rejects; no record or ledger change commits', async () => {
    const seeded = makeCache();
    await seeded.download('aaa', ok(payload(1, 8, 'A')));

    const controller = new AbortController();
    const cache = makeCache({
      open: seamOpen((db) => abortAfterArchivesMutation(db, controller, 'put')),
    });
    await expect(
      cache.download('bbb', ok(payload(2, 8, 'B')), controller.signal),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    const records = await allRecords();
    expect(records.map((r) => r.repositoryName)).toEqual(['aaa']); // the in-flight bbb put rolled back
    expect(await ledger()).toBe(8); // ledger untouched by the aborted transaction
  });

  it('abort landing during corruption REPAIR rejects; the repair rolls back whole', async () => {
    const seeded = makeCache();
    await seeded.download(NAME, ok(payload(1, 8)));
    await mutateRecords((r) => {
      new Uint8Array(r.bytes as ArrayBuffer)[0]! ^= 0xff; // digest mismatch → read triggers repair
    });

    const controller = new AbortController();
    const cache = makeCache({
      open: seamOpen((db) => abortAfterArchivesMutation(db, controller, 'delete')),
    });
    const downloader = vi.fn();
    await expect(cache.download(NAME, downloader as never, controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(downloader).not.toHaveBeenCalled();
    expect(await allRecords()).toHaveLength(1); // the issued repair delete did not survive
    expect(await ledger()).toBe(8); // and neither did its ledger rebuild
  });

  it('abort landing during the quota CLEAR rejects; the clear rolls back whole', async () => {
    const seeded = makeCache();
    await seeded.download('aaa', ok(payload(1, 8, 'A')));

    const controller = new AbortController();
    const gate = { remaining: 1 }; // quota trips ONCE → the aggressive clear runs
    const cache = makeCache({
      open: seamOpen((db) => quotaWrapped(abortAfterArchivesMutation(db, controller, 'clear'), gate)),
    });
    await expect(
      cache.download('bbb', ok(payload(2, 8, 'B')), controller.signal),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    const records = await allRecords();
    expect(records.map((r) => r.repositoryName)).toEqual(['aaa']); // the issued clear did not survive
    expect(await ledger()).toBe(8);
  });

  it('abort landing after a successful download discards the write entirely', async () => {
    const cache = makeCache();
    const controller = new AbortController();
    await expect(
      cache.download(
        NAME,
        async () => {
          controller.abort(); // the download itself completed — too late
          return payload(1, 8);
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(await allRecords()).toHaveLength(0); // the late completion reached no store
  });
});

describe('unavailable IndexedDB', () => {
  it('indexedDB undefined: every add succeeds, uncached', async () => {
    globalThis.indexedDB = undefined as never;
    const cache = makeCache();
    const downloader = ok(payload(1, 8, 'Frankenstein'));
    const first = await cache.download(NAME, downloader);
    expect(first.title).toBe('Frankenstein');
    await cache.download(NAME, downloader);
    expect(downloader).toHaveBeenCalledTimes(2); // no cache, still no failures
  });

  it('a synchronously THROWING indexedDB.open: every add succeeds, uncached', async () => {
    globalThis.indexedDB = {
      open() {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as typeof indexedDB;
    const cache = makeCache();
    const downloader = ok(payload(2, 8, 'Frankenstein'));
    const result = await cache.download(NAME, downloader);
    expect(result.title).toBe('Frankenstein');
    expect(downloader).toHaveBeenCalledTimes(1);
  });
});

describe('latest-wins concurrent writes', () => {
  it('a slower, OLDER fetch never overwrites a newer record (checked inside the write transaction)', async () => {
    const cache = makeCache();
    let release!: (p: EbookArchivePayload) => void;
    const slow = vi.fn(
      () =>
        new Promise<EbookArchivePayload>((resolve) => {
          release = resolve;
        }),
    );
    clock.t = 1000;
    const first = cache.download(NAME, slow); // fetchedAt stamped 1000 (fetch start)
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());

    clock.t = 2000;
    await cache.download(NAME, ok(payload(9, 8, 'newer'))); // fetchedAt 2000, committed

    release(payload(1, 8, 'older'));
    const result = await first;
    expect(result.title).toBe('older'); // the caller still receives ITS download

    const records = await allRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.title).toBe('newer'); // the newer fetch survived latest-wins
    expect(records[0]!.fetchedAt).toBe(2000);
    expect(await ledger()).toBe(8);
  });
});
