import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';

const ROW_PITCH_KEY = 'texttrends/trend-rows/1';

test('separate trend rows resize, hide only painted titles, and persist', async ({ page }) => {
  await page.goto('./');
  await page.evaluate((key) => { localStorage.removeItem(key); }, ROW_PITCH_KEY);
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'trends');
  await page.getByRole('button', { name: 'Separate rows, equal width', exact: true }).click();

  const handle = page.getByRole('separator', { name: 'Resize trend rows' });
  const chart = page.locator('svg[data-trend-view="by-book"]');
  const scrubber = page.getByRole('slider', { name: 'Reading position scrubber' });
  const titleControls = page.getByRole('group', { name: 'Select whole texts' });
  const rowCount = await chart.locator('[data-trend-row-axis]').count();
  const defaultPitch = Number(await handle.getAttribute('aria-valuenow'));
  const defaultChartHeight = (await chart.boundingBox())!.height;
  const barcodeHeight = (await scrubber.locator('canvas').first().boundingBox())!.height;

  await expect(handle).toHaveAttribute('aria-keyshortcuts', /ArrowUp.*PageDown.*Enter/);
  await expect(chart.locator('[data-trend-row-title]')).toHaveCount(rowCount);

  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error('trend row resize handle has no layout box');
  const beforeQueries = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2 + 20,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', String(defaultPitch + 20));
  expect((await chart.boundingBox())!.height).toBe(defaultChartHeight + rowCount * 20);
  expect((await scrubber.locator('canvas').first().boundingBox())!.height).toBe(barcodeHeight);
  expect((await trace(page)).events.filter((event) =>
    event.seq > beforeQueries && event.direction === 'to-worker' && event.t === 'query'))
    .toHaveLength(0);

  await handle.focus();
  await handle.press('Home');
  await expect(handle).toHaveAttribute('aria-valuetext', /titles hidden/);
  await expect(chart.locator('[data-trend-row-title]')).toHaveCount(0);
  await expect(titleControls.getByRole('button')).toHaveCount(rowCount);
  await expect(titleControls.locator('[data-title-painted="false"]')).toHaveCount(rowCount);
  await expect(titleControls.getByRole('button').first()).toHaveCSS('pointer-events', 'none');
  expect((await scrubber.locator('canvas').first().boundingBox())!.height).toBe(barcodeHeight);

  const firstTitle = titleControls.getByRole('button').first();
  await firstTitle.focus();
  await firstTitle.press('Enter');
  await expect(page.getByRole('region', { name: 'Corpus status' })
    .getByRole('button', { name: /Scope: A Study in Scarlet · tokens/i })).toBeVisible();

  await handle.focus();
  await handle.press('Enter');
  await expect(handle).toHaveAttribute('aria-valuenow', String(defaultPitch));
  await expect(chart.locator('[data-trend-row-title]')).toHaveCount(rowCount);
  await handle.press('PageUp');
  const persistedPitch = Number(await handle.getAttribute('aria-valuenow'));
  expect(persistedPitch).toBe(defaultPitch - 32);
  await page.reload();
  await awaitAllReady(page);
  await expect(page.getByRole('separator', { name: 'Resize trend rows' }))
    .toHaveAttribute('aria-valuenow', String(persistedPitch));

  const restoredHandle = page.getByRole('separator', { name: 'Resize trend rows' });
  await restoredHandle.focus();
  await restoredHandle.press('Enter');
  await page.reload();
  await awaitAllReady(page);
  await expect(page.getByRole('separator', { name: 'Resize trend rows' }))
    .toHaveAttribute('aria-valuenow', String(defaultPitch));

  await page.getByRole('button', { name: 'Combined sequence', exact: true }).click();
  await expect(page.getByRole('separator', { name: 'Resize trend rows' })).toHaveCount(0);
  await page.getByRole('button', {
    name: 'To scale — separate rows, same token scale', exact: true,
  }).click();
  await expect(page.getByRole('separator', { name: 'Resize trend rows' })).toBeVisible();

  await page.evaluate(() => { window.scrollTo(0, 500); });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const [headerAfterScroll, handleAfterScroll] = await Promise.all([
    page.locator('.app-header').boundingBox(),
    page.getByRole('separator', { name: 'Resize trend rows' }).boundingBox(),
  ]);
  expect(headerAfterScroll && handleAfterScroll
    ? Math.abs(handleAfterScroll.y - (headerAfterScroll.y + headerAfterScroll.height))
    : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
});
