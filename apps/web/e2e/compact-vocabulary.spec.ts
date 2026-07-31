import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
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
  test(`compact Vocabulary keeps one truthful ranking table at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await awaitAllReady(page);
    await gotoPlace(page, 'vocabulary');

    const table = page.getByRole('table', { name: 'Vocabulary frequency list' });
    await expect(table).toBeVisible();
    await expect(table).toHaveAttribute('aria-colcount', '7');
    await expect(table.getByRole('columnheader')).toHaveCount(7);
    await expect(table.locator('thead button')).toHaveCount(0);
    const row = table.locator('tr[data-frequency-row]').first();
    await expect(row.getByRole('rowheader')).toHaveAttribute('aria-colindex', '1');
    await expect(row.locator('td[data-current-measure]')).toHaveAttribute('aria-colindex', '2');
    await expect(row.locator('td[data-current-measure]')).toHaveAttribute(
      'data-measure-label',
      'count',
    );
    await expect(row.locator('td.frequency-measure:not([data-current-measure])').first())
      .toBeHidden();

    const term = row.getByRole('button');
    const filter = page.getByRole('button', { name: 'sort and filter' });
    const filterBox = await filter.boundingBox();
    expect(filterBox?.height).toBeGreaterThanOrEqual(44);
    await filter.focus();
    await filter.press('Tab');
    await expect(term).toBeFocused();
    await term.click();
    const detail = page.getByRole('region', { name: /Vocabulary detail:/ });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('Per-book distribution is not available');
    await expect(detail.locator('dt')).toHaveCount(7);
    await expectNoBodyOverflow(page);

    await page.goBack();
    await expect(detail).toHaveCount(0);
    await expect(term).toBeFocused();
  });
}

test('Vocabulary filter preserves drafts across width classes and applies once', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'vocabulary');

  const open = page.getByRole('button', { name: 'sort and filter' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Vocabulary sort and filter' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  const prefix = page.getByLabel('starts with');
  await expect(prefix).toBeFocused();
  await prefix.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'apply' })).toBeFocused();
  await dialog.getByRole('button', { name: 'apply' }).press('Tab');
  await expect(prefix).toBeFocused();
  for (const action of [
    dialog.getByRole('button', { name: 'cancel' }),
    dialog.getByRole('button', { name: 'apply' }),
  ]) {
    const box = await action.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await prefix.fill('Hol');
  expect(await prefix.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)))
    .toBeGreaterThanOrEqual(16);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await expect(page.getByRole('form', { name: 'Vocabulary sort and filter' })).toBeVisible();
  await expect(page.getByLabel('starts with')).toHaveValue('Hol');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('starts with')).toHaveValue('Hol');
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);

  await page.getByLabel('count ≥').fill('0');
  const invalidMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await dialog.getByRole('button', { name: 'apply' }).click();
  await expect(dialog.getByRole('status')).toContainText('Minimum count');
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > invalidMark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);

  await page.getByLabel('count ≥').fill('2');
  await page.getByLabel('Sort field').selectOption('docFreq');
  const applyMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await dialog.getByRole('button', { name: 'apply' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(page.locator('.frequency-view-bar')).toContainText('docs descending');
  await expect(page.locator('tr[data-frequency-row]').first().locator('td[data-current-measure]'))
    .toHaveAttribute('data-measure-label', 'docs');
  const applyQueries = (await trace(page)).events.filter(
    (event) =>
      event.seq > applyMark
      && event.direction === 'to-worker'
      && event.t === 'query'
      && event.op === 'freq-list',
  );
  expect(applyQueries).toHaveLength(1);

  await open.click();
  await page.getByLabel('starts with').fill('Escaped draft');
  const closeMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await open.click();
  await expect(page.getByLabel('starts with')).toHaveValue('Escaped draft');
  await dialog.getByRole('button', { name: 'cancel' }).click();
  await expect(open).toBeFocused();
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > closeMark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);
  await expectNoBodyOverflow(page);
});

test('wide Vocabulary keeps seven columns and a target-gated in-flow filter', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'vocabulary');

  const table = page.getByRole('table', { name: 'Vocabulary frequency list' });
  await expect(table.getByRole('columnheader')).toHaveCount(7);
  await expect(table.locator('thead button')).toHaveCount(5);
  await expect(table.locator('tr[data-frequency-row]').first().locator('td.frequency-class'))
    .toBeVisible();
  const open = page.getByRole('button', { name: 'sort and filter' });
  await open.click();
  await expect(page.getByRole('form', { name: 'Vocabulary sort and filter' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Vocabulary sort and filter' })).toHaveCount(0);
  await page.getByRole('button', { name: 'cancel' }).click();
  await expect(open).toBeFocused();
});

test('successful exact Concordance routing restores the open Vocabulary detail on Back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'vocabulary');

  const row = page.locator('tr[data-frequency-row]').first();
  await row.getByRole('button').click();
  const detail = page.getByRole('region', { name: /Vocabulary detail:/ });
  await detail.getByRole('button', { name: 'concordance' }).click();
  await expect(page).toHaveURL(/[?&]p=concordance(?:&|$)/);

  await page.goBack();
  await expect(page).toHaveURL(/[?&]p=vocabulary(?:&|$)/);
  await expect(detail).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vocabulary', exact: true })).toBeFocused();
});

test('Vocabulary detail remains mounted beneath governed Evidence and restores sheet-invoker focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'vocabulary');

  const row = page.locator('tr[data-frequency-row]').first();
  await row.getByRole('button').click();
  const detail = page.getByRole('region', { name: /Vocabulary detail:/ });
  await expect(detail).toBeVisible();

  const more = page.getByRole('button', { name: 'More evidence' });
  await more.click();
  const sheet = page.getByRole('dialog', { name: 'Evidence sheet' });
  await expect(sheet).toHaveAttribute('data-detent', 'peek');
  await expect(sheet).toHaveAttribute('aria-modal', 'false');
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await expect(detail).toBeVisible();

  await row.getByRole('button').click();
  await expect(sheet).toBeVisible();
  await expect(detail).toBeVisible();
  await expect(row.getByRole('button')).toHaveAttribute('aria-expanded', 'true');

  await sheet.getByRole('button', { name: 'half', exact: true }).click();
  await expect(sheet).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  await expect(detail).toHaveCount(1);

  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await expect(detail).toBeVisible();
  await expect(more).toBeFocused();
  await expect(row.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
});

test('a ready page that omits an open row stale-pops once to a surviving focus target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'vocabulary');

  await page.getByRole('button', { name: 'sort and filter' }).click();
  await page.getByLabel('rows/page').selectOption('50');
  await page.getByRole('dialog', { name: 'Vocabulary sort and filter' })
    .getByRole('button', { name: 'apply' })
    .click();
  const row = page.locator('tr[data-frequency-row]').first();
  await row.getByRole('button').click();
  const detail = page.getByRole('region', { name: /Vocabulary detail:/ });
  await expect(detail).toBeVisible();

  await page.getByRole('button', { name: 'next', exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]p=vocabulary(?:&|$)/);
  await expect(page.getByRole('heading', { name: 'Vocabulary', exact: true })).toBeFocused();

  await page.goBack();
  await expect(page).toHaveURL(/[?&]p=trends(?:&|$)/);
});

test('a many-section Vocabulary profile stays inside a compact page', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');
  const markdown = Array.from(
    { length: 90 },
    (_, index) => `# Chapter ${index + 1}\n\nword${index} repeats repeats.\n`,
  ).join('\n');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'many sections.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(markdown, 'utf8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'vocabulary');

  await page.getByRole('button', { name: 'sort and filter' }).click();
  await page.getByLabel('Sort field').selectOption('dpNorm');
  await page.getByRole('dialog', { name: 'Vocabulary sort and filter' })
    .getByRole('button', { name: 'apply' })
    .click();
  const compactMeasure = page.locator('tr[data-frequency-row]').first()
    .locator('td[data-current-measure]');
  await expect(compactMeasure).toHaveAttribute('data-measure-label', 'DPnorm');
  await expect(compactMeasure).toHaveText('unavailable');
  await expect(page.getByRole('img', { name: /section vocabulary strip/ })).toBeVisible();
  await page.getByText('exact section values').click();
  await expect(page.getByRole('region', { name: 'Exact focused-book section values' }))
    .toBeVisible();
  await expectNoBodyOverflow(page);
});
