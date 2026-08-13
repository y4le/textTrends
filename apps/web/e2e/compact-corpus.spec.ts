import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  gotoPlace,
  trace,
} from './helpers.ts';

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
  test(`compact Catalog keeps one truthful book analysis at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await awaitAllReady(page);
    await gotoPlace(page, 'inputs');

    const table = page.getByRole('table', { name: 'Book analysis' });
    const documentRows = table.locator(':scope > tbody > tr[data-catalog-book]');
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveCount(5);
    await expect(documentRows).toHaveCount(6);
    await expect(table.getByRole('rowheader')).toHaveCount(7);
    await expect(table.getByRole('columnheader', { name: 'book' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'tokens' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: /Holmes/ })).toBeVisible();
    await expect(table.locator('[aria-current="true"]')).toHaveCount(1);
    await expect(documentRows.first().locator('.catalog-book-tokens')).toContainText('tokens');
    await expect(documentRows.first().locator('.catalog-term-total')).toContainText('Holmes');

    const totalsMark = (await trace(page)).events.at(-1)?.seq ?? -1;
    await page.getByRole('button', { name: 'show all query totals' }).click();
    await expect(table.getByRole('columnheader')).toHaveCount(7);
    await expect(table.getByRole('columnheader', { name: /Watson/ })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: /Moriarty/ })).toBeVisible();
    expect((await trace(page)).events.filter((event) =>
      event.seq > totalsMark
      && event.direction === 'to-worker'
      && event.t === 'query')).toEqual([]);

    const title = documentRows.first().getByRole('button').first();
    await expect(title).toHaveAttribute('aria-expanded', 'false');
    await expect(title).not.toHaveAttribute('aria-controls');
    const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
    await title.click();
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    await expect(title).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('region', { name: /Book detail:/ })).toBeVisible();
    await expect(documentRows).toHaveCount(6);
    const focusOperations = (await trace(page)).events
      .filter((event) =>
        event.seq > mark
        && event.direction === 'to-worker'
        && event.t === 'query')
      .map((event) => event.op);
    expect(focusOperations).toEqual([]);
    await expectNoBodyOverflow(page);

    await page.goBack();
    await expect(title).toHaveAttribute('aria-expanded', 'false');
    await expectNoBodyOverflow(page);
  });
}

test('wide Catalog keeps useful comparison columns and additive detail', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'inputs');

  const table = page.getByRole('table', { name: 'Book analysis' });
  const documentRows = table.locator(':scope > tbody > tr[data-catalog-book]');
  await expect(table.getByRole('columnheader')).toHaveCount(7);
  await expect(documentRows).toHaveCount(6);
  await expect(table.getByRole('columnheader', { name: /Holmes/ })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: /Watson/ })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: /Moriarty/ })).toBeVisible();

  await documentRows.first().getByRole('button').first().click();
  await expect(page.getByRole('region', { name: 'Measurements' })).toBeVisible();
  await expect(documentRows).toHaveCount(6);
  await expectNoBodyOverflow(page);
});
