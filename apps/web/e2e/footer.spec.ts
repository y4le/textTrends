import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  DOC_COUNT,
  gotoPlace,
  submitAndAwaitFreshResults,
  trace,
} from './helpers.ts';

test('the workbench footer shares one corpus axis and opens the current passage', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  await expect(footer).toBeVisible();
  await expect(slider).toBeVisible();
  expect(await footer.locator('.footer-sparkline path').count()).toBeGreaterThanOrEqual(2);
  await expect(footer.locator('.footer-book-boundary')).toHaveCount(DOC_COUNT - 1);
  await expect(footer.locator('canvas[data-barcode-band="series"]')).toHaveCount(1);
  const sparklineCommits = await page.evaluate(() =>
    (window as unknown as { __ttFooterCommits?: number }).__ttFooterCommits ?? 0);
  expect(sparklineCommits).toBeGreaterThan(0);

  const box = await slider.boundingBox();
  if (!box) throw new Error('footer slider has no layout box');
  await page.mouse.move(box.x + box.width * 0.38, box.y + 5);
  await expect(slider).not.toHaveAttribute('aria-valuetext', 'no position');
  await expect(footer.locator('.footer-reading-status')).toContainText(/token .* of .*% of corpus/);
  await expect.poll(async () => Number(await footer.getByTestId('footer-progress').getAttribute('data-progress')))
    .toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: /Open reader at .* token/ })).toBeVisible({
    timeout: 15_000,
  });
  const keyboardStart = Number(await slider.getAttribute('aria-valuenow'));
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', String(keyboardStart + 1));
  expect(await page.evaluate(() =>
    (window as unknown as { __ttFooterCommits?: number }).__ttFooterCommits ?? 0))
    .toBe(sparklineCommits);

  const footerQueries = (await trace(page)).events.filter((event) =>
    event.direction === 'to-worker'
    && event.t === 'query'
    && event.op === 'reader-page');
  expect(footerQueries.length).toBeGreaterThan(0);

  for (const place of ['concordance', 'vocabulary', 'compare', 'catalog'] as const) {
    await gotoPlace(page, place);
    await expect(footer).toBeVisible();
  }

  await page.getByRole('button', { name: /Open reader at .* token/ }).click();
  await expect(page.getByRole('main', { name: /Reader:/ })).toBeVisible();
  await expect(footer).toHaveCount(0);
  await page.getByRole('button', { name: 'back' }).click();
  await expect(footer).toBeVisible();
});

test('a mouse drag shuttles through source continuously and release pauses', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);

  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const box = await slider.boundingBox();
  if (!box) throw new Error('footer slider has no layout box');
  const anchorX = box.x + box.width * 0.3;
  const y = box.y + 5;

  await page.mouse.move(anchorX, y);
  await expect(page.getByRole('button', { name: /Open reader at .* token/ })).toBeVisible({
    timeout: 15_000,
  });
  await page.mouse.down();
  await page.mouse.move(anchorX + 24, y);
  await expect(slider).toHaveAttribute('data-shuttling', 'true');
  const anchored = Number(await slider.getAttribute('aria-valuenow'));
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')), {
    timeout: 5_000,
  }).toBeGreaterThan(anchored);

  await page.mouse.up();
  await expect(slider).not.toHaveAttribute('data-shuttling', 'true');
  const paused = Number(await slider.getAttribute('aria-valuenow'));
  await page.waitForTimeout(300);
  expect(Number(await slider.getAttribute('aria-valuenow'))).toBe(paused);

  // Native click/dblclick synthesis after real drags must never open Reader.
  for (let i = 0; i < 2; i++) {
    await page.mouse.move(anchorX, y);
    await page.mouse.down();
    await page.mouse.move(anchorX + 12, y);
    await page.waitForTimeout(60);
    await page.mouse.up();
  }
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);
});

test('an exact footer barcode tick centers Concordance without opening Reader', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'catalog');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'footer-ticks.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('the wolf ran. a fox saw the wolf sleep.\n', 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const band = footer.locator('canvas[data-barcode-band="series"]');
  await expect(band).toBeVisible();
  const box = await band.boundingBox();
  if (!box) throw new Error('footer barcode has no layout box');
  await band.click({ position: { x: box.width * (1 / 9), y: 3 } });

  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);
  await gotoPlace(page, 'concordance');
  await expect(page.getByText(/nearest to .* token 2\b/)).toBeVisible({ timeout: 15_000 });
});

test('status and sparkline double-clicks open Reader at their raw corpus points', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'catalog');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'footer-reader.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('the wolf ran. a fox saw the wolf sleep.\n', 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const status = footer.locator('.footer-reading-status');
  const statusBox = await status.boundingBox();
  if (!statusBox) throw new Error('footer status has no layout box');

  await status.dblclick({
    position: { x: statusBox.width * (5.5 / 9), y: statusBox.height / 2 },
  });

  const reader = page.getByRole('main', { name: /Reader: footer-reader/ });
  await expect(reader).toBeVisible();
  await expect(reader.getByText('saw', { exact: true })).toHaveCSS('font-weight', '600');
  await reader.getByRole('button', { name: 'back' }).click();
  await expect(slider).toBeFocused();

  const sliderBox = await slider.boundingBox();
  const sparklineBox = await footer.locator('.footer-sparkline').boundingBox();
  if (!sliderBox || !sparklineBox) throw new Error('footer sparkline has no layout box');
  // This point is four pixels before wolf@1. A barcode lane would snap to
  // wolf, while the sparkline must retain the raw token 0 target (`the`).
  await slider.dblclick({
    position: {
      x: sliderBox.width * (1 / 9) - 4,
      y: sparklineBox.y - sliderBox.y + sparklineBox.height / 2,
    },
  });
  await expect(reader).toBeVisible();
  const articles = reader.locator('.source-text').getByText('the', { exact: true });
  await expect(articles).toHaveCount(1);
  await expect(articles.first()).toHaveCSS('font-weight', '600');
});

test('a footer barcode double-click snaps to a nearby exact reference before opening Reader', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'catalog');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'footer-snap.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('the wolf ran. a fox saw the wolf sleep.\n', 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const band = footer.locator('canvas[data-barcode-band="series"]');
  const box = await band.boundingBox();
  if (!box) throw new Error('footer barcode has no layout box');

  // Four pixels before wolf@1 maps to token 0 on the raw axis, but remains
  // inside the exact barcode's eight-pixel snap tolerance.
  await page.mouse.move(box.x + box.width * (1 / 9) - 4, box.y + 3);
  // The retrying assertion spans the footer's 120ms entry dwell.
  await expect(slider).toHaveAttribute('aria-valuenow', '1');
  await band.dblclick({ position: { x: box.width * (1 / 9) - 4, y: 3 } });

  const reader = page.getByRole('main', { name: /Reader: footer-snap/ });
  await expect(reader).toBeVisible();
  const wolves = reader.locator('.source-text').getByText('wolf', { exact: true });
  await expect(wolves).toHaveCount(2);
  await expect(wolves.first()).toHaveCSS('font-weight', '600');
  await expect(wolves.last()).not.toHaveCSS('font-weight', '600');
});
