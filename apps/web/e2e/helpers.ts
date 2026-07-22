/**
 * Shared helpers for the real-browser suite. Assertions read the sanitized
 * protocol trace exposed by the e2e build (`window.__ttE2E`) and raw
 * IndexedDB from page context; nothing here touches app internals.
 */

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { SHERLOCK } from '../src/lib/store.ts';
import { USER_PROJECT_ID } from '../src/lib/project.ts';
import type { TraceSnapshot, ProtocolTraceEvent } from '../src/lib/trace.ts';

export { SHERLOCK };
export const DOC_COUNT = SHERLOCK.length;
export const DB_NAME = 'texttrends-artifacts-provisional-db2';
export const USER_DATA_DB = 'texttrends-user-data';

export const READY_TEXT = `${DOC_COUNT}/${DOC_COUNT} books ready`;

/** Wait for the header to report `n/n books ready` (a user project's count). */
export async function awaitReadyCount(page: Page, n: number, timeout = 60_000): Promise<void> {
  await expect(page.getByText(`${n}/${n} books ready`)).toBeVisible({ timeout });
}

/** Clear ONLY the disposable artifact stores (db2), preserving durable user
 *  data. Awaits transaction completion before returning (never race a reload). */
export async function clearArtifactStores(page: Page): Promise<void> {
  await page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const stores = [...db.objectStoreNames];
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(stores, 'readwrite');
        for (const s of stores) tx.objectStore(s).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, DB_NAME);
}

/**
 * Force the worker's `texttrends-user-data` connection to close by opening the
 * database at `currentVersion + 1` from page context (its own connection). The
 * worker registered a `versionchange` handler that closes and invalidates its
 * store, so the upgrade proceeds; subsequent save/persist ops then report
 * PERSISTENCE_UNAVAILABLE. Reads the current version rather than hard-coding it.
 */
export async function bumpUserDataVersion(page: Page): Promise<void> {
  await page.evaluate(async (dbName) => {
    const current = await new Promise<number>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => {
        const v = req.result.version;
        req.result.close();
        resolve(v);
      };
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const up = indexedDB.open(dbName, current + 1);
      up.onupgradeneeded = () => {
        /* no schema change — the version bump alone forces the versionchange */
      };
      up.onsuccess = () => {
        up.result.close();
        resolve();
      };
      up.onerror = () => reject(up.error);
      up.onblocked = () => reject(new Error('user-data upgrade blocked — the worker did not close its connection'));
    });
  }, USER_DATA_DB);
}

/** The durable user-project record (the canonical manifest) read by its
 *  CANONICAL key `user/default` — never a first-record lookup. */
export async function readUserProject(page: Page): Promise<{ id: string; revision: number; docs: unknown[] } | null> {
  return page.evaluate(async ({ dbName, id }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const rec = await new Promise<unknown>((resolve, reject) => {
        const req = db.transaction('projects', 'readonly').objectStore('projects').get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return (rec as { id: string; revision: number; docs: unknown[] }) ?? null;
    } finally {
      db.close();
    }
  }, { dbName: USER_DATA_DB, id: USER_PROJECT_ID });
}

/** Advance ONLY the stored manifest's `revision` (simulating another tab's CAS
 *  save) so a live session saving from its older base hits REVISION_CONFLICT.
 *  Preserves the rest of the durable payload; awaits transaction completion. */
export async function setUserProjectRevision(page: Page, id: string, revision: number): Promise<void> {
  await page.evaluate(async ({ dbName, id, revision }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('projects', 'readwrite');
        const store = tx.objectStore('projects');
        const get = store.get(id);
        get.onsuccess = () => {
          const rec = get.result as Record<string, unknown> | undefined;
          if (!rec) return reject(new Error(`no project record for ${id}`));
          rec.revision = revision; // ONLY the revision; the payload is preserved
          store.put(rec);
        };
        get.onerror = () => reject(get.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, { dbName: USER_DATA_DB, id, revision });
}

/** Count durable user-data records (proves clear-cache isolation: clearing db2
 *  must leave `projects`/`sources` intact). */
export async function userDataCounts(page: Page): Promise<{ projects: number; sources: number }> {
  return page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const count = (store: string): Promise<number> =>
        new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(store)) return resolve(0);
          const req = db.transaction(store, 'readonly').objectStore(store).count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      const [projects, sources] = await Promise.all([count('projects'), count('sources')]);
      return { projects, sources };
    } finally {
      db.close();
    }
  }, USER_DATA_DB);
}

export async function trace(page: Page): Promise<TraceSnapshot> {
  return page.evaluate(() => {
    const facade = (window as unknown as { __ttE2E?: { trace(): unknown } }).__ttE2E;
    if (!facade) throw new Error('e2e facade missing — was the app built with --mode e2e?');
    return facade.trace() as never;
  });
}

export function events(snapshot: TraceSnapshot, filter: Partial<ProtocolTraceEvent>): ProtocolTraceEvent[] {
  return snapshot.events.filter((e) =>
    Object.entries(filter).every(([k, v]) => e[k as keyof ProtocolTraceEvent] === v),
  );
}

/** Wait for the app to report every book ready. */
export async function awaitAllReady(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.getByText(READY_TEXT)).toBeVisible({ timeout });
}

/**
 * Submit a comparison and wait for EVERY query posted after the action to
 * deliver its result — an assertion must never pass on pre-action evidence
 * (a chip renders from store intent immediately), and a multi-series
 * comparison posts one trend job per series plus KWIC, all of which the
 * comparison render waits on (review rounds 1–2). Returns the fresh result
 * events; the LAST one's `at` stamp is the burst's delivery-settlement
 * time. A fresh job that errors or cancels stalls the poll into a visible
 * timeout failure.
 */
export async function submitAndAwaitFreshResults(page: Page, terms: string): Promise<ProtocolTraceEvent[]> {
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const input = page.getByLabel(/terms to compare/i);
  await input.fill(terms);
  await input.press('Enter');
  let fresh: ProtocolTraceEvent[] = [];
  await expect
    .poll(
      async () => {
        const t = await trace(page);
        const freshQueries = t.events.filter(
          (e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'query',
        );
        if (freshQueries.length === 0) return 'no fresh query posted';
        const trendJobs = freshQueries.filter((q) => q.op === 'trend');
        if (trendJobs.length === 0) return 'no fresh trend job posted';
        const jobs = new Set(freshQueries.map((q) => q.job));
        fresh = t.events.filter(
          (e) => e.seq > mark && e.direction === 'from-worker' && e.t === 'result' && jobs.has(e.job),
        );
        return fresh.length === jobs.size ? 'all fresh results' : `${fresh.length}/${jobs.size} fresh results`;
      },
      { timeout: 30_000, message: `fresh queries for '${terms}' did not all deliver` },
    )
    .toBe('all fresh results');
  return fresh;
}

/**
 * Install a gate around the page realm's `SubtleCrypto.digest` (the main-thread
 * override hash) that holds ONLY the digest whose input carries `marker` — i.e.
 * the specific Apply's override JSON (its distinctive chapter title). Every other
 * digest, stray or not, passes through ungated; the gate disarms once it holds
 * the marked call. This makes A's install continuation deterministically blocked
 * the instant its hash runs — there is no window in which a mis-identified digest
 * could let A install. No sleeps, no app/worker seam.
 */
export async function installDigestGate(page: Page, marker: string): Promise<void> {
  await page.evaluate((marker) => {
    const orig = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let complete!: () => void;
    const completed = new Promise<void>((r) => { complete = r; });
    let consumed = false;
    const dec = new TextDecoder();
    const gated = (algo: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
      let text = '';
      try { text = dec.decode(data as ArrayBuffer); } catch { text = ''; }
      if (!consumed && text.includes(marker)) {
        consumed = true;
        crypto.subtle.digest = orig; // disarm only AFTER capturing the marked call
        return held.then(() => orig(algo, data)).then((res) => { complete(); return res; });
      }
      return orig(algo, data); // any other digest runs ungated
    };
    crypto.subtle.digest = gated as typeof crypto.subtle.digest;
    (window as unknown as { __ttDigestGate?: unknown }).__ttDigestGate = { release, completed, consumed: () => consumed };
  }, marker);
}

/** True once the gated digest was actually intercepted (the Apply's hash ran). */
export async function digestGateConsumed(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean((window as unknown as { __ttDigestGate?: { consumed(): boolean } }).__ttDigestGate?.consumed()));
}

/** Release the held digest and DRAIN — wait until the held computation actually
 *  completes, so a deliberately-late hash settlement is fully observed. */
export async function releaseDigestGate(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const g = (window as unknown as { __ttDigestGate?: { release(): void; completed: Promise<void>; consumed(): boolean } }).__ttDigestGate;
    if (!g) throw new Error('no digest gate installed');
    if (!g.consumed()) throw new Error('the digest gate was never consumed — no override hash was held');
    g.release();
    await g.completed;
  });
}

/** The id of the most recent snapshot-published (the current outline identity). */
export async function latestSnapshot(page: Page): Promise<string | null | undefined> {
  const t = await trace(page);
  return t.events.filter((e) => e.direction === 'from-worker' && e.t === 'snapshot-published').at(-1)?.snapshot;
}

/** Record all corpus asset requests from now on. */
export function trackCorpusRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/corpora/')) urls.push(request.url());
  });
  return urls;
}

/**
 * Durability barrier (M6 consult §5): direct page-context IDB polling —
 * production stays best-effort; only the TEST waits. Polls until all
 * records exist, then validates keys, payload classes, and hash agreement
 * with the authoritative manifest.
 */
export async function awaitCacheSettled(page: Page): Promise<void> {
  // Wait for ALL FOUR disposable artifact classes (§Q4): text, shard,
  // extraction, and structure. Waiting only for text+shard lets a reload race
  // the best-effort extraction/structure writes and produce a false "warm"
  // result or a flaky structure reconstruction.
  const manifest = SHERLOCK.map(({ sourceHash, textHash }) => ({ sourceHash, textHash }));
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ dbName, docs }) => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const req = indexedDB.open(dbName);
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            try {
              const count = (store: string): Promise<number> =>
                new Promise((resolve, reject) => {
                  const tx = db.transaction(store, 'readonly').objectStore(store).count();
                  tx.onsuccess = () => resolve(tx.result);
                  tx.onerror = () => reject(tx.error);
                });
              const getAll = (store: string): Promise<unknown[]> =>
                new Promise((resolve, reject) => {
                  const tx = db.transaction(store, 'readonly').objectStore(store).getAll();
                  tx.onsuccess = () => resolve(tx.result as unknown[]);
                  tx.onerror = () => reject(tx.error);
                });
              const [texts, shards, extractions, structures] = await Promise.all([
                count('texts'), count('shards'), count('extractions'), count('structures'),
              ]);
              if (texts < docs.length || shards < docs.length || extractions < docs.length || structures < docs.length) {
                return `texts=${texts} shards=${shards} extractions=${extractions} structures=${structures}`;
              }
              const [allShards, allExtractions, allStructures] = await Promise.all([
                getAll('shards'), getAll('extractions'), getAll('structures'),
              ]);
              for (const { sourceHash, textHash } of docs) {
                const text = await new Promise<unknown>((resolve, reject) => {
                  const req = db.transaction('texts', 'readonly').objectStore('texts').get(['texttrends/stored-text/1', textHash]);
                  req.onsuccess = () => resolve(req.result);
                  req.onerror = () => reject(req.error);
                });
                const t = text as { schema?: string; hash?: string; text?: string } | undefined;
                if (!t || t.schema !== 'texttrends/stored-text/1' || t.hash !== textHash || typeof t.text !== 'string') {
                  return `text record for ${textHash.slice(0, 8)} malformed`;
                }
                const s = (allShards as { schema?: string; textHash: string; shard?: { tokenTypeIds?: unknown; postings?: { positions?: unknown } } }[]).find((r) => r.textHash === textHash);
                if (!s || s.schema !== 'texttrends/stored-shard/1') return `shard record for ${textHash.slice(0, 8)} missing`;
                if (!(s.shard?.tokenTypeIds instanceof Uint32Array)) return 'tokenTypeIds not a Uint32Array after structured clone';
                if (!(s.shard?.postings?.positions instanceof Uint32Array)) return 'postings.positions not a Uint32Array';
                // Extraction: keyed by SourceHash; carries the candidate identity.
                const e = (allExtractions as { schema?: string; artifactSchema?: string; sourceHash: string; artifact?: { candidateHash?: unknown } }[]).find((r) => r.sourceHash === sourceHash);
                if (!e || e.schema !== 'texttrends/stored-extraction/1' || e.artifactSchema !== 'texttrends/extraction/1') return `extraction record for ${sourceHash.slice(0, 8)} missing`;
                if (typeof e.artifact?.candidateHash !== 'string') return 'extraction artifact missing candidate identity';
                // Structure: keyed by TextHash; carries the section array.
                const st = (allStructures as { schema?: string; artifactSchema?: string; textHash: string; artifact?: { sections?: unknown } }[]).find((r) => r.textHash === textHash);
                if (!st || st.schema !== 'texttrends/stored-structure/2' || st.artifactSchema !== 'texttrends/structure/2') return `structure record for ${textHash.slice(0, 8)} missing`;
                if (!Array.isArray(st.artifact?.sections)) return 'structure artifact missing sections array';
              }
              return 'settled';
            } finally {
              db.close();
            }
          },
          { dbName: DB_NAME, docs: manifest },
        ),
      { timeout: 30_000, message: 'cache never settled' },
    )
    .toBe('settled');
}
