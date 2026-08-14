import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';

test('Scope states resident corpus truth and follows the committed range', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');

  const scope = page.getByRole('region', { name: 'Corpus status' });
  await expect(scope.getByText('Library corpus', { exact: true })).toBeVisible();
  await expect(scope.getByText('6/6 books ready', { exact: true })).toBeVisible();

  const dashboardTokens = await page
    .locator('.catalog-summary')
    .locator('dt', { hasText: /^tokens$/ })
    .locator('..')
    .locator('dd')
    .innerText();
  await expect(scope.getByText(`${dashboardTokens} tokens`, { exact: true })).toBeVisible();

  await gotoPlace(page, 'trends');
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  await scrubber.press('ArrowRight');
  await scrubber.press('ArrowRight');
  await scrubber.press('Enter');

  await expect(scope.getByText('1 book in scope', { exact: true })).toBeVisible();
  await expect(scope.getByRole('button', {
    name: /tokens 1–3 · 3 tokens — review linked range in Trends/,
  }))
    .toContainText(/tokens 1–3 · 3 tokens/);
  await expect(scope.getByRole('status')).toContainText('1 book in scope');

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scope.getByRole('button', { name: 'Clear linked range' }).click();
  await expect(scope.getByText('all 6 books', { exact: true })).toBeVisible();
  await expect(scope.getByRole('button', { name: 'Clear linked range' })).toHaveCount(0);

  const after = await trace(page);
  // The global transient footer owns its own debounced source-page lane; it
  // is navigation traffic, not a linked-range analysis consumer.
  const clearOps = after.events
    .filter(
      (event) =>
        event.seq > mark
        && event.direction === 'to-worker'
        && event.t === 'query',
    )
    .filter((event) => event.op !== 'reader-page')
    .map((event) => event.op);
  expect(clearOps.length).toBeGreaterThan(0);
  expect(new Set(clearOps)).toEqual(new Set(['freq-list']));
  // Inputs reuses its authenticated full-corpus inventory; clearing a range
  // must not issue another identical inventory request.
  expect(clearOps).not.toContain('inventory');

  // Full-corpus occurrence navigation is independent of the analytical range.
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  await scrubber.press('ArrowRight');
  await scrubber.press('ArrowRight');
  await scrubber.press('Enter');
  await expect(scope.getByText('1 book in scope', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next Holmes occurrence' }).click();
  await expect(scope.getByRole('button', { name: 'Clear linked range' })).toBeVisible();
  await expect(scope.getByText('1 book in scope', { exact: true })).toBeVisible();
  await expect(scope.getByRole('status')).toContainText('tokens 1–3');
});
