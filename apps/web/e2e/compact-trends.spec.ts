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
  await page.getByRole('button', { name: 'Combined sequence', exact: true }).click();

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
    await page.getByRole('button', { name: 'Combined sequence', exact: true }).click();

    const plateHeader = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('.trend-panel-header');
      const controls = document.querySelector<HTMLElement>('.trend-panel-controls');
      const entrance = document.querySelector<HTMLElement>('#trend-settings-open');
      if (!header || !controls || !entrance) return null;
      const headerBox = header.getBoundingClientRect();
      const before = entrance.getBoundingClientRect();
      controls.scrollLeft = controls.scrollWidth;
      const after = entrance.getBoundingClientRect();
      const hit = document.elementFromPoint(
        after.left + after.width / 2,
        after.top + after.height / 2,
      );
      return {
        header: { left: headerBox.left, right: headerBox.right },
        entrance: { left: after.left, right: after.right },
        shiftedByLocalScroll: Math.abs(after.left - before.left),
        controlsOverflow: controls.scrollWidth > controls.clientWidth,
        headerScrollWidth: header.scrollWidth,
        headerClientWidth: header.clientWidth,
        documentOverflows:
          document.documentElement.scrollWidth > document.documentElement.clientWidth,
        hitTestable: hit === entrance || entrance.contains(hit),
      };
    });
    expect(plateHeader).not.toBeNull();
    expect(plateHeader!.entrance.left).toBeGreaterThanOrEqual(plateHeader!.header.left);
    expect(plateHeader!.entrance.right).toBeLessThanOrEqual(plateHeader!.header.right + 1);
    expect(plateHeader!.shiftedByLocalScroll).toBeLessThanOrEqual(1);
    expect(plateHeader!.controlsOverflow).toBe(true);
    expect(plateHeader!.headerScrollWidth).toBeLessThanOrEqual(
      plateHeader!.headerClientWidth + 1,
    );
    expect(plateHeader!.documentOverflows).toBe(false);
    expect(plateHeader!.hitTestable).toBe(true);

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
      expect((await footer.locator('.footer-passage').boundingBox())?.height).toBe(24);
      expect((await footer.locator('.footer-sparkline').boundingBox())?.height).toBe(38);
      expect((await footer.locator('canvas[data-barcode-band="series"]').boundingBox())?.height)
        .toBe(27);
      expect((await footer.getByRole('slider', { name: 'Corpus footer position' }).boundingBox())?.height)
        .toBe(70);
    }

    const scrubber = page.getByRole('slider', { name: /reading position/i });
    const seriesChart = page.locator('svg[data-trend-view="series"]');
    await expect(seriesChart).toBeVisible();
    expect(await seriesChart.locator('[data-series-path]').first().evaluate(
      (path) => (path as SVGGraphicsElement).getBBox().x,
    )).toBe(0);
    // 132px plot + 3px band gap + three 7px compact barcode rows + 34px labels.
    expect((await seriesChart.boundingBox())?.height).toBe(190);
    expect(await seriesChart.locator('[data-trend-row-title]').count()).toBeGreaterThan(0);
    expect(await seriesChart.locator('[data-trend-row-title]').first().evaluate(
      (label) => label.firstChild?.textContent,
    )).toBe('1');
    const barcodeBand = scrubber.locator('canvas[data-barcode-band="series"]');
    await expect(barcodeBand).toHaveCount(1);
    expect((await barcodeBand.boundingBox())?.height).toBe(21);
    expect(await scrubber.evaluate((node) => getComputedStyle(node).touchAction)).toBe('pan-y');

    await expect.poll(async () => {
      const chart = await seriesChart.boundingBox();
      const owner = await scrubber.boundingBox();
      return chart && owner ? Math.abs(chart.width - owner.width) : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(1);
    const paintedLabels = await seriesChart.locator('text').evaluateAll((labels) => labels.map(
      (label) => [...label.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join(''),
    ));
    expect(paintedLabels).not.toContain('Holmes');
    expect(paintedLabels).not.toContain('Moriarty');

    const strokes = await seriesChart.locator('[data-series-path]').evaluateAll((paths) =>
      [...new Set(paths.map((path) => Number(path.getAttribute('stroke-width'))))].sort(),
    );
    expect(strokes).toEqual([2]);

    await expect(page.getByRole('table', { name: /exact totals by book/i })).toHaveCount(0);
    await expect(page.getByText(/Exact totals by book are in/)).toHaveCount(0);
    const overview = page.locator('[data-trend-organ="overview"]');
    await expect(overview).toBeVisible();
    const [scrubberBox, overviewBox] = await Promise.all([
      scrubber.boundingBox(),
      overview.boundingBox(),
    ]);
    expect(scrubberBox && overviewBox
      ? overviewBox.y - (scrubberBox.y + scrubberBox.height)
      : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(8);
    await expect(overview.locator('[data-trend-overview-section="company"]')).toBeVisible();
    await expect(overview.locator('[data-trend-overview-section="destinations"]')).toBeVisible();
    const overviewLayout = await overview.evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      columns: getComputedStyle(node.querySelector('.trend-overview-grid')!).gridTemplateColumns,
    }));
    expect(overviewLayout.scrollWidth).toBeLessThanOrEqual(overviewLayout.clientWidth + 1);
    expect(overviewLayout.columns.trim().split(/\s+/)).toHaveLength(1);
    expect((await overview.locator('.company-pair').first().boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const occurrenceRows = page.getByRole('list', { name: 'Term totals' })
      .getByRole('listitem');
    await expect(occurrenceRows).toHaveCount(3);

    await page.getByRole('button', { name: 'Separate rows, equal width', exact: true }).click();
    const byBook = page.locator('svg[data-trend-view="by-book"]');
    await expect(byBook).toBeVisible();
    const firstTitle = byBook.locator('[data-trend-row-title="0"]');
    const firstHitRow = byBook.locator('[data-trend-hit-row="0"]').first();
    const [titleY, rowY, rowHeight] = await Promise.all([
      firstTitle.getAttribute('y'),
      firstHitRow.getAttribute('y'),
      firstHitRow.getAttribute('height'),
    ]);
    expect(titleY).not.toBeNull();
    expect(rowY).not.toBeNull();
    expect(rowHeight).not.toBeNull();
    expect(Number(titleY) - (Number(rowY) + Number(rowHeight)))
      .toBeGreaterThanOrEqual(7);
    const firstRow = await firstHitRow.boundingBox();
    expect(firstRow?.height).toBe(28);
    const rowResize = page.getByRole('separator', { name: 'Resize trend rows' });
    expect((await rowResize.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expect(rowResize).toHaveCSS('touch-action', 'none');
    await rowResize.focus();
    await rowResize.press('ArrowUp');
    await expect(rowResize).toHaveAttribute('aria-valuetext', /titles hidden/);
    await expect(byBook.locator('[data-trend-row-title]')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Select whole texts' })
      .locator('[data-title-painted="false"]')).toHaveCount(
        await byBook.locator('[data-trend-row-axis]').count(),
      );
    await rowResize.press('Enter');
    await expect(byBook.locator('[data-trend-row-title]')).not.toHaveCount(0);

    const overflow = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      root: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(overflow.root).toBeLessThanOrEqual(overflow.client);
    expect(overflow.body).toBeLessThanOrEqual(overflow.client);
  });
}
