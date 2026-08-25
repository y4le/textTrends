import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, gotoPlace } from './helpers.ts';

async function rootMetric(page: Page, name: string): Promise<number> {
  return page.evaluate((property) => Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(property),
  ), name);
}

test('the fixed dock adds Reading only when active inputs exist', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('./');

  const dock = page.locator('.workbench-dock');
  const terms = page.getByRole('complementary', { name: 'Terms' });
  const termButtons = terms.locator('[data-term-toggle]:not(:disabled)');
  await expect(terms).toBeVisible();
  await expect(termButtons).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Reading position' })).toHaveCount(0);
  await expect.poll(() => rootMetric(page, '--dock-block-size'))
    .toBe(await rootMetric(page, '--terms-rail-block-size'));

  await page.getByRole('button', { name: 'Try the Sherlock Holmes sample' }).click();
  await expect(termButtons).toHaveCount(3);
  await expect.poll(() => rootMetric(page, '--footer-block-size')).toBeGreaterThan(0);
  const railTopBefore = (await terms.boundingBox())?.y;
  await awaitAllReady(page);
  const footer = page.getByRole('complementary', { name: 'Reading position' });
  await expect(footer).toBeVisible();
  const [dockBox, termsBox, footerBox] = await Promise.all([
    dock.boundingBox(),
    terms.boundingBox(),
    footer.boundingBox(),
  ]);
  if (!dockBox || !termsBox || !footerBox || railTopBefore === undefined) {
    throw new Error('dock geometry is unavailable');
  }
  const [railSize, dockSize, footerSize, viewportHeight] = await Promise.all([
    rootMetric(page, '--terms-rail-block-size'),
    rootMetric(page, '--dock-block-size'),
    rootMetric(page, '--footer-block-size'),
    page.evaluate(() => window.innerHeight),
  ]);

  expect(await dock.evaluate((node) => getComputedStyle(node).position)).toBe('fixed');
  expect(Math.abs(termsBox.y - railTopBefore)).toBeLessThanOrEqual(1);
  expect(termsBox.height).toBe(railSize);
  expect(footerBox.height).toBe(footerSize);
  expect(dockBox.height).toBe(dockSize);
  expect(dockBox.height).toBe(railSize + footerSize);
  expect(Math.abs(termsBox.y + termsBox.height - footerBox.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(dockBox.y + dockBox.height - viewportHeight)).toBeLessThanOrEqual(1);

  const dockTopBeforeScroll = dockBox.y;
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect((await dock.boundingBox())?.y).toBe(dockTopBeforeScroll);

  for (const place of ['matches', 'vocabulary', 'compare'] as const) {
    await gotoPlace(page, place);
    const surface = page.locator(`.app-shell[data-place="${place}"] .place-surface`);
    await expect(surface).toBeVisible();
    const [surfaceBox, placeDockBox] = await Promise.all([
      surface.boundingBox(),
      dock.boundingBox(),
    ]);
    if (!surfaceBox || !placeDockBox) {
      throw new Error(`${place} dock boundary geometry is unavailable`);
    }
    expect(Math.abs(surfaceBox.y + surfaceBox.height - placeDockBox.y))
      .toBeLessThanOrEqual(1);
  }
  await gotoPlace(page, 'trends');

  const slider = footer.getByRole('slider', { name: 'Corpus footer position' });
  await slider.focus();
  await slider.press('ArrowRight');
  await slider.press('Enter');
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await expect(reader.locator('.workbench-dock[data-mode="reader"]')).toBeVisible();
  await expect(reader.getByRole('complementary', { name: 'Terms' })).toBeVisible();
  await expect(reader.locator('.footer-passage')).toHaveCount(0);
});

test('the reading dock resizes through its full range and caps barcode growth', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const dock = page.locator('.workbench-dock');
  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const handle = page.getByRole('separator', { name: 'Resize reading footer' });
  const graph = footer.locator('.footer-sparkline');
  const barcode = footer.locator('canvas[data-barcode-band="series"]');
  const before = {
    dock: await dock.boundingBox(),
    footer: await footer.boundingBox(),
    graph: await graph.boundingBox(),
    barcode: await barcode.boundingBox(),
  };
  if (!before.dock || !before.footer || !before.graph || !before.barcode) {
    throw new Error('resizable footer geometry is unavailable');
  }
  const minimum = Number(await handle.getAttribute('aria-valuemin'));
  expect(minimum).toBeLessThan(before.dock.height);
  await expect(handle).toHaveAttribute('aria-valuenow', String(before.dock.height));

  const drag = async (upward: number) => {
    const box = await handle.boundingBox();
    if (!box) throw new Error('footer resize handle has no layout box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - upward);
    await page.mouse.up();
  };

  await drag(120);
  const grown = {
    dock: await dock.boundingBox(),
    footer: await footer.boundingBox(),
    graph: await graph.boundingBox(),
    barcode: await barcode.boundingBox(),
  };
  if (!grown.dock || !grown.footer || !grown.graph || !grown.barcode) {
    throw new Error('grown footer geometry is unavailable');
  }
  expect(grown.footer.height).toBe(before.footer.height + 120);
  expect(grown.graph.height).toBeGreaterThan(before.graph.height);
  expect(grown.barcode.height).toBeGreaterThan(before.barcode.height);
  expect(grown.dock.y).toBe(before.dock.y - 120);
  expect(grown.dock.y + grown.dock.height).toBe(before.dock.y + before.dock.height);
  await expect(handle).toHaveAttribute('aria-valuenow', String(grown.dock.height));

  await drag(80);
  const cappedBarcodeHeight = (await barcode.boundingBox())?.height;
  const tallerGraphHeight = (await graph.boundingBox())?.height;
  expect(cappedBarcodeHeight).toBe(grown.barcode.height);
  expect(tallerGraphHeight).toBe(grown.graph.height + 80);

  await handle.focus();
  await handle.press('Enter');
  expect((await footer.boundingBox())?.height).toBe(before.footer.height);
  await handle.press('ArrowUp');
  expect((await footer.boundingBox())?.height).toBe(before.footer.height + 16);
  await handle.press('ArrowDown');
  expect((await footer.boundingBox())?.height).toBe(before.footer.height);

  const terms = page.getByRole('complementary', { name: 'Terms' });
  const [baseRailHeight, baseTermTarget] = await Promise.all([
    terms.boundingBox().then((box) => box?.height),
    rootMetric(page, '--term-target-block-size'),
  ]);
  await drag(-10);
  expect((await terms.boundingBox())?.height).toBe((baseRailHeight ?? 0) - 10);
  const earlyToggleHeight = (await page.locator('.term-bucket-toggle').first().boundingBox())?.height;
  expect(earlyToggleHeight).toBeLessThan(baseTermTarget);
  expect(earlyToggleHeight).toBeGreaterThan(24);
  expect((await footer.boundingBox())?.height).toBe(before.footer.height);
  await handle.press('Enter');

  const defaultDock = await dock.boundingBox();
  await drag(-90);
  const shrunkDock = await dock.boundingBox();
  if (!defaultDock || !shrunkDock) throw new Error('shrunk dock geometry is unavailable');
  expect(shrunkDock.height).toBe(defaultDock.height - 90);
  expect(shrunkDock.y).toBe(defaultDock.y + 90);
  expect(shrunkDock.y + shrunkDock.height).toBe(defaultDock.y + defaultDock.height);
  await expect(footer.locator('.footer-reading-status')).toHaveCount(0);
  await expect(footer.locator('canvas[data-barcode-band="series"]')).toHaveCount(0);
  await expect(handle).toHaveAttribute('aria-valuetext', /terms, passage, graph$/);

  await handle.press('Home');
  await expect(handle).toHaveAttribute('aria-valuenow', String(minimum));
  expect((await dock.boundingBox())?.height).toBe(minimum);
  const coarse = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
  expect((await footer.locator('.footer-passage').boundingBox())?.height)
    .toBe(coarse ? 24 : 20);
  expect((await graph.boundingBox())?.height).toBe(coarse ? 24 : 12);
  expect((await page.getByRole('complementary', { name: 'Terms' }).boundingBox())?.height)
    .toBe(31);
  const minimumToggleHeight = (await page.locator('.term-bucket-toggle').first().boundingBox())?.height ?? 0;
  expect(minimumToggleHeight).toBeGreaterThanOrEqual(24);
  expect(minimumToggleHeight).toBeLessThanOrEqual(31);
  await expect(footer.locator('canvas[data-barcode-band="series"]')).toHaveCount(0);

  await handle.press('End');
  const [maximizedDock, header] = await Promise.all([
    dock.boundingBox(),
    page.locator('.app-header').boundingBox(),
  ]);
  if (!maximizedDock || !header) throw new Error('maximum footer geometry is unavailable');
  expect(Math.abs(maximizedDock.y - (header.y + header.height))).toBeLessThanOrEqual(1);
  await handle.press('Enter');
  expect((await dock.boundingBox())?.height).toBe(before.dock.height);
});

test('Compact density starts with the footer Trends graph at its floor', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('texttrends/display/1', JSON.stringify({
      density: 'compact',
      theme: 'system',
    }));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const dock = page.locator('.workbench-dock');
  const graph = page.locator('.footer-sparkline');
  const status = page.locator('.footer-reading-status');
  const barcode = page.locator('canvas[data-barcode-band="series"]');
  const strip = page.getByRole('slider', { name: 'Corpus footer position' });
  const term = page.locator('.term-bucket-toggle').first();
  const handle = page.getByRole('separator', { name: 'Resize reading footer' });
  const compact = {
    dock: (await dock.boundingBox())!.height,
    graph: (await graph.boundingBox())!.height,
    barcode: (await barcode.boundingBox())!.height,
  };
  await expect(status).toBeVisible();
  await expect(barcode).toBeVisible();
  const [stripBox, graphBox] = await Promise.all([
    strip.boundingBox(),
    graph.boundingBox(),
  ]);
  if (!stripBox || !graphBox) throw new Error('Compact footer strip has no layout box');
  // The graph must begin at the strip edge. A restored coarse strip reserve
  // would leave dead space above it while still passing relative-size checks.
  expect(Math.abs(graphBox.y - stripBox.y)).toBeLessThanOrEqual(1);
  const coarse = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
  expect((await term.boundingBox())!.height).toBeGreaterThanOrEqual(coarse ? 44 : 36);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  let pane = page.getByRole('dialog', { name: 'Settings', exact: true });
  let density = pane.getByRole('slider', { name: 'Size and spacing' });
  await density.fill('1');
  expect((await dock.boundingBox())!.height).toBeGreaterThan(compact.dock);
  expect((await graph.boundingBox())!.height).toBeGreaterThan(compact.graph);
  expect((await barcode.boundingBox())!.height).toBe(compact.barcode);
  await density.fill('0');
  expect((await dock.boundingBox())!.height).toBe(compact.dock);
  await pane.getByRole('button', { name: 'close', exact: true }).click();

  await handle.focus();
  await handle.press('ArrowUp');
  const explicit = (await dock.boundingBox())!.height;
  expect(explicit).toBe(compact.dock + 16);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  pane = page.getByRole('dialog', { name: 'Settings', exact: true });
  density = pane.getByRole('slider', { name: 'Size and spacing' });
  await density.fill('2');
  expect((await dock.boundingBox())!.height).toBe(explicit);
  await density.fill('0');
  expect((await dock.boundingBox())!.height).toBe(explicit);
  await pane.getByRole('button', { name: 'close', exact: true }).click();
  await handle.dblclick();
  expect((await dock.boundingBox())!.height).toBe(compact.dock);
});

test('the compact dock stays one row, pins its actions, and opens Undo upward', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const dock = page.locator('.workbench-dock');
  const terms = page.getByRole('complementary', { name: 'Terms' });
  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const lens = page.getByRole('navigation', { name: 'Workbench sections' });
  const port = terms.getByRole('group', { name: 'Query terms' });
  const [dockBox, termsBox, footerBox, lensBox] = await Promise.all([
    dock.boundingBox(),
    terms.boundingBox(),
    footer.boundingBox(),
    lens.boundingBox(),
  ]);
  if (!dockBox || !termsBox || !footerBox || !lensBox) {
    throw new Error('compact dock geometry is unavailable');
  }
  expect(termsBox.height).toBe(await rootMetric(page, '--terms-rail-block-size'));
  expect(Math.abs(termsBox.y + termsBox.height - footerBox.y)).toBeLessThanOrEqual(1);
  expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(lensBox.y + 1);
  await expect(terms.locator('.term-bar-label')).toBeHidden();
  expect(await port.evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);

  for (const control of [
    terms.locator('.term-bucket-toggle').first(),
    terms.getByRole('button', { name: 'Add term', exact: true }),
    terms.getByRole('button', { name: 'Manage', exact: true }),
  ]) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBe(await page.evaluate(() =>
      matchMedia('(any-pointer: coarse)').matches ? 44 : 40));
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect(box ? box.x + box.width : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(390);
  }
  await expect(terms.getByRole('button', { name: /^Remove / }).first()).toBeHidden();

  await terms.getByRole('button', { name: 'Manage', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Manage terms' });
  await manager.getByRole('button', { name: 'Remove Holmes' }).click();
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
  const undo = page.locator('.term-undo');
  await expect(undo).toBeVisible();
  const [settledTermsBox, undoBox] = await Promise.all([terms.boundingBox(), undo.boundingBox()]);
  if (!settledTermsBox || !undoBox) throw new Error('Undo geometry is unavailable');
  expect(undoBox.y + undoBox.height).toBeLessThanOrEqual(settledTermsBox.y - 3);
  expect(undoBox.y).toBeGreaterThanOrEqual(0);
  await undo.getByRole('button', { name: 'Undo', exact: true }).click();

  const overflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.root).toBeLessThanOrEqual(overflow.client);
  expect(overflow.body).toBeLessThanOrEqual(overflow.client);
});

test('the coarse regular-width rail keeps compact-height, wide actions', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'webkit-compact', 'requires a coarse-pointer project');
  await page.setViewportSize({ width: 834, height: 1112 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const terms = page.getByRole('complementary', { name: 'Terms' });
  const edit = terms.getByRole('button', { name: /^Edit term:/ }).first();
  await expect(edit).toBeVisible();
  const editBox = await edit.boundingBox();
  expect(editBox?.width).toBeGreaterThanOrEqual(44);
  expect(editBox?.height).toBe(44);
});
