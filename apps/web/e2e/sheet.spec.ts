import { expect, test } from '@playwright/test';
import { awaitAllReady, trace } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
});

test('Method sheet detents govern modality and one history layer', async ({ page }) => {
  const historyBefore = await page.evaluate(() => history.length);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const method = page.getByRole('button', { name: 'Method & settings', exact: true });
  await method.click();

  const sheet = page.getByRole('dialog', { name: 'Method & settings sheet' });
  await expect(sheet).toHaveAttribute('data-detent', 'tall');
  await expect(sheet).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  expect(await page.evaluate(() => history.length)).toBe(historyBefore + 1);

  await sheet.getByRole('button', { name: 'half', exact: true }).click();
  await expect(sheet).toHaveAttribute('data-detent', 'half');
  await sheet.getByRole('button', { name: 'peek', exact: true }).click();
  await expect(sheet).toHaveAttribute('aria-modal', 'false');
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);

  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(method).toBeFocused();
  expect((await trace(page)).events.filter((event) =>
    event.seq > mark && event.direction === 'to-worker' && event.t === 'query')).toEqual([]);
});

test('an open Method sheet remains governed across widths', async ({ page }) => {
  await page.getByRole('button', { name: 'Method & settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Method & settings sheet' });
  await expect(sheet).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(sheet).toBeVisible();
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(sheet).toBeVisible();
});

test('legacy sheet query keys are removed without opening a surface', async ({ page }) => {
  await page.goto('./?p=trends&e=sheet');
  await awaitAllReady(page);
  await expect(page).toHaveURL(/\\?p=trends$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
