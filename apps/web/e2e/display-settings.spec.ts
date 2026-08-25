import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace } from './helpers.ts';

test('Settings keeps fixed sections, applies theme live, and persists it locally', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  for (const place of ['inputs', 'trends', 'compare', 'matches', 'vocabulary'] as const) {
    await gotoPlace(page, place);
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  }

  const opener = page.getByRole('button', { name: 'Settings', exact: true });
  await opener.click();
  const pane = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(pane.locator('.settings-sections > section > h3')).toHaveText([
    'Display',
    'This place',
    'Help & method',
  ]);
  await expect(pane.getByRole('heading', { name: 'Settings', exact: true })).toBeFocused();

  await pane.getByRole('radio', { name: 'Light', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return style.getPropertyValue('--series-1').trim()
      === style.getPropertyValue('--series-light-1').trim();
  })).toBe(true);
  await pane.getByRole('button', { name: 'close', exact: true }).click();
  await expect(opener).toBeFocused();

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings' })
    .getByRole('radio', { name: 'System', exact: true }).check();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
});
