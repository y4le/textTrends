import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace } from './helpers.ts';

const userSelect = (element: Element): string => {
  const style = getComputedStyle(element);
  return style.getPropertyValue('user-select')
    || style.getPropertyValue('-webkit-user-select');
};

test('the footer graph double-press clears or brushes without stealing shuttle and Reader gestures', async ({
  page,
}) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'trends');

  const chart = page.getByRole('slider', { name: 'Reading position scrubber' });
  expect(await chart.evaluate(userSelect)).toBe('none');
  expect(await page.getByRole('region', { name: 'Trends', exact: true }).evaluate(userSelect))
    .toBe('none');
  await chart.focus();
  await chart.press('Home');
  await chart.press('s');
  await chart.press('ArrowRight');
  await chart.press('Enter');
  await expect(page.getByTestId('linked-selection')).toBeVisible();

  // The Trends graph and footer graph share the clear gesture. Use the chart's
  // interior rather than its top edge, which can sit beneath the sticky row
  // resize handle after Playwright scrolls the slider into view.
  const initialChartBox = await chart.boundingBox();
  if (!initialChartBox) throw new Error('Trends graph geometry is unavailable');
  const chartGestureY = Math.min(initialChartBox.height - 8, 32);
  await chart.dblclick({ position: { x: 100, y: chartGestureY } });
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(chart.locator('..').getByRole('status')).toHaveText('Range cleared.');
  await chart.press('s');
  await chart.press('ArrowRight');
  await chart.press('Enter');
  await expect(page.getByTestId('linked-selection')).toBeVisible();

  // A drag commit suppresses its trailing native double-click so the newly
  // authored range cannot immediately erase itself.
  await page.waitForTimeout(600);
  const chartBox = await chart.boundingBox();
  if (!chartBox) throw new Error('Trends graph geometry is unavailable');
  const chartDragY = chartBox.y + Math.min(chartBox.height - 8, 32);
  const chartDragStart = chartBox.x + chartBox.width * 0.2;
  const chartDragEnd = chartDragStart + 12;
  await page.mouse.move(chartDragStart, chartDragY);
  await page.mouse.down();
  await page.mouse.move(chartDragEnd, chartDragY, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('linked-selection')).toBeVisible();
  await chart.dispatchEvent('dblclick', {
    clientX: chartDragEnd,
    clientY: chartDragY,
    detail: 2,
  });
  await expect(page.getByTestId('linked-selection')).toBeVisible();

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const statusBox = await footer.locator('.footer-reading-status').boundingBox();
  if (!statusBox) throw new Error('footer status geometry is unavailable');
  await page.mouse.dblclick(
    statusBox.x + statusBox.width / 2,
    statusBox.y + statusBox.height / 2,
  );
  let reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: 'Return to workbench', exact: true }).click();
  await expect(page.getByTestId('linked-selection')).toBeVisible();

  const barcode = footer.locator('canvas[data-barcode-band="series"]').first();
  const barcodeBox = await barcode.boundingBox();
  if (!barcodeBox) throw new Error('footer barcode geometry is unavailable');
  await barcode.dblclick({ position: { x: barcodeBox.width / 2, y: 3 } });
  reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: 'Return to workbench', exact: true }).click();
  await expect(page.getByTestId('linked-selection')).toBeVisible();

  const [sliderBox, sparklineBox] = await Promise.all([
    slider.boundingBox(),
    footer.locator('.footer-sparkline').boundingBox(),
  ]);
  if (!sliderBox || !sparklineBox) throw new Error('footer graph geometry is unavailable');
  const graphY = sparklineBox.y + sparklineBox.height / 2;
  const x = (fraction: number) => sliderBox.x + sliderBox.width * fraction;

  await page.mouse.dblclick(x(0.5), graphY);
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);
  await expect(footer.getByRole('status')).toContainText('Range cleared.');
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

  // Hold and drag the second press: the prior range clears on pointerdown,
  // then the footer previews and commits a new exact linked selection.
  await page.waitForTimeout(600);
  await page.mouse.click(x(0.25), graphY, { clickCount: 1 });
  await page.mouse.move(x(0.25), graphY);
  await page.mouse.down();
  await page.mouse.move(x(0.65), graphY, { steps: 8 });
  await expect(page.getByTestId('footer-selection-preview')).toBeVisible();
  await expect(slider).toHaveAttribute('data-range-brushing', 'true');
  await expect(slider).not.toHaveAttribute('data-shuttling', 'true');
  await page.mouse.up();
  await expect(page.getByTestId('footer-selection-preview')).toHaveCount(0);
  await expect(page.getByTestId('linked-selection')).toBeVisible();
  await expect(footer.locator('.footer-range')).toBeVisible();
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);

  // A third constituent click cannot erase the range just drawn.
  await page.mouse.click(x(0.65), graphY, { clickCount: 3 });
  await expect(page.getByTestId('linked-selection')).toBeVisible();

  // The barcode keeps stationary double-click → Reader, but takes ownership
  // once its second press moves far enough to become a range brush.
  await page.waitForTimeout(600);
  const barcodeY = barcodeBox.y + 3;
  const barcodeX = (fraction: number) => barcodeBox.x + barcodeBox.width * fraction;
  await page.mouse.click(barcodeX(0.25), barcodeY, { clickCount: 1 });
  await page.mouse.move(barcodeX(0.25), barcodeY);
  await page.mouse.down();
  await page.mouse.move(barcodeX(0.65), barcodeY, { steps: 8 });
  await expect(page.getByTestId('footer-selection-preview')).toBeVisible();
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(slider).toHaveAttribute('data-range-brushing', 'true');
  await expect(slider).not.toHaveAttribute('data-shuttling', 'true');
  await page.mouse.up();
  await expect(page.getByTestId('footer-selection-preview')).toHaveCount(0);
  await expect(page.getByTestId('linked-selection')).toBeVisible();
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);

  // Keyboard users get the same footer-owned range and clear operations.
  await slider.focus();
  await slider.press('s');
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', /selection head token/i);
  await slider.press('Enter');
  await expect(page.getByTestId('linked-selection')).toBeVisible();
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);
  await slider.press('Escape');
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);

  // A plain first-press drag remains the reading shuttle and creates no range.
  await page.waitForTimeout(600);
  await page.mouse.move(x(0.2), graphY);
  await page.mouse.down();
  await page.mouse.move(x(0.7), graphY, { steps: 4 });
  await expect(slider).toHaveAttribute('data-shuttling', 'true');
  await expect(page.getByTestId('footer-selection-preview')).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);

  // Selection remains opt-in: app interaction surfaces suppress browser text
  // highlights while corpus statistics and readable source stay copyable.
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
