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

test('a fresh text compares a footer selection without tracked terms', async ({ page }) => {
  await page.goto('./?fresh=1');
  await page.getByLabel('Add files — import and analyze').setInputFiles({
    name: 'one.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(ONE_TEXT),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await expect(page.locator('.term-bar .term-bucket')).toHaveCount(0);

  const footer = page.getByRole('slider', { name: 'Corpus footer position' });
  await footer.focus();
  await footer.press('Home');
  await footer.press('s');
  for (let index = 0; index < 8; index++) await footer.press('Shift+ArrowRight');
  await footer.press('Enter');
  await gotoPlace(page, 'compare');

  const pyramid = page.getByRole('table', { name: 'Compare population pyramid' });
  await expect(pyramid.getByRole('button', { name: /^inside,/ })).toBeVisible();
  await expect(pyramid.getByRole('button', { name: /^outside,/ })).toBeVisible();
});

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

  await scrubber.press('s');
  await expect(page.getByTestId('selection-preview')).toBeVisible();
  await scrubber.press('Escape');
  await expect(scrubber.locator('..').getByRole('status')).toHaveText(
    'Range selection cancelled.',
  );
  await expect(page.getByTestId('linked-selection')).toBeVisible();

  await scrubber.press('Escape');
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(scrubber.locator('..').getByRole('status')).toHaveText(
    'Range cleared. Measuring all 1 text.',
  );

  await scrubber.press('Home');
  await scrubber.press('s');
  for (let index = 0; index < 8; index++) await scrubber.press('ArrowRight');
  await scrubber.press('Enter');

  await gotoPlace(page, 'vocabulary');
  const vocabularyScope = page.locator('.linked-range-banner');
  await expect(vocabularyScope).toContainText('Measuring 9 tokens in one');
  await expect(vocabularyScope.getByRole('button', { name: 'Use all texts' })).toBeVisible();

  await gotoPlace(page, 'compare');
  await expect(page.locator('.linked-range-banner')).toContainText(
    'Measuring 9 tokens in one',
  );
  await expect(page.getByLabel('Left comparison input')).toHaveValue('__selection__');
  await expect(page.getByLabel('Right comparison input')).toHaveValue('__outside__');
  const pyramid = page.getByRole('table', { name: 'Compare population pyramid' });
  await expect(pyramid).toBeVisible({ timeout: 30_000 });
  await expect(pyramid.getByRole('button', { name: /^inside,/ })).toBeVisible();
  await expect(pyramid.getByRole('button', { name: /^outside,/ })).toBeVisible();

  await gotoPlace(page, 'vocabulary');
  await vocabularyScope.getByRole('button', { name: 'Use all texts' }).click();
  await expect(page.locator('#place-vocabulary-heading')).toBeFocused();
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);

  await gotoPlace(page, 'compare');
  await expect(page.getByText('No range selected.', { exact: true })).toBeVisible();
  await expect(page.locator('.linked-range-banner')).toHaveCount(0);
  await expect(pyramid).toHaveCount(0);
});
