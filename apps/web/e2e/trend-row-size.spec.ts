import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';

const ROW_PITCH_KEY = 'texttrends/trend-rows/2';
const LEGACY_ROW_PITCH_KEY = 'texttrends/trend-rows/1';

test('separate trend rows resize, hide only painted titles, and persist', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(({ key, legacy }) => {
    localStorage.removeItem(key);
    localStorage.removeItem(legacy);
  }, { key: ROW_PITCH_KEY, legacy: LEGACY_ROW_PITCH_KEY });
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
  const barcode = scrubber.locator('canvas[data-barcode-band="by-book"]');
  const barcodeHeight = (await barcode.first().boundingBox())!.height;

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
  expect((await barcode.first().boundingBox())!.height).toBe(barcodeHeight);

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2 + 10,
  );
  await expect(handle).toHaveAttribute('aria-valuenow', String(defaultPitch + 30));
  await handle.press('Escape');
  await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', String(defaultPitch + 20));
  expect((await trace(page)).events.filter((event) =>
    event.seq > beforeQueries && event.direction === 'to-worker' && event.t === 'query'))
    .toHaveLength(0);

  await handle.focus();
  await handle.press('Home');
  await expect(handle).toHaveAttribute('aria-valuenow', '14');
  await expect(handle).toHaveAttribute('aria-valuetext', /occurrence rows hidden · smallest row/);
  await expect(handle).toHaveAttribute('data-row-phase', 'drop');
  await expect(handle).toHaveAttribute('data-barcode-visible', 'false');
  await expect(handle).toHaveAttribute('aria-describedby', 'trend-hidden-barcode-note');
  await expect(chart.locator('[data-trend-row-title]')).toHaveCount(0);
  await expect(barcode).toHaveCount(0);
  expect((await chart.boundingBox())!.height).toBe(rowCount * 14 + 4);
  expect(Number(await chart.locator('[data-trend-hit-row="0"]').first()
    .getAttribute('height'))).toBe(12);
  await expect(titleControls.getByRole('button')).toHaveCount(rowCount);
  await expect(titleControls.locator('[data-title-painted="false"]')).toHaveCount(rowCount);
  await expect(titleControls.getByRole('button').first()).toHaveCSS('pointer-events', 'none');
  expect((await trace(page)).events.filter((event) =>
    event.seq > beforeQueries && event.direction === 'to-worker' && event.t === 'query'))
    .toHaveLength(0);

  const nextOccurrence = page.getByRole('list', { name: 'Term totals' })
    .getByRole('button', { name: /^Next .* (reference|bucket)$/ }).first();
  const beforeOccurrence = await scrubber.getAttribute('aria-valuenow');
  await nextOccurrence.click();
  await expect.poll(() => scrubber.getAttribute('aria-valuenow')).not.toBe(beforeOccurrence);
  const beforeMiniatureResize = (await trace(page)).events.at(-1)?.seq ?? -1;

  await handle.focus();
  await handle.press('ArrowDown');
  const miniaturePitch = Number(await handle.getAttribute('aria-valuenow'));
  expect(miniaturePitch).toBeGreaterThan(14);
  await expect(handle).toHaveAttribute('aria-valuetext', /occurrence rows minimized/);
  await expect(handle).toHaveAttribute('data-row-phase', 'ink');
  await expect(handle).toHaveAttribute('data-barcode-visible', 'true');
  await expect(handle).toHaveAttribute('data-barcode-interactive', 'false');
  await expect(handle).toHaveAttribute('aria-describedby', 'trend-mini-barcode-note');
  await expect(barcode).toHaveCount(rowCount);
  await expect(barcode.first()).toHaveAttribute('data-pointer-contract', 'scrub-only');
  await expect(barcode.first()).toHaveCSS('pointer-events', 'none');
  expect(Number(await chart.locator('[data-trend-hit-row="0"]').first()
    .getAttribute('height'))).toBe(12);
  await handle.press('ArrowUp');
  await expect(handle).toHaveAttribute('aria-valuenow', '14');
  await expect(barcode).toHaveCount(0);
  expect((await trace(page)).events.filter((event) =>
    event.seq > beforeMiniatureResize
      && event.direction === 'to-worker'
      && event.t === 'query'))
    .toHaveLength(0);

  await page.getByRole('button', { name: 'Find', exact: true }).click();
  const find = page.getByRole('search', { name: 'Find in corpus' });
  await find.getByRole('searchbox', { name: 'Find term or aliases' }).fill('holmes');
  await find.getByRole('button', { name: 'Submit find' }).click();
  await expect(page.locator('[data-series-path^="find-series:"]').first()).toBeVisible();
  await expect(handle).toHaveAttribute('aria-valuenow', String(miniaturePitch));
  await expect(handle).toHaveAttribute('data-barcode-visible', 'true');
  await expect(handle).toHaveAttribute('data-barcode-interactive', 'true');
  await expect(scrubber.locator('[data-barcode-foreground-overlay="true"]')).toHaveCount(rowCount);
  await find.getByRole('button', { name: 'Clear and close find' }).click();
  await expect(handle).toHaveAttribute('aria-valuenow', '14');
  await expect(barcode).toHaveCount(0);

  const storedFloor = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), ROW_PITCH_KEY) as {
    pitch: number; tracks: number; width: string; coarse: boolean;
  } | null;
  expect(storedFloor).toMatchObject({ pitch: 14, coarse: false });
  expect(storedFloor?.tracks).toBeGreaterThan(0);

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
  const scaledHandle = page.getByRole('separator', { name: 'Resize trend rows' });
  const scaledChart = page.locator('svg[data-trend-view="by-book-scaled"]');
  await expect(scaledHandle).toBeVisible();
  await scaledHandle.focus();
  await scaledHandle.press('Home');
  await expect(scaledHandle).toHaveAttribute('aria-valuenow', '14');
  await expect(scrubber.locator('canvas[data-barcode-band="by-book-scaled"]')).toHaveCount(0);
  expect(Number(await scaledChart.locator('[data-trend-hit-row="0"]').first()
    .getAttribute('height'))).toBe(12);
  await scaledHandle.press('Enter');
  await expect(scaledHandle).not.toHaveAttribute('aria-valuenow', '14');

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
