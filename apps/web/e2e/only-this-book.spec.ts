import { expect, test } from '@playwright/test';
import { awaitAllReady, clearNotebook, gotoPlace, trace } from './helpers.ts';

test('text detail preserves scope while select this text explicitly rescopes linked analyses', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');

  const scope = page.getByRole('region', { name: 'Corpus status' });
  const documents = page.getByRole('table', { name: 'Text details' });
  const rows = documents.locator(':scope > tbody > tr[data-catalog-book]');
  await expect(rows).toHaveCount(6);
  const dashboardTokenValue = page
    .locator('.catalog-summary')
    .locator('dt', { hasText: /^tokens$/ })
    .locator('..')
    .locator('dd');
  const baselineTokens = await dashboardTokenValue.innerText();

  const secondRow = rows.nth(1);
  const titleButton = secondRow.getByRole('rowheader').getByRole('button');
  await expect(titleButton).toHaveAttribute('aria-expanded', 'false');
  const declaredTitle = await titleButton.innerText();
  const title = declaredTitle.replace(/^\d+\s*·\s*/, '');
  const beforeFocus = (await trace(page)).events.at(-1)?.seq ?? -1;
  await titleButton.click();
  await expect(titleButton).toHaveAttribute('aria-expanded', 'true');
  const controlledDetail = await titleButton.getAttribute('aria-controls');
  expect(controlledDetail).not.toBeNull();
  expect(controlledDetail).not.toMatch(/\s/u);
  const textDetail = page.getByRole('region', { name: `Text detail: ${title}` });
  await expect(textDetail).toBeVisible();
  await expect(page.getByRole('region', { name: 'Measurements' })).toBeVisible();
  await expect(textDetail.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  await expect(textDetail.getByRole('heading', { name: 'Measurements' })).toHaveCount(0);
  await expect(textDetail.getByText(/^These measurements describe/)).toHaveCount(0);
  await expect(textDetail.getByRole('region', { name: 'Term counts' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Sentence rhythm' })).toHaveCount(0);
  const termCountsBefore = await secondRow.locator('.catalog-term-total').allInnerTexts();
  await expect(dashboardTokenValue).toHaveText(baselineTokens);
  const focusOps = (await trace(page)).events
    .filter((event) =>
      event.seq > beforeFocus
      && event.direction === 'to-worker'
      && event.t === 'query')
    .map((event) => event.op);
  expect(focusOps).toEqual([]);

  const beforeScope = (await trace(page)).events.at(-1)?.seq ?? -1;
  await textDetail.getByRole('button', { name: 'select this text' }).click();
  await expect(scope.getByRole('button', {
    name: /review linked range in Trends/,
  })).toBeVisible();
  await expect(scope).toContainText(title);
  await expect(scope).toContainText(/tokens 1–/);
  await expect(scope.getByRole('button', { name: 'All books' })).toBeVisible();
  await expect(rows).toHaveCount(6);
  await expect(secondRow.getByRole('rowheader').getByRole('button')).toHaveText(declaredTitle);
  expect(await secondRow.locator('.catalog-term-total').allInnerTexts()).toEqual(termCountsBefore);

  const requiredScopeOps = ['trend', 'dispersion', 'inventory', 'freq-list'];
  await expect.poll(async () => {
    const operations = new Set(
      (await trace(page)).events
        .filter((event) =>
          event.seq > beforeScope
          && event.direction === 'to-worker'
          && event.t === 'query')
        .map((event) => event.op),
    );
    return requiredScopeOps
      .every((operation) => operations.has(operation));
  }, { timeout: 30_000 }).toBe(true);
  const scopeOps = (await trace(page)).events
    .filter((event) =>
      event.seq > beforeScope
      && event.direction === 'to-worker'
      && event.t === 'query')
    .map((event) => event.op);
  expect(new Set(scopeOps)).toEqual(new Set(requiredScopeOps));

  await gotoPlace(page, 'matches');
  await expect(page.getByRole('grid', { name: 'Matches' })).toBeVisible();

  // The range-scoped inventory row retains its selection-independent
  // fullTokens. Even with no trend series left as a fallback, the named
  // one-step escape must remain enabled and correctly labelled.
  await gotoPlace(page, 'trends');
  await clearNotebook(page);
  await expect(scope.getByRole('button', { name: 'All books' })).toBeVisible();
  await gotoPlace(page, 'inputs');
  await titleButton.click();
  await expect(textDetail).toBeVisible();
  const detailEscape = textDetail.getByRole('button', { name: 'all texts' });
  await expect(detailEscape).toBeVisible();
  await expect(detailEscape).not.toHaveAttribute('aria-disabled');
  await expect(secondRow.getByRole('rowheader')).toHaveAccessibleName(title);

  await scope.getByRole('button', { name: 'All books' }).click();
  await expect(scope.getByText('all 6 books', { exact: true })).toHaveCount(0);
  await expect(rows).toHaveCount(6);
});
