import { expect, test } from '@playwright/test';
import { awaitAllReady, trace } from './helpers.ts';

test('book focus preserves scope while only this book explicitly rescopes linked analyses', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);

  const scope = page.getByRole('region', { name: 'Scope' });
  const documents = page.getByRole('table', { name: 'Corpus documents' });
  const rows = documents.locator('tbody tr');
  await expect(rows).toHaveCount(6);
  const baselineTokens = await scope.locator('span').filter({ hasText: /^[\d,]+ tokens$/ }).first().innerText();

  let targetIndex = -1;
  for (let index = 0; index < await rows.count(); index += 1) {
    const candidate = rows.nth(index).getByRole('rowheader').getByRole('button');
    if (await candidate.getAttribute('aria-pressed') === 'false') {
      targetIndex = index;
      break;
    }
  }
  expect(targetIndex).toBeGreaterThanOrEqual(0);
  const secondRow = rows.nth(targetIndex);
  const titleButton = secondRow.getByRole('rowheader').getByRole('button');
  await expect(titleButton).toHaveAttribute('aria-pressed', 'false');
  const title = await titleButton.innerText();
  const beforeFocus = (await trace(page)).events.at(-1)?.seq ?? -1;
  await titleButton.click();
  await expect(titleButton).toHaveAttribute('aria-pressed', 'true');
  await expect(scope).toContainText(baselineTokens);
  await expect.poll(async () => new Set(
    (await trace(page)).events
      .filter((event) =>
        event.seq > beforeFocus
        && event.direction === 'to-worker'
        && event.t === 'query')
      .map((event) => event.op),
  ), { timeout: 30_000 }).toEqual(new Set(['structure', 'tfidf-sections']));
  const focusOps = (await trace(page)).events
    .filter((event) =>
      event.seq > beforeFocus
      && event.direction === 'to-worker'
      && event.t === 'query')
    .map((event) => event.op);
  expect(new Set(focusOps)).toEqual(new Set(['structure', 'tfidf-sections']));

  const beforeScope = (await trace(page)).events.at(-1)?.seq ?? -1;
  await secondRow.getByRole('button', { name: 'only this book' }).click();
  await expect(scope.getByText('1 book in scope', { exact: true })).toBeVisible();
  await expect(scope).toContainText(title);
  await expect(scope).toContainText(/tokens 1–/);
  await expect(scope.getByRole('button', { name: 'All books' })).toBeVisible();
  await expect(documents.locator('tbody tr')).toHaveCount(1);

  const requiredScopeOps = ['trend', 'dispersion', 'kwic', 'inventory', 'freq-list'];
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

  await expect(page.getByRole('table', { name: 'Vocabulary frequency list' })).toBeVisible();
  await expect(page.getByText(/rates use .* selected class tokens/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Concordance' })).toBeVisible();

  // The range-scoped inventory row retains its selection-independent
  // fullTokens. Even with no trend series left as a fallback, the named
  // one-step escape must remain enabled and correctly labelled.
  await page.getByRole('button', { name: 'Remove Holmes' }).click();
  await page.getByRole('button', { name: 'Remove Moriarty' }).click();
  await expect(scope.getByRole('button', { name: 'All books' })).toBeVisible();
  const rowEscape = documents.getByRole('button', { name: 'all books' });
  await expect(rowEscape).toBeVisible();
  await expect(rowEscape).not.toHaveAttribute('aria-disabled');
  await expect(documents.getByRole('rowheader').first()).toHaveAccessibleName(title);

  await scope.getByRole('button', { name: 'All books' }).click();
  await expect(scope.getByText('all 6 books', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(6);
});
