import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, DOC_COUNT, gotoPlace, simulateKeyboard } from './helpers.ts';

test('the header exposes Find to touch and restores focus on close', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const open = page.getByRole('button', { name: 'Find', exact: true });
  await expect(open).toBeVisible();
  await open.click();
  await expect(page.getByRole('searchbox', { name: 'Find term or aliases' })).toBeFocused();
  await page.getByRole('button', { name: 'Clear and close find' }).click();
  await expect(open).toBeFocused();
  await context.close();
});

test('the 320px Find takeover grows the dock above an unchanged footer', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'trends' });

  const dock = page.locator('.workbench-dock');
  const terms = page.getByRole('complementary', { name: 'Terms' });
  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const handle = page.getByRole('separator', { name: 'Resize reading footer' });
  const open = page.getByRole('button', { name: 'Find', exact: true });
  const [closedDockBox, closedTermsBox, closedFooterBox] = await Promise.all([
    dock.boundingBox(),
    terms.boundingBox(),
    footer.boundingBox(),
  ]);
  if (!closedDockBox || !closedTermsBox || !closedFooterBox) {
    throw new Error('closed Find geometry is unavailable');
  }

  await open.click();
  const find = page.getByRole('search', { name: 'Find in corpus' });
  const takeover = find.getByRole('form', { name: 'Find in corpus controls' });
  const input = takeover.getByRole('searchbox', { name: 'Find term or aliases' });
  const upper = takeover.locator('.dock-takeover-upper');
  const [openDockBox, openFindBox, openFooterBox, handleBox, inputBox, upperBox] = await Promise.all([
    dock.boundingBox(),
    find.boundingBox(),
    footer.boundingBox(),
    handle.boundingBox(),
    input.boundingBox(),
    upper.boundingBox(),
  ]);
  if (!openDockBox || !openFindBox || !openFooterBox || !handleBox || !inputBox || !upperBox) {
    throw new Error('open Find geometry is unavailable');
  }
  expect(openDockBox.y + openDockBox.height).toBe(closedDockBox.y + closedDockBox.height);
  expect(openDockBox.height - closedDockBox.height)
    .toBe(openFindBox.height - closedTermsBox.height);
  expect(openFindBox.height).toBeGreaterThanOrEqual(96);
  expect(openFooterBox).toEqual(closedFooterBox);
  expect(handleBox.y + handleBox.height).toBeLessThanOrEqual(upperBox.y + 1);
  expect(Math.abs(inputBox.y + inputBox.height - (openFindBox.y + openFindBox.height)))
    .toBeLessThanOrEqual(1);
  expect(Math.abs(upperBox.y + upperBox.height - inputBox.y)).toBeLessThanOrEqual(1);
  await expect(input).toHaveCSS('font-size', '16px');
  await expect(input).toHaveAttribute('enterkeyhint', 'search');
  await expect(takeover.locator('.dock-takeover-label')).toHaveCSS('clip-path', 'inset(50%)');
  expect(await upper.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await expect(find.getByRole('button', { name: 'Submit find' })).toBeVisible();
  await expect(find.getByRole('button', { name: 'Save Find as term' })).toHaveCount(0);
  for (const control of await takeover.getByRole('button').all()) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(await control.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + 1)?.closest('button')
        === node;
    })).toBe(true);
  }

  await input.fill('wo*lf');
  await find.getByRole('button', { name: 'Submit find' }).click();
  await expect(takeover.locator('.dock-takeover-status')).toContainText('start or end');
  await expect(find.locator('#corpus-find-error')).toContainText('start or end');
  await expect(input).toHaveValue('wo*lf');
  await expect(input).toBeFocused();
  await input.fill('the');
  await expect(takeover.locator('.dock-takeover-status')).not.toContainText('start or end');
  await input.press('Enter');
  await expect(find.getByRole('button', { name: 'Next match' })).toBeFocused();
  await expect(find.getByRole('button', { name: 'Submit find' })).toHaveCount(0);
  await expect(find.getByRole('button', { name: /Open current Find result in Reader:/ }))
    .toBeVisible();
  for (const control of await takeover.getByRole('button').all()) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  expect(await upper.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);

  const progress = find.locator('[data-find-match-progress]');
  const exactProgress = progress.locator('[data-find-match-exact]');
  await expect(exactProgress).toHaveText(/^\d[\d,]*\/\d[\d,]*$/);
  await expect(progress.locator('.find-bar-progress-percent')).toHaveText(/^\d{1,3}%$/);
  const initialProgress = await exactProgress.textContent();
  await find.getByRole('button', { name: 'Previous match' }).click();
  await expect.poll(() => exactProgress.textContent()).not.toBe(initialProgress);
  expect(await upper.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  const [resultBox, closeBox] = await Promise.all([
    find.getByRole('button', { name: /Open current Find result in Reader:/ }).boundingBox(),
    find.getByRole('button', { name: 'Clear and close find' }).boundingBox(),
  ]);
  if (!resultBox || !closeBox) throw new Error('wrapped Find controls are unavailable');
  expect(resultBox.width).toBe(44);
  expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(320);

  await input.fill('there');
  await expect(find.getByRole('button', { name: 'Submit find' })).toBeVisible();
  await expect(find.getByRole('button', { name: 'Previous match' })).toHaveCount(0);
  await expect(find.getByRole('button', { name: 'Next match' })).toHaveCount(0);
  await expect(find.getByRole('button', { name: 'Save Find as term' })).toHaveCount(0);
  await expect(input).toHaveValue('there');
  await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
  await expect(find).toBeVisible();
  await expect(input).toBeFocused();
  await input.press('Escape');
  await expect(find).toHaveCount(0);
  await expect(open).toBeFocused();

  const overflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.root).toBeLessThanOrEqual(overflow.client);
  expect(overflow.body).toBeLessThanOrEqual(overflow.client);
});

test('temporary Find cycles exact corpus matches and preserves focus priority', async ({ page }, testInfo) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'trends' });

  const footer = page.getByRole('slider', { name: 'Corpus footer position' });
  const terms = page.getByRole('complementary', { name: 'Terms' });
  await page.getByRole('button', { name: 'Combined sequence', exact: true }).click();
  const seriesChart = page.locator('svg[data-trend-view="series"]');
  const mainBarcode = page.getByRole('slider', { name: 'Reading position scrubber' })
    .locator('canvas[data-barcode-band="series"]');
  const footerBarcode = footer.locator('canvas[data-barcode-band="series"]');
  await expect(seriesChart).toBeVisible();
  await expect(footerBarcode).toBeVisible();
  const durableBarcodeHeight = (await mainBarcode.boundingBox())?.height;
  const durableFooterBarcodeHeight = (await footerBarcode.boundingBox())?.height;
  await expect.poll(() => page.locator('[data-series-path]').count()).toBeGreaterThan(1);
  const durableSeries = await page.locator('[data-series-path]').evaluateAll((paths) =>
    [...new Set(paths.map((path) => path.getAttribute('data-series-path')).filter(Boolean))].sort(),
  );
  const durableLabelNodes = page.locator('[data-term-occurrence-label]');
  await expect.poll(() => durableLabelNodes.count()).toBeGreaterThan(1);
  const durableLabels = await durableLabelNodes.allTextContents();
  expect(durableSeries.length).toBeGreaterThan(1);
  expect(durableLabels.length).toBeGreaterThan(1);
  await footer.focus();
  const before = await footer.getAttribute('aria-valuenow');
  await footer.press('Meta+f');

  const find = page.getByRole('search', { name: 'Find in corpus' });
  const input = find.getByRole('searchbox', { name: 'Find term or aliases' });
  const next = find.getByRole('button', { name: 'Next match' });
  const status = find.locator('#corpus-find-status');
  await expect(find).toBeVisible();
  await expect(terms).toHaveCount(0);
  await expect(find.locator('label[for="corpus-find-input"]')).toHaveText('Find');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('autocomplete', 'off');
  await expect(find.getByRole('button', { name: 'Submit find' })).toBeVisible();
  await expect(find.getByRole('button', { name: 'Save Find as term' })).toHaveCount(0);
  await expect(find.getByRole('button', { name: 'Previous match' })).toHaveCount(0);
  await expect(find.getByRole('button', { name: 'Next match' })).toHaveCount(0);
  await expect(seriesChart).toBeVisible();
  await expect.poll(async () => seriesChart.locator('[data-series-path]').evaluateAll((paths) =>
    [...new Set(paths.map((path) => path.getAttribute('data-series-path')).filter(Boolean))].sort(),
  )).toEqual(durableSeries);
  await expect.poll(async () => seriesChart.locator('[data-series-ghost="true"]').evaluateAll((paths) =>
    [...new Set(paths.map((path) => path.getAttribute('data-series-path')).filter(Boolean))].sort(),
  )).toEqual(durableSeries);
  await expect(seriesChart).toHaveAttribute('aria-label', /de-emphasized context while Find awaits a query/i);
  await expect.poll(async () => page.locator('[data-barcode-background-series]').evaluateAll((canvases) =>
    [...new Set(canvases.flatMap((canvas) =>
      (canvas.getAttribute('data-barcode-background-series') ?? '').split(/\s+/).filter(Boolean),
    ))].sort(),
  )).toEqual(durableSeries);
  expect((await mainBarcode.boundingBox())?.height).toBe(durableBarcodeHeight);
  expect((await footerBarcode.boundingBox())?.height).toBe(durableFooterBarcodeHeight);
  await expect.poll(async () => footer.locator('[data-footer-series-ghost="true"]')
    .evaluateAll((paths) =>
      [...new Set(paths.map((path) => path.getAttribute('data-footer-series-path')).filter(Boolean))].sort(),
    )).toEqual(durableSeries);
  await expect(page.locator('[data-series-path^="find-series:"]')).toHaveCount(0);
  await input.fill('holmes, Sherlock Holmes');
  await input.press('Enter');
  await expect(next).toBeFocused();
  await expect(status).toContainText(/holmes/i);
  await expect(status).not.toContainText('Searching');
  const progress = find.locator('[data-find-match-progress]');
  const progressValue = progress.locator('[data-find-match-exact]');
  await expect(progressValue).toHaveText(/^\d[\d,]*\/\d[\d,]*$/);
  await expect(progress).toHaveAccessibleName(/^Find match [\d,]+ of [\d,]+$/);
  const firstProgress = await progressValue.textContent();
  await expect.poll(() => footer.getAttribute('aria-valuenow')).not.toBe(before);
  const result = find.getByRole('button', { name: /Open current Find result in Reader:/ });
  await result.focus();
  await result.press('Enter');
  const resultReader = page.getByRole('main', { name: /Reader:/ });
  await expect(resultReader).toBeVisible();
  await resultReader.getByRole('button', { name: 'back', exact: true }).click();
  await expect(resultReader).toHaveCount(0);
  await expect(result).toBeFocused();
  await page.getByRole('button', { name: 'Combined sequence', exact: true }).click();
  await expect(seriesChart).toBeVisible();
  const findPath = page.locator('[data-series-path^="find-series:"]').first();
  await expect(findPath).toBeVisible();
  const findSeriesId = await findPath.getAttribute('data-series-path');
  expect(findSeriesId).toMatch(/^find-series:/);
  if (findSeriesId === null) throw new Error('Find graph path is missing its series identity');
  await expect.poll(async () => page.locator('[data-series-path]').evaluateAll((paths) =>
    [...new Set(paths.map((path) => path.getAttribute('data-series-path')).filter(Boolean))].sort(),
  )).toEqual([...durableSeries, findSeriesId].sort());
  await expect.poll(async () => page.locator('[data-series-ghost="true"]').evaluateAll((paths) =>
    [...new Set(paths.map((path) => path.getAttribute('data-series-path')).filter(Boolean))].sort(),
  )).toEqual(durableSeries);
  await expect(seriesChart).toHaveAttribute('aria-label', /Find holmes, with .*de-emphasized context/i);
  const foregroundStroke = Number(await findPath.getAttribute('stroke-width'));
  const ghostStyles = await seriesChart.locator('[data-series-ghost="true"]').evaluateAll((paths) =>
    paths.map((path) => ({
      opacity: path.getAttribute('opacity'),
      pointerEvents: path.getAttribute('pointer-events'),
      strokeWidth: Number(path.getAttribute('stroke-width')),
    })),
  );
  expect(ghostStyles.length).toBeGreaterThan(0);
  expect(ghostStyles.every((style) => style.opacity === '0.38')).toBe(true);
  expect(ghostStyles.every((style) => style.pointerEvents === 'none')).toBe(true);
  expect(ghostStyles.every((style) => style.strokeWidth < foregroundStroke)).toBe(true);
  expect(await seriesChart.locator('[data-series-path]').evaluateAll((paths) => {
    const lastGhost = paths.findLastIndex((path) => path.hasAttribute('data-series-ghost'));
    const firstForeground = paths.findIndex((path) => !path.hasAttribute('data-series-ghost'));
    return lastGhost < firstForeground;
  })).toBe(true);
  const hoverReadout = await seriesChart.locator('rect title').first().textContent();
  expect(hoverReadout?.split('\n').slice(1)).toEqual([expect.stringMatching(/^holmes:/)]);
  await expect(findPath).not.toHaveAttribute('data-series-ghost');
  await expect(findPath).toHaveAttribute('data-series-find-foreground', 'true');
  await expect(findPath).toHaveAttribute('opacity', '1');
  const findHalo = seriesChart.locator(`[data-series-find-halo="${findSeriesId}"]`).first();
  await expect(findHalo).toBeVisible();
  expect(Number(await findHalo.getAttribute('stroke-width'))).toBeGreaterThan(foregroundStroke);
  await expect.poll(async () => page.locator('[data-footer-series-path]').evaluateAll((paths) =>
    [...new Set(paths.map((path) => path.getAttribute('data-footer-series-path')).filter(Boolean))].sort(),
  )).toEqual([...durableSeries, findSeriesId].sort());
  await expect.poll(async () => page.locator('[data-footer-series-ghost="true"]').evaluateAll((paths) =>
    [...new Set(paths.map((path) => path.getAttribute('data-footer-series-path')).filter(Boolean))].sort(),
  )).toEqual(durableSeries);
  expect(await page.locator('[data-footer-series-ghost="true"]').evaluateAll((paths) => paths.every((path) =>
    path.getAttribute('opacity') === '0.38'
      && path.getAttribute('pointer-events') === 'none',
  ))).toBe(true);
  const footerFindPath = footer.locator(`[data-footer-series-find-foreground="true"][data-footer-series-path="${findSeriesId}"]`).first();
  await expect(footerFindPath).toBeVisible();
  await expect(footer.locator(`[data-footer-series-find-halo="${findSeriesId}"]`).first()).toBeVisible();
  await expect.poll(async () => page.locator('[data-barcode-series]').evaluateAll((canvases) =>
    [...new Set(canvases.map((canvas) => canvas.getAttribute('data-barcode-series')).filter(Boolean))],
  )).toEqual([findSeriesId]);
  await expect.poll(async () => page.locator('[data-barcode-background-series]').evaluateAll((canvases) =>
    [...new Set(canvases.flatMap((canvas) =>
      (canvas.getAttribute('data-barcode-background-series') ?? '').split(/\s+/).filter(Boolean),
    ))].sort(),
  )).toEqual(durableSeries);
  await expect(page.locator('[data-barcode-foreground-overlay="true"]')).not.toHaveCount(0);
  expect((await mainBarcode.boundingBox())?.height).toBe(durableBarcodeHeight);
  expect((await footerBarcode.boundingBox())?.height).toBe(durableFooterBarcodeHeight);
  await expect(page.locator('[data-term-occurrences]')).toHaveCount(1);
  await expect(page.locator('[data-term-occurrence-label]')).toHaveText('holmes');
  await page.getByRole('button', { name: 'Separate rows, equal width', exact: true }).click();
  const byBookChart = page.locator('svg[data-trend-view="by-book"]');
  await expect(byBookChart).toBeVisible();
  await expect(byBookChart.locator('[data-series-ghost="true"]')).not.toHaveCount(0);
  await expect(byBookChart).toHaveAttribute('aria-label', /Find holmes, with .*de-emphasized context/i);
  const byBookHover = await byBookChart.locator('rect title').first().textContent();
  expect(byBookHover?.split('\n').slice(1)).toEqual([expect.stringMatching(/^holmes:/)]);
  await page.getByRole('button', { name: 'Combined sequence', exact: true }).click();
  await expect(seriesChart).toBeVisible();
  const expectFindDraftSelected = async () => {
    await expect(input).toBeFocused();
    const selection = await input.evaluate((element) => ({
      start: (element as HTMLInputElement).selectionStart,
      end: (element as HTMLInputElement).selectionEnd,
      length: (element as HTMLInputElement).value.length,
    }));
    expect(selection).toEqual({ start: 0, end: selection.length, length: selection.length });
  };
  await footer.press('Meta+f');
  await expectFindDraftSelected();
  await input.evaluate((element) => {
    const field = element as HTMLInputElement;
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await footer.press('Control+f');
  await expectFindDraftSelected();
  await page.getByRole('link', { name: 'Matches', exact: true }).click();
  await expect(page.locator('[data-series-label="holmes"]').first()).toBeVisible();
  await expect(page.locator('[data-series-label^="find-series:"]')).toHaveCount(0);
  await page.getByRole('link', { name: 'Trends', exact: true }).click();

  const first = await status.textContent();
  await input.press('Meta+g');
  await expect.poll(async () => {
    const text = await status.textContent();
    return text?.includes('Searching') ? first : text;
  }).not.toBe(first);
  await expect.poll(() => progressValue.textContent()).not.toBe(firstProgress);
  const second = await status.textContent();
  await input.press('Control+Shift+G');
  await expect.poll(async () => {
    const text = await status.textContent();
    return text?.includes('Searching') ? second : text;
  }).toBe(first);
  await expect.poll(() => progressValue.textContent()).toBe(firstProgress);

  await find.getByRole('button', { name: 'Clear and close find' }).click();
  await expect(find).toHaveCount(0);
  await expect(terms).toBeVisible();
  await expect.poll(async () => page.locator('[data-series-path]').evaluateAll((paths) =>
    [...new Set(paths.map((path) => path.getAttribute('data-series-path')).filter(Boolean))].sort(),
  )).toEqual(durableSeries);
  await expect(page.locator('[data-series-path^="find-series:"]')).toHaveCount(0);
  await expect(page.locator('[data-series-ghost]')).toHaveCount(0);
  await expect(page.locator('[data-footer-series-ghost]')).toHaveCount(0);
  await expect(footer).toBeFocused();

  await footer.press('Control+f');
  await expect(input).toBeFocused();
  await input.fill('wo*lf');
  await input.press('Enter');
  await expect(find.locator('#corpus-find-error')).toContainText('start or end');
  await input.press('x');
  await expect(find.locator('#corpus-find-error')).toBeEmpty();
  await input.fill('');
  await input.pressSequentially('gi');
  await expect(input).toHaveValue('gi');
  await expect(page.getByRole('region', { name: 'Trends', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await footer.press('Enter');
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  const readerPosition = reader.locator('.reader-position');
  const readerBefore = await readerPosition.textContent();
  await reader.press('/');
  await expect(input).toBeFocused();
  await input.fill('moriarty');
  await input.press('Enter');
  await expect(status).not.toContainText('Searching');
  await expect(find.locator('.dock-takeover-status')).toBeVisible();
  await expect(reader).toBeVisible();
  await expect(reader.getByLabel('Reader query highlights')).toHaveCount(0);
  await expect(reader.locator('[data-reader-mark]').filter({ hasText: 'moriarty' }).first())
    .toBeVisible();
  await expect(reader.getByText('query changed', { exact: false })).toHaveCount(0);
  for (const name of [
    'Save Find as term',
    'Previous match',
    'Next match',
    'Clear and close find',
  ]) {
    const box = await find.getByRole('button', { name }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  const resultBox = await find.getByRole('button', {
    name: /Open current Find result in Reader:/,
  }).boundingBox();
  expect(resultBox?.height).toBeGreaterThanOrEqual(44);
  if (testInfo.project.name === 'webkit-compact') {
    await simulateKeyboard(page, 280);
    const [box, viewport] = await Promise.all([
      find.boundingBox(),
      page.evaluate(() => ({ height: innerHeight, inset: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset'),
      ) })),
    ]);
    expect(box ? box.y + box.height : Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(viewport.height - viewport.inset);
    await simulateKeyboard(page, 0);
  }
  const nextFindMatch = reader.getByRole('button', { name: 'next find match', exact: true });
  await expect(nextFindMatch).toBeEnabled();
  await expect(nextFindMatch).toHaveAttribute('title', 'Next exact Find match');
  await expect.poll(() => readerPosition.textContent()).not.toBe(readerBefore);
  await page.keyboard.press('Escape');
  await expect(find).toHaveCount(0);
  await expect(reader).toBeVisible();

  await reader.press('/');
  await expect(input).toBeFocused();
  await reader.press('Escape');
  await expect(find).toHaveCount(0);
  await expect(reader).toBeVisible();
});

test('Find saves its submitted aliases as one active term and disables Save at capacity', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'trends' });

  const footer = page.getByRole('slider', { name: 'Corpus footer position' });
  await footer.focus();
  await footer.press('Control+f');

  const find = page.getByRole('search', { name: 'Find in corpus' });
  const input = find.getByRole('searchbox', { name: 'Find term or aliases' });
  const save = find.getByRole('button', { name: 'Save Find as term' });
  await expect(save).toHaveCount(0);
  await input.fill('Baker Street, 221B');
  await input.press('Enter');
  await expect(save).toBeEnabled();
  await save.click();
  const saved = find.getByRole('button', { name: 'Saved Find as term' });
  await expect(saved).toHaveText('Saved');
  await expect(saved).toBeDisabled();
  await expect(saved).toHaveAttribute('title', 'Baker Street saved to Terms');
  await expect(find.locator('#corpus-find-status')).toContainText('Saved Baker Street');
  await find.getByRole('button', { name: 'Clear and close find' }).click();

  const terms = page.getByRole('complementary', { name: 'Terms' });
  await expect(terms.getByRole('button', { name: 'Baker Street, shown in analysis' }))
    .toBeVisible();

  await terms.getByRole('button', { name: 'Add term', exact: true }).click();
  await terms.getByRole('button', { name: 'More options', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Manage terms' });
  await manager.getByRole('textbox', { name: 'Term and aliases for new term' })
    .fill('capacity marker');
  await manager.getByRole('button', { name: 'Add term', exact: true }).click();
  await expect(manager.getByRole('button', { name: 'Edit term: capacity marker' })).toBeVisible();
  await manager.getByRole('button', { name: 'Done', exact: true }).click();

  await footer.focus();
  await footer.press('Control+f');
  await input.fill('final capacity probe');
  await input.press('Enter');
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute('title', /Deactivate a term before saving this Find/);
});

test('store-driven Find teardown restores focus instead of orphaning it', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'inputs' });

  const inputsRegion = page.getByRole('region', { name: 'Inputs', exact: true });
  await inputsRegion.focus();
  await inputsRegion.press('/');

  const find = page.getByRole('search', { name: 'Find in corpus' });
  await expect(find.getByRole('searchbox', { name: 'Find term or aliases' })).toBeFocused();
  await page.getByLabel('Add files').setInputFiles({
    name: 'focus-fence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('A small snapshot replacement for focus restoration.', 'utf-8'),
  });

  await awaitReadyCount(page, DOC_COUNT + 1);
  await expect(find).toHaveCount(0);
  await expect(inputsRegion).toBeFocused();
});

test('Reader Help exposes a touch-sized Find entry in the keyboard-safe rail', async ({ page }, testInfo) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'trends' });

  await gotoPlace(page, 'trends');
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('ArrowRight');
  await scrubber.press('Enter');
  const reader = page.getByRole('main', { name: /Reader:/ });
  await reader.getByRole('button', { name: 'help', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Help' });
  await expect(dialog.getByRole('heading', { name: 'Quick actions', exact: true })).toBeVisible();
  const tool = dialog.getByRole('button', { name: /Find in corpus/ });
  if (testInfo.project.name === 'webkit-compact') {
    const box = await tool.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await tool.click();

  const find = page.getByRole('search', { name: 'Find in corpus' });
  const input = find.getByRole('searchbox', { name: 'Find term or aliases' });
  await expect(dialog).toHaveCount(0);
  await expect(input).toBeFocused();
  const glyphs = find.locator('.find-bar-action-glyph');
  await expect(glyphs).toHaveText(['×']);
  const glyphMetrics = await glyphs.evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node);
    return `${style.inlineSize}/${style.blockSize}/${style.fontSize}/${style.lineHeight}`;
  }));
  expect(new Set(glyphMetrics).size).toBe(1);

  for (const name of ['Submit find', 'Clear and close find']) {
    const box = await find.getByRole('button', { name }).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await input.fill('holmes');
  await input.press('Enter');
  await expect(find.getByRole('button', { name: 'Next match' })).toBeFocused();
  await expect(glyphs).toHaveText(['←', '→', '×']);
  for (const name of [
    'Save Find as term',
    'Previous match',
    'Next match',
    'Clear and close find',
  ]) {
    const box = await find.getByRole('button', { name }).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  if (testInfo.project.name === 'webkit-compact') {
    await simulateKeyboard(page, 280);
    const [box, viewport] = await Promise.all([
      find.boundingBox(),
      page.evaluate(() => ({ height: innerHeight, inset: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset'),
      ) })),
    ]);
    expect(box ? box.y + box.height : Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(viewport.height - viewport.inset);
  }
});
