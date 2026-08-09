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

  for (const place of ['concordance', 'vocabulary', 'compare', 'corpus'] as const) {
    await gotoPlace(page, place);
    await expect(footer).toBeVisible();
  }

  await page.getByRole('button', { name: /Open reader at .* token/ }).click();
  await expect(page.getByRole('main', { name: /Reader:/ })).toBeVisible();
  await expect(footer).toHaveCount(0);
  await page.getByRole('button', { name: 'back' }).click();
  await expect(footer).toBeVisible();
});

test('an exact footer barcode tick centers Concordance without opening Reader', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');
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

test('double-clicking the footer sparkline opens Reader at that corpus point', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'footer-reader.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('the wolf ran. a fox saw the wolf sleep.\n', 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const sparkline = footer.locator('.footer-sparkline');
  await expect(sparkline).toBeVisible();
  const sliderBox = await slider.boundingBox();
  const sparklineBox = await sparkline.boundingBox();
  if (!sliderBox || !sparklineBox) throw new Error('footer sparkline has no layout box');

  await slider.dblclick({
    position: {
      x: sliderBox.width * (5.5 / 9),
      y: sparklineBox.y - sliderBox.y + sparklineBox.height / 2,
    },
  });

  const reader = page.getByRole('main', { name: /Reader: footer-reader/ });
  await expect(reader).toBeVisible();
  await expect(reader.getByText('saw', { exact: true })).toHaveCSS('font-weight', '600');
  await reader.getByRole('button', { name: 'back' }).click();
  await expect(slider).toBeFocused();
});
