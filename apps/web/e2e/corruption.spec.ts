/**
 * Real-IDB corruption repair (plan M6 bullet; M6 consult §5): tamper an
 * INNER shard field while preserving the storage envelope and key — the
 * adapter shallow-admits it, the engine's deep validation rejects it — and
 * prove the reload warns once, rebuilds ONLY that document from its
 * verified stored text (no fetch), persists the repair, and the next
 * reload is fully warm again.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitCacheSettled, DB_NAME, DOC_COUNT, events, SHERLOCK, trace, trackCorpusRequests } from './helpers.ts';

const victim = SHERLOCK[2]!; // any single doc

test('a corrupt cached shard warns, rebuilds locally, and the repair persists', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await awaitCacheSettled(page);

  // Tamper: replace tokenTypeIds with a plain array — envelope intact.
  await page.evaluate(
    async ({ dbName, textHash }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const record = await new Promise<{ shard: { tokenTypeIds: unknown } } & Record<string, unknown>>((resolve, reject) => {
          const tx = db.transaction('shards', 'readonly').objectStore('shards').getAll();
          tx.onsuccess = () => resolve((tx.result as ({ textHash: string; shard: { tokenTypeIds: unknown } } & Record<string, unknown>)[]).find((r) => r.textHash === textHash)!);
          tx.onerror = () => reject(tx.error);
        });
        record.shard.tokenTypeIds = [1, 2, 3]; // not a Uint32Array
        await new Promise((resolve, reject) => {
          const tx = db.transaction('shards', 'readwrite').objectStore('shards').put(record);
          tx.onsuccess = () => resolve(undefined);
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    { dbName: DB_NAME, textHash: victim.textHash },
  );

  const corpusRequests = trackCorpusRequests(page);
  await page.reload();
  await awaitAllReady(page);

  // One corruption warning; NO fetch — the verified text was still cached.
  const t = await trace(page);
  const corrupt = events(t, { direction: 'from-worker', t: 'warning', code: 'CACHE_CORRUPT' });
  expect(corrupt.length).toBe(1);
  expect(corpusRequests).toEqual([]);

  // ONLY the victim re-segments/indexes; the five hits publish first as one
  // snapshot, the rebuilt document adds a second.
  const segmented = events(t, { direction: 'from-worker', t: 'progress', phase: 'segment' });
  expect(segmented.map((e) => e.doc)).toEqual([victim.doc]);
  // The verified text was still valid — only the shard was corrupt — so the
  // victim must NOT re-decode or re-extract. The rebuild is segment/index only.
  expect(events(t, { direction: 'from-worker', t: 'progress', phase: 'decode' })).toEqual([]);
  expect(events(t, { direction: 'from-worker', t: 'progress', phase: 'extract' })).toEqual([]);
  const published = events(t, { direction: 'from-worker', t: 'snapshot-published' });
  expect(published.length).toBe(2);
  expect(published[0]!.readyCount).toBe(DOC_COUNT - 1);
  expect(published[1]!.readyCount).toBe(DOC_COUNT);
  const barriers = events(t, { direction: 'from-worker', t: 'generation-ready' });
  expect(barriers[0]!.missingCount).toBe(0);

  // The REPAIR persisted: poll the tampered field until it is a real typed
  // array again (record count alone cannot prove repair — the corrupt
  // record occupied the same key throughout).
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ dbName, textHash }) => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const req = indexedDB.open(dbName);
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            try {
              const record = await new Promise<{ shard?: { tokenTypeIds?: unknown } } | undefined>((resolve, reject) => {
                const tx = db.transaction('shards', 'readonly').objectStore('shards').getAll();
                tx.onsuccess = () => resolve((tx.result as ({ textHash: string; shard?: { tokenTypeIds?: unknown } })[]).find((r) => r.textHash === textHash));
                tx.onerror = () => reject(tx.error);
              });
              return record?.shard?.tokenTypeIds instanceof Uint32Array ? 'repaired' : 'still corrupt';
            } finally {
              db.close();
            }
          },
          { dbName: DB_NAME, textHash: victim.textHash },
        ),
      { timeout: 30_000 },
    )
    .toBe('repaired');

  // Third reload: fully warm again — one snapshot, zero re-tokenization.
  await page.reload();
  await awaitAllReady(page);
  const t3 = await trace(page);
  expect(events(t3, { direction: 'from-worker', t: 'progress' }).filter((e) => e.phase !== 'compose')).toEqual([]);
  expect(events(t3, { direction: 'from-worker', t: 'snapshot-published' }).length).toBe(1);
  expect(events(t3, { direction: 'from-worker', t: 'warning', code: 'CACHE_CORRUPT' })).toEqual([]);
});
