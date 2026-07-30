import { expect, test } from '@playwright/test';
import { awaitAllReady, trace } from './helpers.ts';

test('Scope states resident corpus truth and follows the committed range', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);

  const scope = page.getByRole('region', { name: 'Scope' });
  await expect(scope.getByText('Sherlock Holmes', { exact: true })).toBeVisible();
  await expect(scope.getByText('6/6 books ready', { exact: true })).toBeVisible();

  const dashboardTokens = await page
    .getByRole('heading', { name: 'Corpus overview' })
    .locator('..')
    .locator('dt', { hasText: /^tokens$/ })
    .locator('..')
    .locator('dd')
    .innerText();
  await expect(scope.getByText(`${dashboardTokens} tokens`, { exact: true })).toBeVisible();

  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  await scrubber.press('ArrowRight');
  await scrubber.press('ArrowRight');
  await scrubber.press('Enter');

  await expect(scope.getByText('1 book in scope', { exact: true })).toBeVisible();
  await expect(scope.getByText(/tokens 1–3 · 3 tokens/)).toBeVisible();
  await expect(scope.getByRole('status')).toContainText('1 book in scope');

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scope.getByRole('button', { name: 'Clear linked range' }).click();
  await expect(scope.getByText('all 6 books', { exact: true })).toBeVisible();
  await expect(scope.getByRole('button', { name: 'Clear linked range' })).toHaveCount(0);

  const after = await trace(page);
  const clearOps = after.events
    .filter(
      (event) =>
        event.seq > mark
        && event.direction === 'to-worker'
        && event.t === 'query',
    )
    .map((event) => event.op);
  expect(clearOps.length).toBeGreaterThan(0);
  expect(new Set(clearOps)).toEqual(new Set(['kwic', 'inventory', 'freq-list']));

  // A direct evidence activation outside a committed range clears the live
  // range without reissuing inventory today. Scope must reject that resident,
  // range-issued inventory rather than durably calling 3 tokens "all".
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  await scrubber.press('ArrowRight');
  await scrubber.press('ArrowRight');
  await scrubber.press('Enter');
  await expect(scope.getByText('1 book in scope', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next Holmes occurrence' }).click();
  await expect(scope.getByRole('button', { name: 'Clear linked range' })).toHaveCount(0);
  await expect(scope.getByText('all 6 books', { exact: true })).toBeVisible();
  await expect(scope.getByText('3 tokens', { exact: true })).toHaveCount(0);
  await expect(scope.getByRole('status')).not.toContainText('tokens 1–3');
});
