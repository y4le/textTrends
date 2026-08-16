import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  clearDemoInputs,
  gotoPlace,
  submitAndAwaitFreshResults,
} from './helpers.ts';

test('a single-text trend omits the redundant y-extent label above the graph', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'one.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('wolf alpha beta wolf gamma', 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await submitAndAwaitFreshResults(page, 'wolf');
  await gotoPlace(page, 'trends');

  const seriesChart = page.locator('svg[data-trend-view="series"]');
  await expect(seriesChart).toBeVisible();
  await expect(seriesChart.locator('[data-trend-y-extent]')).toHaveCount(0);
  await expect(seriesChart.locator('text').filter({ hasText: '/10,000' })).toHaveCount(0);
});

test('an all-zero rate series labels its data maximum rather than its geometry floor', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await submitAndAwaitFreshResults(page, 'absentterm');
  await gotoPlace(page, 'trends');
  await page.getByRole('button', { name: 'combined', exact: true }).click();

  const seriesChart = page.locator('svg[data-trend-view="series"]');
  await expect(seriesChart).toBeVisible();
  await expect(seriesChart.locator('[data-trend-y-extent]')).toHaveCount(1);
  await expect(seriesChart.locator('text').filter({ hasText: '0/10,000' })).toHaveCount(1);
  await expect(seriesChart).not.toContainText('0.000000001/10,000');
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
]) {
  test(`compact Trends preserves exact values at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await awaitAllReady(page, { loadDemo: true });
    await gotoPlace(page, 'trends');
    await page.getByRole('button', { name: 'combined', exact: true }).click();

    const footer = page.getByRole('complementary', { name: 'Reading position' });
    const dock = page.locator('.workbench-dock');
    const lens = page.getByRole('navigation', { name: 'Workbench sections' });
    await expect(footer).toBeVisible();
    expect(await footer.locator('.footer-sparkline path').count()).toBeGreaterThanOrEqual(2);
    const footerBox = await footer.boundingBox();
    const dockBox = await dock.boundingBox();
    const lensBox = await lens.boundingBox();
    const reservedFooterHeight = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--footer-block-size')));
    expect(footerBox?.height).toBe(reservedFooterHeight);
    expect(footerBox && lensBox ? footerBox.y + footerBox.height : Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual((lensBox?.y ?? 0) + 1);
    expect(dockBox && lensBox ? dockBox.y + dockBox.height : Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual((lensBox?.y ?? 0) + 1);
    if (testInfo.project.name === 'webkit-compact') {
      expect((await footer.locator('.footer-passage').boundingBox())?.height).toBe(36);
      expect((await footer.locator('.footer-sparkline').boundingBox())?.height).toBe(38);
      expect((await footer.locator('canvas[data-barcode-band="series"]').boundingBox())?.height)
        .toBe(27);
      expect((await footer.getByRole('slider', { name: 'Corpus footer position' }).boundingBox())?.height)
        .toBe(70);
    }

    const scrubber = page.getByRole('slider', { name: /reading position/i });
    const seriesChart = page.locator('svg[data-trend-view="series"]');
    await expect(seriesChart).toBeVisible();
    // 132px plot + 3px band gap + three 7px compact barcode rows + 8px tail.
    expect((await seriesChart.boundingBox())?.height).toBe(164);
    const barcodeBand = scrubber.locator('canvas[data-barcode-band="series"]');
    await expect(barcodeBand).toHaveCount(1);
    expect((await barcodeBand.boundingBox())?.height).toBe(21);
    expect(await scrubber.evaluate((node) => getComputedStyle(node).touchAction)).toBe('pan-y');

    await expect.poll(async () => {
      const chart = await seriesChart.boundingBox();
      const owner = await scrubber.boundingBox();
      return chart && owner ? Math.abs(chart.width - owner.width) : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(1);
    await expect(seriesChart.locator('text')).not.toContainText('Holmes');
    await expect(seriesChart.locator('text')).not.toContainText('Moriarty');

    const strokes = await seriesChart.locator('[data-series-path]').evaluateAll((paths) =>
      [...new Set(paths.map((path) => Number(path.getAttribute('stroke-width'))))].sort(),
    );
    expect(strokes).toEqual([2]);

    await expect(page.getByRole('table', { name: /exact totals by book/i })).toHaveCount(0);
    await expect(page.getByText(/Exact totals by book are in/)).toHaveCount(0);
    const occurrenceRows = page.getByRole('list', { name: 'Term totals' })
      .getByRole('listitem');
    await expect(occurrenceRows).toHaveCount(3);

    await page.getByRole('button', { name: 'separate', exact: true }).click();
    const byBook = page.locator('svg[data-trend-view="by-book"]');
    await expect(byBook).toBeVisible();
    const firstRow = await byBook.locator('[data-trend-hit-row="0"]').first().boundingBox();
    expect(firstRow?.height).toBe(28);

    const overflow = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      root: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(overflow.root).toBeLessThanOrEqual(overflow.client);
    expect(overflow.body).toBeLessThanOrEqual(overflow.client);
  });
}
