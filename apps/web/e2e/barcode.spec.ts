/**
 * Slice-2 commit D acceptance: the dispersion barcode over a deterministic
 * imported corpus — the strip renders with an honest per-track summary, the
 * occurrence navigation centers the merged concordance at the EXACT
 * position (job-correlated fresh evidence), and a resize issues NO worker
 * query (resident-data redraw only, ruling §D).
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, gotoPlace, submitAndAwaitFreshResults, trace } from './helpers.ts';

// wolf@1, wolf@7, fox@4 — exact ticks, deterministic.
const CORPUS = 'the wolf ran. a fox saw the wolf sleep.\n';

test('the barcode summarizes exact occurrences, steps into the concordance, and never queries on resize', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'beasts.txt', mimeType: 'text/plain', buffer: Buffer.from(CORPUS, 'utf-8'),
  });
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  // The accessible summary names the track, its EXACT total, and (here) no
  // density label.
  await expect(page.getByText('wolf: 2 occurrences')).toBeVisible();

  // Next-occurrence: a fresh job-correlated KWIC centered at wolf@1.
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'Next wolf occurrence' }).click();
  await expect
    .poll(async () => {
      const t = await trace(page);
      const q = t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'query' && e.op === 'kwic');
      if (q.length === 0) return 'no fresh kwic';
      const res = t.events.filter((e) => e.seq > mark && e.direction === 'from-worker' && e.t === 'result' && q.some((p) => p.job === e.job));
      return res.length > 0 ? 'answered' : 'no result';
    }, { timeout: 30_000 })
    .toBe('answered');
  // The caption reports the exact served center (wolf@1 → 1-based token 2).
  await gotoPlace(page, 'concordance');
  await expect(page.getByText(/nearest to .* token 2\b/)).toBeVisible();

  // Stepping again advances to wolf@7 — relative to the current center.
  await gotoPlace(page, 'trends');
  const mark2 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'Next wolf occurrence' }).click();
  await expect
    .poll(async () => {
      const t = await trace(page);
      const q = t.events.filter((e) => e.seq > mark2 && e.direction === 'to-worker' && e.t === 'query' && e.op === 'kwic');
      const res = t.events.filter((e) => e.seq > mark2 && e.direction === 'from-worker' && e.t === 'result' && q.some((p) => p.job === e.job));
      return res.length > 0 ? 'answered' : 'waiting';
    }, { timeout: 30_000 })
    .toBe('answered');
  await gotoPlace(page, 'concordance');
  await expect(page.getByText(/nearest to .* token 8\b/)).toBeVisible();

  // CANVAS CLICK: click the strip at wolf@7's x position — the inversion +
  // authoritative resolver center the concordance on that exact occurrence.
  // (First move the center elsewhere so the assertion cannot pass stale.)
  await gotoPlace(page, 'trends');
  await page.getByRole('button', { name: 'Previous wolf occurrence' }).click();
  await gotoPlace(page, 'concordance');
  await expect(page.getByText(/nearest to .* token 2\b/)).toBeVisible();
  await gotoPlace(page, 'trends');
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const mark3 = (await trace(page)).events.at(-1)?.seq ?? -1;
  // NINE word tokens in the corpus doc; wolf@7 centers at x = (7.5/9)·width
  // — the click must land ON the painted tick, proving the covering path of
  // the pixel inversion, not the dead-space nearest fallback (review-D r2).
  await canvas.click({ position: { x: box.width * (7.5 / 9), y: 3 } });
  await expect
    .poll(async () => {
      const t = await trace(page);
      const q = t.events.filter((e) => e.seq > mark3 && e.direction === 'to-worker' && e.t === 'query' && e.op === 'kwic');
      const res = t.events.filter((e) => e.seq > mark3 && e.direction === 'from-worker' && e.t === 'result' && q.some((p) => p.job === e.job));
      return res.length > 0 ? 'answered' : 'waiting';
    }, { timeout: 30_000 })
    .toBe('answered');
  await page.getByRole('dialog', { name: /Reader: beasts/ })
    .getByRole('button', { name: 'close', exact: true })
    .click();
  await gotoPlace(page, 'concordance');
  await expect(page.getByText(/nearest to .* token 8\b/)).toBeVisible();

  // RESIZE: the strip redraws from the resident result — zero worker queries.
  await gotoPlace(page, 'trends');
  const before = ((await trace(page)).events.at(-1)?.seq ?? -1);
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(400); // let any (forbidden) reissue surface
  const after = (await trace(page)).events.filter((e) => e.seq > before && e.direction === 'to-worker' && e.t === 'query');
  expect(after).toHaveLength(0);
});
