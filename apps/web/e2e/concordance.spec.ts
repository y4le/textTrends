/**
 * Continuous corpus-order Concordance acceptance in the real browser. A tiny
 * deterministic corpus proves merged order, shared-cursor synchronization,
 * and enabled-track filtering without a proximity sort.
 */

import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, clearDemoInputs, trace, gotoPlace, submitAndAwaitFreshResults } from './helpers.ts';

// wolf@1,@7 · fox@4,@10 (12 tokens), merged in declared corpus order.
const CORPUS = 'the wolf ran. a fox hid. the wolf slept. a fox fled.\n';

/** Wait for a Concordance window posted after `mark` to deliver its result. */
async function awaitFreshConcordance(page: Page, mark: number): Promise<void> {
  await expect
    .poll(async () => {
      const t = await trace(page);
      if (t.dropped !== 0) return 'trace dropped events';
      const q = t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'query' && e.op === 'concordance-window');
      if (q.length === 0) return 'no fresh concordance query';
      const res = t.events.filter((e) => e.seq > mark && e.direction === 'from-worker' && e.t === 'result' && e.op === 'concordance-window' && q.some((p) => p.job === e.job));
      return res.length > 0 ? 'answered' : 'no result';
    }, { timeout: 30_000, message: 'the concordance did not deliver a fresh result' })
    .toBe('answered');
}

/** The node text of each concordance row, top to bottom. */
async function rowTerms(page: Page): Promise<string[]> {
  return page.getByRole('grid', { name: 'Concordance' }).locator('[role="row"][aria-rowindex] .kwic-node').allInnerTexts();
}

/** Each concordance row's node + right-context — enough to
 *  distinguish two occurrences of the SAME term (fox@10's right is 'fled'). */
async function rowDetails(page: Page): Promise<{ term: string; right: string }[]> {
  const trs = page.getByRole('grid', { name: 'Concordance' }).locator('[role="row"][aria-rowindex]');
  const n = await trs.count();
  const out: { term: string; right: string }[] = [];
  for (let i = 0; i < n; i++) {
    const row = trs.nth(i);
    out.push({
      term: (await row.locator('.kwic-node').innerText()).trim(),
      right: await row.locator('.kwic-right-context').innerText(),
    });
  }
  return out;
}

test('the concordance merges all terms in corpus order and toggles a term off', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({ name: 'beasts.txt', mimeType: 'text/plain', buffer: Buffer.from(CORPUS, 'utf-8') });
  await expect(page.getByRole('region', { name: 'Inputs', exact: true })).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);

  // Compare two terms; the concordance merges BOTH by default (reading order).
  await gotoPlace(page, 'trends');
  const mark0 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await submitAndAwaitFreshResults(page, 'wolf, fox');
  await awaitFreshConcordance(page, mark0);
  await gotoPlace(page, 'concordance');
  const grid = page.getByRole('grid', { name: 'Concordance' });
  await expect(grid).toBeVisible({ timeout: 30_000 });
  expect(new Set(await rowTerms(page))).toEqual(new Set(['wolf', 'fox'])); // both tagged

  // A single-book corpus omits the redundant book column and keeps token
  // progress in its own rightmost column.
  await expect(grid.locator('.kwic-book-heading')).toHaveCount(0);
  await expect(grid.getByRole('separator', { name: 'Book width' })).toHaveCount(0);
  await expect(grid
    .getByRole('columnheader', { name: 'token', exact: true })).toBeVisible();
  await expect(grid.locator('[role="row"][aria-rowindex] .kwic-book')).toHaveCount(0);
  await expect(grid.locator('[role="row"][aria-rowindex] .kwic-token').first())
    .toHaveText(/^\d+ \/ \d+$/);
  // Catalog labels the book by reading-order ordinal + title alongside exact totals.
  await gotoPlace(page, 'inputs');
  await expect(page.getByRole('table', { name: 'Text details' }).getByText('1 · beasts')).toBeVisible();

  // Move the shared cursor to the END via the keyboard scrubber. The logical
  // surface stays in corpus order and selects its last row without requerying:
  // the four-row result is already wholly resident.
  await gotoPlace(page, 'trends');
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  const mark1 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scrubber.press('End');
  await gotoPlace(page, 'concordance');
  await expect(grid).toHaveAttribute('aria-activedescendant', 'concordance-row-3');
  await page.waitForTimeout(200);
  expect((await trace(page)).events.filter((event) =>
    event.seq > mark1
    && event.direction === 'to-worker'
    && event.t === 'query'
    && event.op === 'concordance-window')).toEqual([]);
  // Concordance centers the nearest enabled mention and publishes that exact
  // mention back to the shared scrubber.
  await gotoPlace(page, 'trends');
  await expect(page.getByRole('slider', { name: /reading position/i }))
    .toHaveAttribute('aria-valuetext', /^beasts · token 11\b/);
  await gotoPlace(page, 'concordance');
  await expect
    .poll(async () => (await rowDetails(page)).map((r) => r.term), { message: 'wrong merged corpus order' })
    .toEqual(['wolf', 'fox', 'wolf', 'fox']);
  await expect(grid.locator('[role="row"][aria-selected="true"] .kwic-right-context'))
    .toContainText('fled');

  // Toggle 'fox' OFF in the shared terms rail: a fresh concordance drops
  // that globally hidden track and keeps wolf.
  const mark2 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('complementary', { name: 'Terms' })
    .getByRole('button', { name: 'Shown in analysis: fox' }).click();
  await awaitFreshConcordance(page, mark2);
  await expect.poll(async () => new Set(await rowTerms(page)), { message: 'fox track did not disappear' }).toEqual(new Set(['wolf']));
});
