import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
]) {
  test(`compact Trends preserves exact values at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await awaitAllReady(page);
    await gotoPlace(page, 'trends');

    const scrubber = page.getByRole('slider', { name: /reading position/i });
    const seriesChart = page.locator('svg[data-trend-view="series"]');
    await expect(seriesChart).toBeVisible();
    // 132px plot + 3px band gap + two 7px compact barcode rows + 8px tail.
    expect((await seriesChart.boundingBox())?.height).toBe(157);
    const barcodeBand = page.locator('canvas[data-barcode-band="series"]');
    await expect(barcodeBand).toHaveCount(1);
    expect((await barcodeBand.boundingBox())?.height).toBe(14);
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

    const totals = page.getByRole('table', { name: /exact totals by book/i });
    await expect(totals).toBeVisible();
    await expect(totals.locator('caption')).toContainText('Holmes');
    await expect(totals.locator('thead')).not.toContainText('Moriarty');

    const beforeFocus = (await trace(page)).events.at(-1)?.seq ?? -1;
    await page
      .getByRole('group', { name: 'Query terms' })
      .getByRole('button', { name: /^Moriarty \d+$/ })
      .click();
    const focusedStrokes = await seriesChart.locator('[data-series-path]').evaluateAll((paths) =>
      [...new Set(paths.map((path) => Number(path.getAttribute('stroke-width'))))].sort(),
    );
    expect(focusedStrokes).toEqual([2, 3.5]);
    await expect(totals.locator('caption')).toContainText('Moriarty');
    await expect(totals.locator('thead')).not.toContainText('Holmes');
    expect((await trace(page)).events.filter((event) =>
      event.seq > beforeFocus
      && event.direction === 'to-worker'
      && event.t === 'query')).toEqual([]);

    const beforeAll = (await trace(page)).events.at(-1)?.seq ?? -1;
    await page.getByRole('button', { name: 'show all query totals' }).click();
    await expect(totals.locator('caption')).toContainText('all query columns');
    await expect(totals.locator('thead')).toContainText('Holmes');
    await expect(totals.locator('thead')).toContainText('Moriarty');
    expect((await trace(page)).events.filter((event) =>
      event.seq > beforeAll
      && event.direction === 'to-worker'
      && event.t === 'query')).toEqual([]);

    await page.getByRole('button', { name: 'by book', exact: true }).click();
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
