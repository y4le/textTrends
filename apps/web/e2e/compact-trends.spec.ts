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
    await expect(page.getByRole('button', { name: 'Trend settings', exact: true })).toBeVisible();

    const plateHeader = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('.trend-panel-header');
      const controls = document.querySelector<HTMLElement>('.trend-panel-controls');
      const switcher = document.querySelector<HTMLElement>('.trend-view-switcher');
      const toScale = switcher?.querySelector<HTMLElement>('button:last-of-type');
      const legend = document.querySelector<HTMLElement>('.trend-term-navigation');
      const entrance = document.querySelector<HTMLElement>('#trend-settings-open');
      if (!header || !controls || !switcher || !toScale || !legend || !entrance) return null;
      const headerBox = header.getBoundingClientRect();
      const switcherBox = switcher.getBoundingClientRect();
      const toScaleBox = toScale.getBoundingClientRect();
      const after = entrance.getBoundingClientRect();
      const hit = document.elementFromPoint(
        after.left + after.width / 2,
        after.top + after.height / 2,
      );
      return {
        header: { left: headerBox.left, right: headerBox.right },
        entrance: { left: after.left, right: after.right },
        wrapped: header.dataset.controlsWrapped === 'true',
        toScaleVisible: toScaleBox.left >= switcherBox.left - 1
          && toScaleBox.right <= switcherBox.right + 1,
        toScaleText: toScale.textContent,
        controlsDisplay: getComputedStyle(controls).display,
        legendOverflow: legend.scrollWidth > legend.clientWidth,
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
    expect(plateHeader!.wrapped).toBe(true);
    expect(plateHeader!.toScaleText).toBe('to scale');
    if (viewport.width === 390) expect(plateHeader!.toScaleVisible).toBe(true);
    expect(plateHeader!.controlsDisplay).toBe('contents');
    expect(plateHeader!.legendOverflow).toBe(true);
    expect(plateHeader!.headerScrollWidth).toBeLessThanOrEqual(
      plateHeader!.headerClientWidth + 1,
    );
    expect(plateHeader!.documentOverflows).toBe(false);
    expect(plateHeader!.hitTestable).toBe(true);

    const legendFrame = page.locator('.trend-term-navigation-frame');
    const legendPort = page.locator('.trend-term-navigation');
    await expect(legendFrame).toHaveAttribute('data-overflow-after', 'true');
    await legendPort.evaluate((port) => { port.scrollLeft = port.scrollWidth; });
    await expect(legendFrame).toHaveAttribute('data-overflow-before', 'true');
    await legendPort.evaluate((port) => { port.scrollLeft = 0; });

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
    const coarseProject = testInfo.project.name === 'webkit-compact';
    expect((await rowResize.boundingBox())?.height)
      .toBeGreaterThanOrEqual(coarseProject ? 44 : 24);
    await expect(rowResize).toHaveCSS('touch-action', 'none');
    await rowResize.focus();
    await rowResize.press('ArrowUp');
    await expect(rowResize).toHaveAttribute('aria-valuetext', /titles hidden/);
    await expect(byBook.locator('[data-trend-row-title]')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Select whole texts' })
      .locator('[data-title-painted="false"]')).toHaveCount(
        await byBook.locator('[data-trend-row-axis]').count(),
      );
    if (coarseProject) {
      await rowResize.press('Home');
      await expect(rowResize).toHaveAttribute('aria-valuenow', '26');
      await expect(rowResize).toHaveAttribute('data-row-phase', 'drop');
      await expect(scrubber.locator('canvas[data-barcode-band="by-book"]')).toHaveCount(0);
      expect(Number(await firstHitRow.getAttribute('height'))).toBe(24);
      await rowResize.press('ArrowDown');
      await expect(rowResize).toHaveAttribute('aria-valuenow', '39');
      await expect(rowResize).toHaveAttribute('data-row-phase', 'ink');
      await expect(scrubber.locator('canvas[data-barcode-band="by-book"]')).toHaveCount(
        await byBook.locator('[data-trend-row-axis]').count(),
      );
    }
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

for (const width of [800, 950]) {
  test(`regular Trends keeps layout and legend controls separate at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('./');
    await awaitAllReady(page, { loadDemo: true });
    await gotoPlace(page, 'trends');

    const header = page.locator('.trend-panel-header');
    const controls = page.locator('.trend-panel-controls');
    const switcher = page.locator('.trend-view-switcher');
    const legendFrame = page.locator('.trend-term-navigation-frame');
    const legend = page.locator('.trend-term-navigation');
    await expect(header).toHaveAttribute('data-controls-wrapped', 'true');
    await expect(switcher.getByRole('button', { name: 'To scale — separate rows, same token scale' }))
      .toHaveText('to scale');
    await expect(controls).toHaveCSS('display', 'contents');
    expect(await switcher.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    const legendOverflows = await legend.evaluate((node) => node.scrollWidth > node.clientWidth);
    if (legendOverflows) {
      await expect(legendFrame).toHaveAttribute('data-overflow-after', 'true');
    } else {
      await expect(legendFrame).not.toHaveAttribute('data-overflow-after');
    }
  });
}

test('short landscape restores Trends content and moves footer focus to Terms', async ({ page }) => {
  await page.setViewportSize({ width: 750, height: 900 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'trends');

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  await expect(footer).toBeVisible();
  const tallDockHeight = (await page.locator('.workbench-dock').boundingBox())!.height;
  await page.getByRole('slider', { name: 'Corpus footer position' }).focus();

  await page.setViewportSize({ width: 750, height: 340 });
  await expect(footer).toHaveCount(0);
  await expect(page.getByRole('separator', { name: 'Resize reading footer' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Terms' })).toBeVisible();
  await expect(page.locator('[data-term-focus]:not(:disabled)').first()).toBeFocused();
  await expect(page.getByRole('complementary', { name: 'Guided tour invitation' })).toHaveCount(0);
  await expect(page.locator('.trend-panel-header')).not.toHaveAttribute(
    'data-controls-wrapped',
    'true',
  );
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'Help' });
  await expect(help.getByRole('heading', { name: 'Reading footer', exact: true })).toHaveCount(0);
  await expect(help.getByRole('heading', { name: 'Footer size', exact: true })).toHaveCount(0);
  await help.getByRole('button', { name: 'close', exact: true }).click();

  const landscape = await page.evaluate(() => {
    const chart = document.querySelector<HTMLElement>('.trend-scrubber')!.getBoundingClientRect();
    const dock = document.querySelector<HTMLElement>('.workbench-dock')!.getBoundingClientRect();
    const root = getComputedStyle(document.documentElement);
    return {
      chartVisibleHeight: Math.max(0, Math.min(chart.bottom, dock.top) - chart.top),
      dockHeight: dock.height,
      railHeight: Number.parseFloat(root.getPropertyValue('--terms-rail-block-size')),
      footerHeight: Number.parseFloat(root.getPropertyValue('--footer-block-size')),
    };
  });
  // WebKit's pre-existing 48px header leaves less plot than Chromium's 32px
  // header, but this still keeps a usable chart instead of covering it entirely.
  expect(landscape.chartVisibleHeight).toBeGreaterThan(80);
  expect(Math.abs(landscape.dockHeight - landscape.railHeight)).toBeLessThanOrEqual(1);
  expect(landscape.footerHeight).toBe(0);

  await page.setViewportSize({ width: 750, height: 900 });
  await expect(footer).toBeVisible();
  await expect.poll(async () => (await page.locator('.workbench-dock').boundingBox())!.height)
    .toBe(tallDockHeight);
});


test('Trends retains focus and row pitch while analysis reissues are held', async ({ page }) => {
  const workerPromise = page.waitForEvent('worker');
  await page.goto('./');
  const worker = await workerPromise;
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'trends' });
  await page.getByRole('button', { name: 'Separate rows, equal width', exact: true }).click();
  const scrubber = page.getByRole('slider', { name: 'Reading position scrubber' });
  const handle = page.getByRole('separator', { name: 'Resize trend rows' });
  await expect(handle).toBeVisible();
  const pitch = await handle.getAttribute('aria-valuenow');
  const saved = await page.evaluate(() => localStorage.getItem('texttrends/trend-rows/2'));
  await worker.evaluate(() => {
    const scope = globalThis as unknown as {
      postMessage(message: unknown, transfer?: Transferable[]): void;
      __ttHeldTrends?: { messages: { message: unknown; transfer?: Transferable[] }[]; release(): void };
    };
    const send = scope.postMessage.bind(scope);
    const gate = {
      messages: [] as { message: unknown; transfer?: Transferable[] }[],
      release() {
        scope.postMessage = send;
        for (const held of this.messages.splice(0)) send(held.message, held.transfer);
      },
    };
    scope.__ttHeldTrends = gate;
    scope.postMessage = (message, transfer) => {
      const candidate = message as { t?: string; data?: { op?: string } };
      if (candidate.t === 'result' && ['trend', 'dispersion'].includes(candidate.data?.op ?? '')) gate.messages.push({ message, ...(transfer ? { transfer } : {}) });
      else send(message, transfer);
    };
  });
  await scrubber.focus();
  const visibility = page.getByRole('button', { name: /^Shown in analysis:/ }).first();
  await visibility.evaluate((button) => (button as HTMLElement).click());
  await expect.poll(() => worker.evaluate(() => (globalThis as unknown as { __ttHeldTrends?: { messages: unknown[] } }).__ttHeldTrends?.messages.length ?? 0)).toBeGreaterThan(0);
  await expect(scrubber).toBeFocused();
  await expect(scrubber.locator('..')).toHaveAttribute('aria-busy', 'true');
  await expect(handle).toHaveAttribute('aria-valuenow', pitch!);
  await handle.click();
  await handle.press('Control+PageDown');
  await expect(handle).toHaveAttribute('aria-valuenow', pitch!);
  expect(await page.evaluate(() => localStorage.getItem('texttrends/trend-rows/2'))).toBe(saved);
  await scrubber.focus();
  expect(await scrubber.evaluate((element) => {
    let reachedDocument = false;
    const listener = () => { reachedDocument = true; };
    document.addEventListener('keydown', listener, { once: true });
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    document.removeEventListener('keydown', listener);
    return reachedDocument && !event.defaultPrevented;
  })).toBe(true);
  await worker.evaluate(() => (globalThis as unknown as { __ttHeldTrends?: { release(): void } }).__ttHeldTrends?.release());
  await expect(scrubber.locator('..')).not.toHaveAttribute('aria-busy', 'true');
  await expect(scrubber).toBeFocused();
});


test('a precise pointer resumes scrubbing after a touch hold anchor', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'trends' });
  const scrubber = page.getByRole('slider', { name: 'Reading position scrubber' });
  const bounds = await scrubber.boundingBox();
  if (!bounds) throw new Error('Trends has no geometry');
  const x = bounds.x + bounds.width * 0.25;
  const y = bounds.y + 20;
  await scrubber.dispatchEvent('pointerdown', { pointerId: 71, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y });
  await expect(page.getByText(/Range start set at/)).toBeVisible();
  await scrubber.dispatchEvent('pointermove', { pointerId: 72, pointerType: 'pen', isPrimary: true, clientX: bounds.x + bounds.width * 0.75, clientY: y });
  await expect(page.getByText(/Range start set at/)).toBeVisible();
  await scrubber.dispatchEvent('pointerup', { pointerId: 71, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y });
  const anchored = await scrubber.getAttribute('aria-valuenow');
  await scrubber.dispatchEvent('pointermove', { pointerId: 72, pointerType: 'pen', isPrimary: true, clientX: bounds.x + bounds.width * 0.75, clientY: y });
  await expect(scrubber).not.toHaveAttribute('aria-valuenow', anchored!);
  await expect(page.getByText(/Range start set at/)).toHaveCount(0);
});
