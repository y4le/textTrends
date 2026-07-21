/**
 * Shared helpers for the real-browser suite. Assertions read the sanitized
 * protocol trace exposed by the e2e build (`window.__ttE2E`) and raw
 * IndexedDB from page context; nothing here touches app internals.
 */

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { SHERLOCK } from '../src/lib/store.ts';
import type { TraceSnapshot, ProtocolTraceEvent } from '../src/lib/trace.ts';

export { SHERLOCK };
export const DOC_COUNT = SHERLOCK.length;
export const DB_NAME = 'texttrends-artifacts-provisional-db2';

export const READY_TEXT = `${DOC_COUNT}/${DOC_COUNT} books ready`;

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
