/**
 * Commit 9a — the OPTED-IN (persisted) reload, the complement to import.spec's
 * external case. Persist the source durably AND CAS-save the project, then clear
 * ONLY the disposable artifact db2 (durable user-data must survive — the
 * clear-cache isolation proof). After a reload + Load saved, the worker
 * warm-reopens from the persisted source: zero missing docs, NO main-thread
 * ingest, no reattach/source-missing state, and analysis answers fresh queries.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, clearArtifactStores, submitAndAwaitFreshResults, trace, userDataCounts } from './helpers.ts';

const DOC_TEXT = `# Chapter One\n\n${'the wolf ran far over the hill. '.repeat(60)}`;

test('a persisted source warm-reopens after a db2 clear; user data stays isolated', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);

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
  await submitAndAwaitFreshResults(page, 'wolf');
});
