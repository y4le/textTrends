/**
 * Destructive protocol probes on the e2e-only harness page (M6 consult
 * §2/§6): the generation/recipe replacement race with real task-queue
 * delivery, and the cancellation transport smoke test. Exhaustive
 * interleavings remain unit-suite territory; these prove the real wire.
 */

import { expect, test } from '@playwright/test';

test('a mid-ingest generation replacement never accepts stale publication', async ({ page }) => {
  await page.goto('./e2e-harness.html');
  await page.waitForFunction(() => window.__ttHarness?.ready === true);
  const result = await page.evaluate(() => window.__ttHarness!.runGenerationRace());
  expect(result.staleAfterReplacement).toEqual([]);
  expect(result.bSnapshotQueryCount).toBeGreaterThan(0);
  expect(result.ok).toBe(true);
});

test('cancellation is acknowledged over the real task queue', async ({ page }) => {
  await page.goto('./e2e-harness.html');
  await page.waitForFunction(() => window.__ttHarness?.ready === true);
  const result = await page.evaluate(() => window.__ttHarness!.runCancelProbe(5));
  // Some queries may legally complete before the cancel is observed; the
  // transport claim needs at least SOME real acknowledgements.
  expect(result.ackMs.length).toBeGreaterThan(0);
  for (const ms of result.ackMs) expect(ms).toBeGreaterThanOrEqual(0);
});
