/**
 * Real worker death and recovery (plan M6 bullet; M6 consult §7): schedule
 * an UNCAUGHT error inside the actual worker (terminate() deliberately
 * fires no error event), and prove the client replaces the instance, the
 * app re-opens its generation, and rehydration makes recovery warm — no
 * fetch, no re-tokenization.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitCacheSettled, DOC_COUNT, submitAndAwaitFreshResults, trace, trackCorpusRequests } from './helpers.ts';

test('an uncaught worker error respawns, warm-reopens, and queries keep working', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await awaitCacheSettled(page);

  const corpusRequests = trackCorpusRequests(page);
  const lastSeqBeforeCrash = (await trace(page)).events.at(-1)?.seq ?? -1;

  const oldWorker = page.workers()[0]!;
  const newWorkerPromise = page.waitForEvent('worker');
  await oldWorker.evaluate(() => {
    // Thrown AFTER evaluate returns — an uncaught error in worker scope
    // reaches the owning Worker.onerror, the path terminate() never takes.
    setTimeout(() => {
      throw new Error('__texttrends_e2e_worker_crash__');
    }, 0);
  });
  const newWorker = await newWorkerPromise;
  expect(newWorker.url()).toBe(oldWorker.url());

  // The app recovers to all-ready without any network or re-tokenization. The
  // warm reopen publishes its snapshot and THEN emits the barrier a beat later,
  // so wait for the recovery barrier explicitly rather than racing a single
  // trace snapshot against it.
  await awaitAllReady(page);
  await expect
    .poll(async () => (await trace(page)).events.filter((e) => e.seq > lastSeqBeforeCrash && e.direction === 'from-worker' && e.t === 'generation-ready').length, { timeout: 10_000 })
    .toBe(1);
  const t = await trace(page);
  const after = t.events.filter((e) => e.seq > lastSeqBeforeCrash);
  expect(after.some((e) => e.direction === 'client' && e.t === 'restart' && e.code === 'respawn')).toBe(true);
  const phasesAfter = after.filter((e) => e.direction === 'from-worker' && e.t === 'progress' && e.phase !== 'compose');
  expect(phasesAfter).toEqual([]);
  expect(corpusRequests).toEqual([]);
  const barriers = after.filter((e) => e.direction === 'from-worker' && e.t === 'generation-ready');
  expect(barriers.length).toBe(1);
  expect(barriers[0]!.missingCount).toBe(0);
  expect(barriers[0]!.readyCount).toBe(DOC_COUNT);
  // No fatal state: the load-error UI is absent.
  await expect(page.getByText(/crashed repeatedly/)).toHaveCount(0);

  // A fresh query runs against the REPLACEMENT worker's snapshot — awaited
  // by its own job's result, not by anything the dead worker produced.
  await submitAndAwaitFreshResults(page, 'lestrade');
});
