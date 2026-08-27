import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace } from './helpers.ts';

const userSelect = (element: Element): string => {
  const style = getComputedStyle(element);
  return style.getPropertyValue('user-select')
    || style.getPropertyValue('-webkit-user-select');
};

test('double-click clears the linked range without selecting chart text', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'trends');

  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await expect(scrubber).toBeVisible();
  await expect(page.locator('[data-trend-organ="overview"]')).toBeVisible();
  expect(await scrubber.evaluate(userSelect)).toBe('none');
  expect(await page.getByRole('region', { name: 'Trends', exact: true }).evaluate(userSelect)).toBe('none');

  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  await scrubber.press('ArrowRight');
  await scrubber.press('Enter');
  await expect(page.getByTestId('linked-selection')).toBeVisible();
  await expect(page.locator('[data-trend-organ="range"]')).toBeVisible();
  const holmes = page.locator('.trend-range-table tbody tr').filter({ hasText: 'Holmes' });
  await expect(holmes.locator('.trend-range-rate').first()).toHaveText('0');
  const direction = holmes.getByRole('img', { name: /absent in range.*direction toward rest/i });
  await expect(direction).toBeVisible();
  await expect(direction).toHaveAttribute('data-direction-side', 'rest');

  const barcode = scrubber.locator('canvas[data-barcode-band]').first();
  const barcodeBox = await barcode.boundingBox();
  expect(barcodeBox).not.toBeNull();
  await barcode.dispatchEvent('dblclick', {
    clientX: barcodeBox!.x + barcodeBox!.width / 2,
    clientY: barcodeBox!.y + barcodeBox!.height / 2,
  });
  await expect(page.getByTestId('linked-selection')).toBeVisible();

  const chartLabel = scrubber.locator('svg[data-trend-view] text').first();
  const labelBox = await chartLabel.boundingBox();
  expect(labelBox).not.toBeNull();
  expect(labelBox!.y).toBeGreaterThan(barcodeBox!.y + barcodeBox!.height);
  await chartLabel.dispatchEvent('dblclick', {
    clientX: labelBox!.x + labelBox!.width / 2,
    clientY: labelBox!.y + labelBox!.height / 2,
  });
  await expect(page.getByTestId('linked-selection')).toBeVisible();

  const box = (await scrubber.boundingBox())!;
  const graphY = box.y + 8;
  await scrubber.dblclick({ position: { x: box.width / 2, y: 8 } });

  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'clear selection' })).toHaveCount(0);
  await expect(page.locator('[data-trend-organ="overview"]')).toBeVisible();
  const rangeStatus = scrubber.locator('..').getByRole('status');
  await expect(rangeStatus).toHaveText('Range cleared.');
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

  // A new drag can start immediately after the clear. The native dblclick a
  // real browser may synthesize from its click pair must not wipe that range.
  const startX = box.x + box.width * 0.3;
  const endX = box.x + box.width * 0.5;
  await page.mouse.move(startX, graphY);
  await page.mouse.down();
  await page.mouse.move(endX, graphY, { steps: 6 });
  await expect(page.getByTestId('selection-preview')).toBeVisible();
  await page.mouse.up();
  await scrubber.dispatchEvent('dblclick', {
    clientX: box.x + box.width / 2,
    clientY: graphY,
  });
  await expect(page.getByTestId('linked-selection')).toBeVisible();

  // Once the post-drag window expires, the same graph gesture clears again.
  await page.waitForTimeout(600);
  await scrubber.dispatchEvent('dblclick', {
    clientX: box.x + box.width / 2,
    clientY: graphY,
  });
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(rangeStatus).toHaveText('Range cleared.');

  // An accepted graph double-click also cancels an uncommitted keyboard range
  // without claiming that a committed selection was cleared.
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  await scrubber.press('ArrowRight');
  await scrubber.dispatchEvent('dblclick', {
    clientX: box.x + box.width / 2,
    clientY: graphY,
  });
  await expect(page.getByTestId('selection-preview')).toHaveCount(0);
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(rangeStatus).toHaveText('Range selection cancelled.');

  await gotoPlace(page, 'inputs');
  const stat = page.locator('.selectable-stat').first();
  await expect(stat).toBeVisible();
  expect(await stat.evaluate(userSelect)).toBe('text');

  await gotoPlace(page, 'matches');
  const sourceText = page.getByRole('grid', { name: 'Matches' }).locator('.source-text').first();
  await expect(sourceText).toBeVisible();
  expect(await sourceText.evaluate(userSelect)).toBe('text');
  const readableContext = page.getByRole('grid', { name: 'Matches' })
    .locator('.kwic-right-context')
    .filter({ hasText: /\S/ })
    .first();
  const readableText = readableContext.locator(':scope > span > span')
    .filter({ hasText: /\S/ })
    .first();
  expect(await readableText.evaluate(userSelect)).toBe('text');
  await readableText.selectText();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim() ?? ''))
    .not.toBe('');
});
