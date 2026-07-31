import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  gotoPlace,
  trace,
} from './helpers.ts';

const STRUCTURED_BOOK = [
  '# Alpha',
  '',
  'The wolf ran far over the hill.',
  '',
  '# Beta',
  '',
  'A wolf slept by the door.',
  '',
].join('\n');

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

test('compact chapter editing preserves its draft and nested Back contract across resize', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'mobile chapters.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(STRUCTURED_BOOK, 'utf8'),
  });
  await awaitReadyCount(page, 1);

  const table = page.getByRole('table', { name: 'Corpus documents' });
  const row = table.locator(':scope > tbody > tr[data-corpus-document]').first();
  const title = row.getByRole('button').first();
  await title.click();
  const book = page.getByRole('region', { name: /Book detail:/ });
  await expect(book).toBeVisible();

  const edit = book.getByRole('button', { name: 'edit chapters' });
  await expect(edit).toHaveAttribute('id', /^structure-edit-\S+$/);
  await edit.click();
  const dialog = page.getByRole('dialog', { name: /Chapter editor:/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);

  const firstTitle = page.locator('input[aria-label^="Title for"]').first();
  await expect(firstTitle).toHaveValue('Alpha', { timeout: 30_000 });
  await firstTitle.fill('A retained mobile draft');
  expect(await firstTitle.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)))
    .toBeGreaterThanOrEqual(16);
  for (const action of [
    dialog.getByRole('button', { name: 'cancel', exact: true }),
    dialog.getByRole('button', { name: 'apply', exact: true }),
  ]) {
    const box = await action.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await expectNoBodyOverflow(page);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await expect(page.getByLabel('Editable chapters')).toBeVisible();
  await expect(page.locator('input[aria-label^="Title for"]').first())
    .toHaveValue('A retained mobile draft');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await expect(page.locator('input[aria-label^="Title for"]').first())
    .toHaveValue('A retained mobile draft');
  await expectNoBodyOverflow(page);

  const resizeQueries = (await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  );
  expect(resizeQueries).toEqual([]);

  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await expect(book).toBeVisible();
  await expect(edit).toBeFocused();

  await page.goBack();
  await expect(book).toHaveCount(0);
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  await expectNoBodyOverflow(page);
});

test('wide book title closes its nested editor and detail without a dead history layer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'wide chapters.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(STRUCTURED_BOOK, 'utf8'),
  });
  await awaitReadyCount(page, 1);

  const row = page.getByRole('table', { name: 'Corpus documents' })
    .locator(':scope > tbody > tr[data-corpus-document]')
    .first();
  const title = row.getByRole('button').first();
  await title.click();
  const book = page.getByRole('region', { name: /Book detail:/ });
  await expect(book).toBeVisible();
  await book.getByRole('button', { name: 'edit chapters' }).click();
  await expect(page.getByLabel('Editable chapters')).toBeVisible({ timeout: 30_000 });

  await title.click();
  await expect(book).toHaveCount(0);
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  await expect(title).toBeFocused();

  await page.goBack();
  await expect(page).toHaveURL(/[?&]p=trends(?:&|$)/);
  await expectNoBodyOverflow(page);
});
