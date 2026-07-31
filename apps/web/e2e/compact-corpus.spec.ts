import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';

async function expectNoBodyOverflow(page: import('@playwright/test').Page) {
  const geometry = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(geometry.document).toBeLessThanOrEqual(geometry.client);
  expect(geometry.body).toBeLessThanOrEqual(geometry.client);
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
]) {
  test(`compact Corpus keeps one truthful inventory at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await awaitAllReady(page);
    await gotoPlace(page, 'corpus');

    const table = page.getByRole('table', { name: 'Corpus documents' });
    const documentRows = table.locator(':scope > tbody > tr[data-corpus-document]');
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveCount(12);
    await expect(documentRows).toHaveCount(6);
    await expect(table.getByRole('rowheader')).toHaveCount(6);
    await expect(documentRows.first().getByRole('rowheader')).toHaveAttribute('aria-colindex', '1');
    await expect(documentRows.first().locator('.corpus-readiness')).toHaveAttribute('aria-colindex', '2');
    await expect(documentRows.first().locator('.corpus-tokens')).toHaveAttribute('aria-colindex', '3');
    await expect(documentRows.first().locator('.corpus-rhythm')).toHaveAttribute('aria-colindex', '11');
    await expect(documentRows.first().locator('.corpus-scope')).toHaveAttribute('aria-colindex', '12');
    await expect(table.locator('[aria-current="true"]')).toHaveCount(1);
    await expect(documentRows.first().locator('.corpus-readiness')).toHaveText('ready');
    await expect(documentRows.first().locator('.corpus-tokens')).toContainText('tokens');
    await expect(documentRows.first().locator('[data-detail-only]').first()).toBeHidden();

    const title = documentRows.first().getByRole('button').first();
    await expect(title).toHaveAttribute('aria-expanded', 'false');
    await expect(title).not.toHaveAttribute('aria-controls');
    const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
    await title.click();
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    await expect(title).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('region', { name: /Book detail:/ })).toBeVisible();
    await expect(documentRows).toHaveCount(6);
    const focusOperations = new Set((await trace(page)).events
      .filter((event) =>
        event.seq > mark
        && event.direction === 'to-worker'
        && event.t === 'query')
      .map((event) => event.op));
    expect(
      focusOperations.size === 0
      || (
        focusOperations.size === 2
        && focusOperations.has('structure')
        && focusOperations.has('tfidf-sections')
      ),
    ).toBe(true);
    await expectNoBodyOverflow(page);

    await page.goBack();
    await expect(title).toHaveAttribute('aria-expanded', 'false');
    await expectNoBodyOverflow(page);
  });
}

test('wide Corpus preserves all twelve inventory columns and additive detail', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');

  const table = page.getByRole('table', { name: 'Corpus documents' });
  const documentRows = table.locator(':scope > tbody > tr[data-corpus-document]');
  await expect(table.getByRole('columnheader')).toHaveCount(12);
  await expect(documentRows).toHaveCount(6);
  await expect(documentRows.first().locator('[data-detail-only]').first()).toBeVisible();
  await expect(documentRows.first().locator('.corpus-readiness')).toHaveText('ready');

  await documentRows.first().getByRole('button').first().click();
  await expect(page.getByRole('region', { name: 'Inventory' })).toBeVisible();
  await expect(documentRows).toHaveCount(6);
  await expectNoBodyOverflow(page);
});
