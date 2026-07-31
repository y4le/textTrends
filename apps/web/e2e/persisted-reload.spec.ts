/**
 * Commit 9a — the OPTED-IN (persisted) reload, the complement to import.spec's
 * external case. Persist the source durably AND CAS-save the project, then clear
 * ONLY the disposable artifact db2 (durable user-data must survive — the
 * clear-cache isolation proof). After a reload + Load saved, the worker
 * warm-reopens from the persisted source: zero missing docs, NO main-thread
 * ingest, no reattach/source-missing state, and analysis answers fresh queries.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, clearArtifactStores, gotoPlace, submitAndAwaitFreshResults, trace, USER_DATA_DB, userDataCounts } from './helpers.ts';

const DOC_TEXT = `# Chapter One\n\n${'the wolf ran far over the hill. '.repeat(60)}`;

/** Flip one byte of every persisted source IN PLACE (same length, same key) —
 *  the envelope check cannot catch this; the warm path's pre-extraction
 *  content-hash authentication does. */
async function mutatePersistedSources(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('sources', 'readwrite');
        const store = tx.objectStore('sources');
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const record = cursor.value as { bytes: ArrayBuffer };
          const view = new Uint8Array(record.bytes);
          view[view.length - 1] = view[view.length - 1]! ^ 0xff; // same length, wrong hash
          cursor.update(record);
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, USER_DATA_DB);
}

test('a persisted source warm-reopens after a db2 clear; user data stays isolated', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');

  await page.getByLabel('Create project from files').setInputFiles({ name: 'hound.md', mimeType: 'text/markdown', buffer: Buffer.from(DOC_TEXT, 'utf-8') });
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);

  // Persist the source durably, THEN CAS-save the project (§12.6 ordering).
  await page.getByRole('button', { name: 'persist' }).click();
  await expect(page.getByLabel('Documents').getByText('persisted', { exact: true })).toBeVisible({ timeout: 30_000 });
  const save = page.getByRole('button', { name: 'Save project' });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect(page.getByText('rev 1 · saved')).toBeVisible({ timeout: 30_000 });

  // Durable user-data records exist, and survive a db2 clear (isolation).
  const before = await userDataCounts(page);
  expect(before.projects).toBeGreaterThanOrEqual(1);
  expect(before.sources).toBeGreaterThanOrEqual(1);
  await clearArtifactStores(page);
  expect(await userDataCounts(page)).toEqual(before);

  // Reload (the built-in cold-reboots into the empty db2), then Load saved.
  await page.reload();
  await awaitAllReady(page);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'Load saved project' }).click();
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);

  // The USER project's OWN generation-ready barrier reported ZERO missing (warm
  // from the persisted source). Correlated to the load-triggered begin-generation
  // by job+generation — an unrelated built-in barrier landing after the mark must
  // NOT satisfy this. (trace.dropped guards the correlation.)
  await expect
    .poll(async () => {
      const t = await trace(page);
      if (t.dropped !== 0) return 'trace dropped events';
      const begin = t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'begin-generation');
      if (begin.length === 0) return 'no user begin-generation yet';
      const g = begin.at(-1)!; // the load-triggered user generation
      const ready = t.events.filter(
        (e) => e.direction === 'from-worker' && e.t === 'generation-ready' && e.job === g.job && e.generation === g.generation,
      );
      if (ready.length === 0) return `no barrier for ${g.generation ?? '?'}`;
      return ready.every((e) => e.missingCount === 0) ? 'no-miss' : 'a doc missed';
    }, { timeout: 30_000, message: 'the persisted project did not warm-reopen without a miss' })
    .toBe('no-miss');

  const t = await trace(page);
  expect(t.dropped).toBe(0);
  expect(t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'ingest')).toHaveLength(0);

  // No missing/reattach state; the source is persisted; analysis works fresh.
  await expect(page.getByText('source missing')).toHaveCount(0);
  await expect(page.getByLabel('Documents').getByText('persisted', { exact: true })).toBeVisible();
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');
});

test('a SAME-LENGTH mutation of the persisted copy surfaces as damage needing repair; reattach heals it', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');

  // Import, persist, save — then corrupt the durable copy in place and force a
  // cold-cache reload so the warm reopen must read the damaged bytes.
  await page.getByLabel('Create project from files').setInputFiles({ name: 'hound.md', mimeType: 'text/markdown', buffer: Buffer.from(DOC_TEXT, 'utf-8') });
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);
  await page.getByRole('button', { name: 'persist' }).click();
  await expect(page.getByLabel('Documents').getByText('persisted', { exact: true })).toBeVisible({ timeout: 30_000 });
  const save = page.getByRole('button', { name: 'Save project' });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect(page.getByText('rev 1 · saved')).toBeVisible({ timeout: 30_000 });

  await mutatePersistedSources(page);
  await clearArtifactStores(page);
  await page.reload();
  await awaitAllReady(page);
  await page.getByRole('button', { name: 'Load saved project' }).click();
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });

  // The damaged durable copy is CLASSIFIED as such — the repair-specific text,
  // never the generic external "source missing", and never silently ready.
  await expect(page.getByText('persisted copy damaged — reattach to repair')).toBeVisible({ timeout: 30_000 });

  // Reattach the original file: hash matches the manifest, the repaired copy
  // persists (content-addressed re-put), and the doc becomes ready again.
  await page.getByLabel(/Reattach source for/).setInputFiles({ name: 'hound.md', mimeType: 'text/markdown', buffer: Buffer.from(DOC_TEXT, 'utf-8') });
  await awaitReadyCount(page, 1);
  await expect(page.getByText('persisted copy damaged — reattach to repair')).toHaveCount(0);
  // Readiness settles CONCURRENTLY with the durable repair write — wait for
  // the source status to return to exact `persisted` (the repair's own
  // acknowledgement) before tearing the caches down, or the reload could
  // race a still-running write (track-S review).
  await expect(page.getByLabel('Documents').getByText('persisted', { exact: true })).toBeVisible({ timeout: 30_000 });

  // And the NEXT warm reopen succeeds from the repaired durable copy.
  await clearArtifactStores(page);
  await page.reload();
  await awaitAllReady(page);
  await page.getByRole('button', { name: 'Load saved project' }).click();
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);
  await expect(page.getByText(/reattach to repair/)).toHaveCount(0);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');
});
