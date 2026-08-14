import { expect, test } from '@playwright/test';
import { awaitAllReady, clearNotebook, gotoPlace, trace } from './helpers.ts';

test('text focus preserves scope while only this text explicitly rescopes linked analyses', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');

  const scope = page.getByRole('region', { name: 'Corpus status' });
  const documents = page.getByRole('table', { name: 'Text details' });
  const rows = documents.locator(':scope > tbody > tr[data-catalog-book]');
  await expect(rows).toHaveCount(6);
  const baselineTokens = await scope.locator('span').filter({ hasText: /^[\d,]+ tokens$/ }).first().innerText();

  const targetIndex = await rows.evaluateAll((elements) =>
    elements.findIndex((element) => !element.hasAttribute('data-focused')));
  expect(targetIndex).toBeGreaterThanOrEqual(0);
  const secondRow = rows.nth(targetIndex);
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
  await expect(page.locator(`[id="${controlledDetail!}"]`)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Measurements' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Vocabulary growth' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Sentence rhythm' })).toHaveCount(0);
  const termCountsBefore = await secondRow.locator('.catalog-term-total').allInnerTexts();
  await expect(scope).toContainText(baselineTokens);
  const focusOps = (await trace(page)).events
    .filter((event) =>
      event.seq > beforeFocus
      && event.direction === 'to-worker'
      && event.t === 'query')
    .map((event) => event.op);
  expect(focusOps).toEqual([]);

  const beforeScope = (await trace(page)).events.at(-1)?.seq ?? -1;
  await secondRow.getByRole('button', { name: 'only this text' }).click();
  await expect(scope.getByText('1 book in scope', { exact: true })).toBeVisible();
  await expect(scope).toContainText(title);
  await expect(scope).toContainText(/tokens 1–/);
  await expect(scope.getByRole('button', { name: 'All books' })).toBeVisible();
  await expect(rows).toHaveCount(6);
  await expect(secondRow.getByRole('rowheader').getByRole('button')).toHaveText(declaredTitle);
  await expect(page.getByRole('region', { name: 'Measurements' })).toContainText('full text');
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

  await expect(page.getByRole('region', { name: 'Vocabulary growth' }))
    .toContainText('not attributed to an individual text');
  const vocabularyDestination = page.getByRole('button', { name: 'Open Vocabulary', exact: true });
  await expect(vocabularyDestination).toBeVisible();
  await vocabularyDestination.click();
  await expect(page.getByRole('table', { name: 'Vocabulary frequency list' })).toBeVisible();
  await expect(page.getByText(/rates use .* selected class tokens/)).toBeVisible();
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('grid', { name: 'Concordance' })).toBeVisible();

  // The range-scoped inventory row retains its selection-independent
  // fullTokens. Even with no trend series left as a fallback, the named
  // one-step escape must remain enabled and correctly labelled.
  await gotoPlace(page, 'trends');
  await clearNotebook(page);
  await expect(scope.getByRole('button', { name: 'All books' })).toBeVisible();
  await gotoPlace(page, 'inputs');
  const rowEscape = documents.getByRole('button', { name: 'all texts' });
  await expect(rowEscape).toBeVisible();
  await expect(rowEscape).not.toHaveAttribute('aria-disabled');
  await expect(secondRow.getByRole('rowheader')).toHaveAccessibleName(title);

  await scope.getByRole('button', { name: 'All books' }).click();
  await expect(scope.getByText('all 6 books', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(6);
});
