/**
 * Commit B acceptance (planner ruling §6.3): the nearest-to-axis, all-terms
 * concordance in the real browser. A tiny deterministic imported corpus + the
 * KEYBOARD scrubber (no fragile pointer pixels): move the axis to the end, wait
 * for the centred KWIC result, assert both terms are tagged and the nearest hit
 * leads; then toggle one term off and assert only that track disappears.
 */

import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, trace, clearNotebook, gotoPlace, openQuickAdd } from './helpers.ts';

// wolf@1,@7 · fox@4,@10 (12 tokens). Nearest to the last token (11): fox@10,
// wolf@7, fox@4, wolf@1.
const CORPUS = 'the wolf ran. a fox hid. the wolf slept. a fox fled.\n';

/** Wait for a KWIC query posted after `mark` to deliver its result. */
async function awaitFreshKwic(page: Page, mark: number): Promise<void> {
  await expect
    .poll(async () => {
      const t = await trace(page);
      if (t.dropped !== 0) return 'trace dropped events';
      const q = t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'query' && e.op === 'kwic');
      if (q.length === 0) return 'no fresh kwic query';
      const res = t.events.filter((e) => e.seq > mark && e.direction === 'from-worker' && e.t === 'result' && e.op === 'kwic' && q.some((p) => p.job === e.job));
      return res.length > 0 ? 'answered' : 'no result';
    }, { timeout: 30_000, message: 'the concordance did not deliver a fresh result' })
    .toBe('answered');
}

/** The node text of each concordance row, top to bottom. */
async function rowTerms(page: Page): Promise<string[]> {
  return page.getByRole('table', { name: 'Concordance' }).locator('tbody tr .kwic-node').allInnerTexts();
}

/** Each concordance row's node + right-context — enough to
 *  distinguish two occurrences of the SAME term (fox@10's right is 'fled'). */
async function rowDetails(page: Page): Promise<{ term: string; right: string }[]> {
  const trs = page.getByRole('table', { name: 'Concordance' }).locator('tbody tr');
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

test('the concordance merges all terms nearest the axis and toggles a term off', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'catalog');
  await page.getByLabel('Create project from files').setInputFiles({ name: 'beasts.txt', mimeType: 'text/plain', buffer: Buffer.from(CORPUS, 'utf-8') });
  await expect(page.getByRole('heading', { name: 'library corpus', exact: true })).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);

  // Compare two terms; the concordance merges BOTH by default (reading order).
  await gotoPlace(page, 'trends');
  const mark0 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await clearNotebook(page);
  const input = await openQuickAdd(page);
  await input.fill('wolf, fox');
  await input.press('Enter');
  await awaitFreshKwic(page, mark0);
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('table', { name: 'Concordance' })).toBeVisible({ timeout: 30_000 });
  expect(new Set(await rowTerms(page))).toEqual(new Set(['wolf', 'fox'])); // both tagged

  // A single-book corpus keeps only token progress in the rightmost column.
  await expect(page.getByRole('table', { name: 'Concordance' })
    .getByRole('columnheader', { name: 'token', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Concordance' })
    .locator('tbody .kwic-book').first()).toHaveText(/^\d+ \/ \d+$/);
  // Catalog labels the book by reading-order ordinal + title alongside exact totals.
  await gotoPlace(page, 'catalog');
  await expect(page.getByRole('table', { name: 'Book analysis' }).getByText('1 · beasts')).toBeVisible();

  // Move the axis to the END via the KEYBOARD scrubber (token 12 of 12). The
  // concordance re-centres: the nearest hit is the LAST fox (fox@10, right
  // context 'fled'), then wolf@7, fox@4, wolf@1 — proving the End-key center and
  // the merged proximity order, not merely "a fox is first".
  await gotoPlace(page, 'trends');
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  const mark1 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scrubber.press('End');
  await awaitFreshKwic(page, mark1);
  // The served End token, captioned with the metadata title (not the doc id).
  await gotoPlace(page, 'concordance');
  await expect(page.getByText(/nearest to beasts · token 12\b/)).toBeVisible();
  // The scrubber's accessible position text uses the same metadata title.
  await gotoPlace(page, 'trends');
  await expect(page.getByRole('slider', { name: /reading position/i }))
    .toHaveAttribute('aria-valuetext', /^beasts · token 12\b/);
  await gotoPlace(page, 'concordance');
  await expect
    .poll(async () => (await rowDetails(page)).map((r) => r.term), { message: 'wrong merged proximity order' })
    .toEqual(['fox', 'wolf', 'fox', 'wolf']);
  expect((await rowDetails(page))[0]!.right).toContain('fled'); // fox@10, NOT fox@4

  // Toggle 'fox' OFF: a fresh concordance drops that track, keeps wolf.
  const mark2 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('group', { name: 'Concordance terms' }).getByRole('button', { name: /fox/ }).click();
  await awaitFreshKwic(page, mark2);
  await expect.poll(async () => new Set(await rowTerms(page)), { message: 'fox track did not disappear' }).toEqual(new Set(['wolf']));
});
