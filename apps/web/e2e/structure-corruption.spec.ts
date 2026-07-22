/**
 * Commit 9b — deep STRUCTURE-artifact corruption repair, the phase-closing
 * cache-integrity proof. Tamper an INNER invariant (the root range disagrees
 * with the known text length) while keeping the storage envelope and key valid.
 * The reload warns exactly once, rebuilds ONLY the structure (text/shard/
 * extraction stay warm — no fetch, no decode/extract/segment/index), re-persists
 * an artifact deep-equal to the deterministic original, answers a fresh
 * victim-correlated structure query bound to the final snapshot with the
 * detected chapters, and the next reload is fully warm with its own fresh query.
 */

import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, awaitCacheSettled, DB_NAME, DOC_COUNT, events, SHERLOCK, trace, trackCorpusRequests } from './helpers.ts';

const victim = SHERLOCK[0]!; // "A Study in Scarlet" — 15 detected chapters

/** The `structures` store key tuple (idb-store.ts keyPath). */
type StructKey = [string, string, string, string, string];

/** Discover the victim's FULL structure key (by its known textHash) and its
 *  current artifact. Every later read/write addresses that exact key. */
async function captureVictim(page: Page): Promise<{ key: StructKey; artifact: { sections: { key: string; origin: string; title?: string; chars: { start: number; end: number } }[] } }> {
  return page.evaluate(
    async ({ dbName, textHash }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const rec = await new Promise<{ artifactSchema: string; textHash: string; candidateHash: string; recipeHash: string; overrideHash: string; artifact: unknown }>((resolve, reject) => {
          const tx = db.transaction('structures', 'readonly').objectStore('structures').getAll();
          tx.onsuccess = () => resolve((tx.result as never[]).find((r: { textHash: string }) => r.textHash === textHash)!);
          tx.onerror = () => reject(tx.error);
        });
        return { key: [rec.artifactSchema, rec.textHash, rec.candidateHash, rec.recipeHash, rec.overrideHash] as [string, string, string, string, string], artifact: rec.artifact as never };
      } finally {
        db.close();
      }
    },
    { dbName: DB_NAME, textHash: victim.textHash },
  );
}

/** Read the artifact at the EXACT structure key. */
async function readArtifactByKey(page: Page, key: StructKey): Promise<unknown> {
  return page.evaluate(
    async ({ dbName, key }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const rec = await new Promise<{ artifact: unknown } | undefined>((resolve, reject) => {
          const req = db.transaction('structures', 'readonly').objectStore('structures').get(key);
          req.onsuccess = () => resolve(req.result as { artifact: unknown } | undefined);
          req.onerror = () => reject(req.error);
        });
        return rec?.artifact ?? null;
      } finally {
        db.close();
      }
    },
    { dbName: DB_NAME, key },
  );
}

/** Correlate a FRESH structure query for the victim (posted after `mark`) to a
 *  result on the given snapshot. Fails on a dropped trace. */
async function awaitVictimStructureAnswer(page: Page, mark: number, snapshot: string | null | undefined): Promise<void> {
  await expect
    .poll(async () => {
      const t = await trace(page);
      if (t.dropped !== 0) return 'trace dropped events';
      const q = t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'query' && e.op === 'structure');
      if (q.length === 0) return 'no fresh structure query';
      const res = t.events.filter((e) => e.seq > mark && e.direction === 'from-worker' && e.t === 'result' && e.op === 'structure' && q.some((p) => p.job === e.job));
      if (res.length === 0) return 'no fresh structure result';
      return res.some((e) => e.snapshot === snapshot) ? 'answered' : 'wrong snapshot';
    }, { timeout: 30_000, message: 'no victim-correlated structure result on the expected snapshot' })
    .toBe('answered');
}

/** Focus away from the victim, mark, then focus the victim — returns the mark
 *  captured immediately before the victim's own query is posted. */
async function refocusVictim(page: Page): Promise<number> {
  const selector = page.getByLabel('Document to preview');
  await selector.selectOption(SHERLOCK[1]!.doc); // move away first
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1; // mark immediately before selecting the victim
  await selector.selectOption(victim.doc);
  return mark;
}

test('a corrupt cached structure warns, recomposes only structure, and re-persists the deterministic original', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await awaitCacheSettled(page);

  // Capture the exact key + deterministic original, then tamper the root range
  // (an inner invariant) — awaiting the WRITE TRANSACTION's completion.
  const { key, artifact } = await captureVictim(page);
  const originalJson = JSON.stringify(artifact);
  const chapterTitle = artifact.sections.find((s) => s.origin !== 'fixed' && s.title)!.title!;
  await page.evaluate(
    async ({ dbName, key }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('structures', 'readwrite');
          const store = tx.objectStore('structures');
          const get = store.get(key);
          get.onsuccess = () => {
            const rec = get.result as { artifact: { sections: { key: string; chars: { end: number } }[] } };
            rec.artifact.sections.find((s) => s.key === 'root')!.chars.end -= 1;
            store.put(rec); // in-line keyPath — no explicit key
          };
          get.onerror = () => reject(get.error);
          tx.oncomplete = () => resolve(); // resolve ONLY on commit
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error('tamper aborted'));
        });
      } finally {
        db.close();
      }
    },
    { dbName: DB_NAME, key },
  );

  const corpusRequests = trackCorpusRequests(page);
  await page.reload();
  await awaitAllReady(page);

  // Exactly one corruption warning; NO fetch (text was still cached).
  const t = await trace(page);
  expect(t.dropped).toBe(0);
  expect(events(t, { direction: 'from-worker', t: 'warning', code: 'CACHE_CORRUPT' }).length).toBe(1);
  expect(corpusRequests).toEqual([]);

  // ONLY structure is recomposed for the victim — text/shard/extraction stayed
  // warm, so no decode/extract/segment/index and no other doc rebuilds.
  expect(events(t, { direction: 'from-worker', t: 'progress', phase: 'structure' }).map((e) => e.doc)).toEqual([victim.doc]);
  for (const phase of ['decode', 'extract', 'segment', 'index']) {
    expect(events(t, { direction: 'from-worker', t: 'progress', phase })).toEqual([]);
  }
  const published = events(t, { direction: 'from-worker', t: 'snapshot-published' });
  expect(published.at(-1)!.readyCount).toBe(DOC_COUNT); // final readiness includes the victim

  // The repair persisted a structure artifact DEEP-EQUAL to the deterministic
  // original, at the EXACT key (presence alone cannot prove it).
  await expect
    .poll(async () => (JSON.stringify(await readArtifactByKey(page, key)) === originalJson ? 'repaired' : 'not yet'), { timeout: 30_000, message: 'the structure artifact was not re-persisted to its original' })
    .toBe('repaired');

  // Focus the victim (away-and-back) and correlate ITS fresh structure query to
  // the final snapshot; the detected chapters are populated.
  const mark = await refocusVictim(page);
  await awaitVictimStructureAnswer(page, mark, published.at(-1)!.snapshot);
  await expect(page.getByText(chapterTitle, { exact: true })).toBeVisible({ timeout: 30_000 });

  // Third reload: fully warm — no warning, no recomposition, and the victim's
  // structure query still answers freshly (§3 step 5).
  await page.reload();
  await awaitAllReady(page);
  const t3 = await trace(page);
  expect(t3.dropped).toBe(0);
  expect(events(t3, { direction: 'from-worker', t: 'warning', code: 'CACHE_CORRUPT' })).toEqual([]);
  expect(events(t3, { direction: 'from-worker', t: 'progress', phase: 'structure' })).toEqual([]);
  const finalSnapshot3 = events(t3, { direction: 'from-worker', t: 'snapshot-published' }).at(-1)!.snapshot;
  const mark3 = await refocusVictim(page);
  await awaitVictimStructureAnswer(page, mark3, finalSnapshot3);
});
