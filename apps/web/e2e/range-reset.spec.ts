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
  expect(await scrubber.evaluate(userSelect)).toBe('none');
  expect(await page.getByRole('region', { name: 'Trends', exact: true }).evaluate(userSelect)).toBe('none');

  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  await scrubber.press('ArrowRight');
  await scrubber.press('Enter');
  await expect(page.getByTestId('linked-selection')).toBeVisible();

  await scrubber.dblclick();

  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'clear selection' })).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

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
  await readableContext.dblclick();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim() ?? ''))
    .not.toBe('');
});
