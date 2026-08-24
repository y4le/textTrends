import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, DOC_COUNT, simulateKeyboard } from './helpers.ts';

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
  await expect(find.locator('.term-bar-label')).toHaveText('Find');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('autocomplete', 'off');
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
  const statusInsets = await status.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.insetInlineStart, style.insetInlineEnd];
  });
  expect(statusInsets[0]).toBe(statusInsets[1]);
  const progress = status.locator('[data-find-match-progress]');
  await expect(progress).toHaveText(/^\d[\d,]*\/\d[\d,]*$/);
  await expect(progress).toHaveAccessibleName(/^Find match [\d,]+ of [\d,]+$/);
  const firstProgress = await progress.textContent();
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
  await expect.poll(() => progress.textContent()).not.toBe(firstProgress);
  const second = await status.textContent();
  await input.press('Control+Shift+G');
  await expect.poll(async () => {
    const text = await status.textContent();
    return text?.includes('Searching') ? second : text;
  }).toBe(first);
  await expect.poll(() => progress.textContent()).toBe(firstProgress);

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
  await expect(status).toBeVisible();
  await expect(reader).toBeVisible();
  await expect(reader.getByLabel('Reader query highlights')).toHaveCount(0);
  await expect(reader.locator('[data-reader-mark]').filter({ hasText: 'moriarty' }).first())
    .toBeVisible();
  await expect(reader.getByText('query changed', { exact: false })).toHaveCount(0);
  if (testInfo.project.name === 'webkit-compact') {
    for (const name of [
      'Submit find',
      'Save Find as term',
      'Previous match',
      'Next match',
      'Clear and close find',
    ]) {
      const box = await find.getByRole('button', { name }).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
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
  await expect(save).toBeDisabled();
  await input.fill('Baker Street, 221B');
  await input.press('Enter');
  await expect(save).toBeEnabled();
  await save.click();
  await find.getByRole('button', { name: 'Clear and close find' }).click();

  const terms = page.getByRole('complementary', { name: 'Terms' });
  await expect(terms.getByRole('button', { name: 'Baker Street, shown in analysis' }))
    .toBeVisible();

  await terms.getByRole('button', { name: 'Add term', exact: true }).click();
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

test('Shortcuts exposes a touch-sized Find entry in the keyboard-safe rail', async ({ page }, testInfo) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'trends' });

  await page.getByRole('button', { name: 'shortcuts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog.getByRole('heading', { name: 'Tools', exact: true })).toBeVisible();
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
  await expect(glyphs).toHaveText(['←', '→', '×']);
  const glyphMetrics = await glyphs.evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node);
    return `${style.inlineSize}/${style.blockSize}/${style.fontSize}/${style.lineHeight}`;
  }));
  expect(new Set(glyphMetrics).size).toBe(1);

  if (testInfo.project.name === 'webkit-compact') {
    for (const name of [
      'Submit find',
      'Save Find as term',
      'Previous match',
      'Next match',
      'Clear and close find',
    ]) {
      const box = await find.getByRole('button', { name }).boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
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
