import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  clearNotebook,
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
  { width: 600, height: 800 },
  { width: 700, height: 900 },
  { width: 799, height: 900 },
]) {
  test(`compact Inputs keeps complete text details at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await awaitAllReady(page, { loadDemo: true });
    await gotoPlace(page, 'inputs');

    const table = page.getByRole('table', { name: 'Text details' });
    const documentRows = table.locator(':scope > tbody > tr[data-catalog-book]');
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveCount(5);
    await expect(documentRows).toHaveCount(6);
    await expect(table.getByRole('rowheader')).toHaveCount(7);
    await expect(table.getByRole('columnheader', { name: 'text' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'tokens' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: /Holmes/ })).toBeVisible();
    await expect(documentRows.first().locator('.catalog-book-tokens')).toContainText('tokens');
    await expect(documentRows.first().locator('.catalog-term-total').first()).toContainText('Holmes');

    await expect(table.getByRole('columnheader', { name: /Watson/ })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: /Moriarty/ })).toBeVisible();

    const firstRow = documentRows.first();
    const absoluteValues = firstRow.locator(
      '.catalog-book-tokens > .selectable-stat, .catalog-term-count',
    );
    const rateValues = firstRow.locator('.catalog-term-rate');
    const absoluteEdges = await absoluteValues.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().right));
    const rateEdges = await rateValues.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().right));
    expect(Math.max(...absoluteEdges) - Math.min(...absoluteEdges)).toBeLessThan(0.5);
    expect(Math.max(...rateEdges) - Math.min(...rateEdges)).toBeLessThan(0.5);
    const firstRowBox = await firstRow.boundingBox();
    expect(firstRowBox).not.toBeNull();
    expect(Math.max(...absoluteEdges)).toBeLessThan(
      firstRowBox!.x + firstRowBox!.width * 0.75,
    );

    const title = firstRow.getByRole('button').first();
    await expect(title).toHaveAttribute('aria-expanded', 'false');
    await expect(title).not.toHaveAttribute('aria-controls');
    const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
    await title.click();
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    const textDetail = page.getByRole('region', { name: /Text detail:/ });
    await expect(textDetail).toBeVisible();
    expect(await textDetail.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.marginTop, style.paddingTop, style.borderTopWidth];
    })).toEqual(['0px', '0px', '0px']);
    await expect(page.getByRole('region', { name: 'Term counts' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Source details' })).toBeVisible();
    await expect(documentRows).toHaveCount(6);
    const sentenceInfo = page.getByRole('button', { name: 'About sentence mean / median / p90' });
    const sentenceTooltip = page.locator(`[id="${await sentenceInfo.getAttribute('aria-controls')}"]`);
    expect(await page.locator('.book-detail-stats').evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2);
    expect(await textDetail.locator('.book-detail-footer').evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
    await sentenceInfo.click();
    await expect(sentenceTooltip).toBeVisible();
    await expectNoBodyOverflow(page);
    await page.keyboard.press('Escape');
    await expect(sentenceTooltip).toBeHidden();
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

test('compact corpus total remains visible without active terms', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearNotebook(page);

  const table = page.getByRole('table', { name: 'Text details' });
  await expect(table.getByRole('columnheader')).toHaveCount(2);
  const corpus = table.locator('.catalog-corpus-row');
  await expect(corpus).toContainText('tokens');
  await expect(corpus.locator('.selectable-stat')).toBeVisible();
});

test('wide Catalog keeps useful comparison columns and additive detail', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');

  const table = page.getByRole('table', { name: 'Text details' });
  const documentRows = table.locator(':scope > tbody > tr[data-catalog-book]');
  await expect(table.getByRole('columnheader')).toHaveCount(5);
  await expect(documentRows).toHaveCount(6);
  await expect(table.getByRole('columnheader', { name: /Holmes/ })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: /Watson/ })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: /Moriarty/ })).toBeVisible();

  const firstTermCounts = table.locator(
    'tbody > tr[data-catalog-book] > td.catalog-term-total:nth-of-type(2) .catalog-term-count',
  );
  const firstTermRates = table.locator(
    'tbody > tr[data-catalog-book] > td.catalog-term-total:nth-of-type(2) .catalog-term-rate',
  );
  await expect(firstTermCounts).toHaveCount(6);
  const countEdges = await firstTermCounts.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().right));
  const rateEdges = await firstTermRates.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().right));
  expect(Math.max(...countEdges) - Math.min(...countEdges)).toBeLessThan(0.5);
  expect(Math.max(...rateEdges) - Math.min(...rateEdges)).toBeLessThan(0.5);

  await documentRows.first().getByRole('button').first().click();
  await expect(page.getByRole('region', { name: 'Measurements' })).toBeVisible();
  const measurements = page.getByRole('region', { name: 'Measurements' });
  await expect(measurements.getByText('lexical / numeral tokens', { exact: true })).toBeVisible();
  await expect(measurements.getByText('sentence mean / median / p90', { exact: true })).toBeVisible();
  await expect(measurements.getByText('MATTR', { exact: true })).toBeVisible();
  await expect(measurements.getByRole('button', { name: /^About / })).toHaveCount(10);
  expect(await measurements.locator('.book-detail-stats').evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(5);
  const labelLineCounts = await measurements
    .locator('.book-detail-measurement-label > span:first-child')
    .evaluateAll((labels) => labels.map((label) => {
      const range = document.createRange();
      range.selectNodeContents(label);
      return range.getClientRects().length;
    }));
  expect(Math.max(...labelLineCounts)).toBe(1);
  const detailFooter = page.locator('.book-detail-footer');
  expect(await detailFooter.evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2);
  const sourceBox = await detailFooter.getByRole('region', { name: 'Source details' }).boundingBox();
  const actionsBox = await detailFooter.locator('.book-detail-actions').boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(Math.abs(
    (sourceBox!.y + sourceBox!.height) - (actionsBox!.y + actionsBox!.height),
  )).toBeLessThan(1);

  const typesInfo = measurements.getByRole('button', { name: 'About types' });
  const typesTooltip = page.locator(`[id="${await typesInfo.getAttribute('aria-controls')}"]`);
  await typesInfo.hover();
  await expect(typesTooltip).toBeVisible();
  await expect(typesTooltip).toContainText('distinct indexed token forms');
  await page.mouse.move(0, 0);
  await expect(typesTooltip).toBeHidden();

  const mattrInfo = measurements.getByRole('button', { name: 'About MATTR' });
  const mattrTooltip = page.locator(`[id="${await mattrInfo.getAttribute('aria-controls')}"]`);
  await mattrInfo.click();
  await page.mouse.move(0, 0);
  await expect(mattrTooltip).toBeVisible();
  await expect(mattrTooltip).toContainText('500 tokens');
  await page.mouse.click(0, 0);
  await expect(mattrTooltip).toBeHidden();
  await expect(page.getByRole('region', { name: 'Term counts' })).toHaveCount(0);
  await expect(documentRows).toHaveCount(6);
  await expectNoBodyOverflow(page);
});
