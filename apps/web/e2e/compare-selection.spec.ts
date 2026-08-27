import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  clearDemoInputs,
  gotoPlace,
} from './helpers.ts';

const ONE_TEXT = [
  ...Array.from({ length: 12 }, () => 'inside'),
  ...Array.from({ length: 40 }, () => 'outside'),
].join(' ');

test('one text compares a selected range with its corpus complement', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'one.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(ONE_TEXT),
  });
  await awaitReadyCount(page, 1);

  await gotoPlace(page, 'compare');
  await expect(page.getByText('No range selected.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Left comparison input')).toHaveValue('__selection__');
  await expect(page.getByLabel('Left comparison input')).toBeDisabled();
  await expect(page.getByLabel('Right comparison input')).toHaveValue('__outside__');
  await expect(page.getByLabel('Right comparison input')).toBeDisabled();

  await page.getByRole('button', { name: 'Select a range in Trends' }).click();
  const scrubber = page.getByRole('slider', { name: 'Reading position scrubber' });
  await expect(scrubber).toBeFocused();
  await scrubber.press('Home');
  await scrubber.press('s');
  for (let index = 0; index < 8; index++) await scrubber.press('ArrowRight');
  await scrubber.press('Enter');
  await expect(page.getByTestId('linked-selection')).toBeVisible();

  await gotoPlace(page, 'compare');
  await expect(page.getByLabel('Left comparison input')).toHaveValue('__selection__');
  await expect(page.getByLabel('Right comparison input')).toHaveValue('__outside__');
  const pyramid = page.getByRole('table', { name: 'Compare population pyramid' });
  await expect(pyramid).toBeVisible({ timeout: 30_000 });
  await expect(pyramid.getByRole('button', { name: /^inside,/ })).toBeVisible();
  await expect(pyramid.getByRole('button', { name: /^outside,/ })).toBeVisible();

  await gotoPlace(page, 'trends');
  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const sparkline = footer.locator('.footer-sparkline');
  const box = await sparkline.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);

  await gotoPlace(page, 'compare');
  await expect(page.getByText('No range selected.', { exact: true })).toBeVisible();
  await expect(pyramid).toHaveCount(0);
});
