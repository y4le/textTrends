/**
 * Warm reopen — the user-visible payoff of Milestone 5, proven against
 * REAL IndexedDB structured clone and a real page reload: zero corpus
 * fetches, zero decode/segment/index, one snapshot, an all-ready barrier,
 * and a working UI. The durability barrier polls page-context IDB; the
 * app itself never waits on persistence.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitCacheSettled, DOC_COUNT, events, gotoPlace, submitAndAwaitFreshResults, trace, trackCorpusRequests } from './helpers.ts';

test('warm reload: zero fetches, zero re-tokenization, one snapshot, all-ready barrier', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await awaitCacheSettled(page);

  const corpusRequests = trackCorpusRequests(page);
  await page.reload();
  await awaitAllReady(page);
  // The DOM readiness summary can render a few milliseconds before the
  // worker's ordered generation-ready barrier reaches the passive trace.
  // Poll the trace rather than racing one immediate observation against that
  // delivery; this is synchronization, not a retry of the generation.
  await expect
    .poll(
      async () => events(
        await trace(page),
        { direction: 'from-worker', t: 'generation-ready' },
      ).length,
      { timeout: 10_000 },
    )
    .toBe(1);

  expect(corpusRequests).toEqual([]);

  const t = await trace(page);
  const phases = events(t, { direction: 'from-worker', t: 'progress' }).map((e) => e.phase);
  // An exact warm reopen does NO build work of any kind: no decode/extract
  // (no source touched), no segment/index (shard admitted). Compose on warm
  // reopen is an implementation choice.
  expect(phases.filter((p) => p === 'decode' || p === 'extract' || p === 'segment' || p === 'index')).toEqual([]);

  const published = events(t, { direction: 'from-worker', t: 'snapshot-published' });
  expect(published.length).toBe(1);
  expect(published[0]!.readyCount).toBe(DOC_COUNT);

  const barriers = events(t, { direction: 'from-worker', t: 'generation-ready' });
  expect(barriers.length).toBe(1);
  expect(barriers[0]!.missingCount).toBe(0);
  expect(barriers[0]!.readyCount).toBe(DOC_COUNT);

  // The rehydrated corpus answers in both Trends and Catalog.
  await expect(page.locator('svg').first()).toBeVisible();
  await gotoPlace(page, 'inputs');
  await expect(page.getByRole('table', { name: 'Book analysis' })).toBeVisible();

  // A NEW query against the rehydrated index — awaited by its own fresh
  // job's result, never satisfied by pre-reload evidence.
  await submitAndAwaitFreshResults(page, 'watson');
});
