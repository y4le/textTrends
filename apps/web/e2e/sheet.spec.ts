import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
});

test('Settings is a transient full-screen modal outside browser history', async ({ page }) => {
  const historyBefore = await page.evaluate(() => history.length);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.click();

  const pane = page.getByRole('dialog', { name: 'Settings' });
  await expect(pane.getByRole('heading', { name: 'Settings', exact: true })).toBeFocused();
  await expect(pane).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  const box = await pane.boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.y).toBe(0);
  expect(box?.width).toBe(390);
  expect(box?.height).toBe(844);
  expect((await pane.locator('.trend-settings-check').boundingBox())?.height)
    .toBeGreaterThanOrEqual(44);

  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await expect(settings).toBeFocused();
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  expect((await trace(page)).events.filter((event) =>
    event.seq > mark && event.direction === 'to-worker' && event.t === 'query')).toEqual([]);
});

test('Settings keeps its Trends context while navigation moves beneath it', async ({ page }) => {
  await gotoPlace(page, 'vocabulary');
  await page.goBack();
  await expect(page).toHaveURL(/\?p=trends$/);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const pane = page.getByRole('dialog', { name: 'Settings', exact: true });

  await page.goForward();
  await expect(page).toHaveURL(/\?p=vocabulary$/);
  await expect(pane).toBeVisible();
  await expect(pane.getByRole('form', { name: 'Trend settings' })).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(1);
});

test('an open Settings pane preserves its draft and focus across widths', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const pane = page.getByRole('dialog', { name: 'Settings' });
  const bins = pane.getByRole('spinbutton', { name: 'Bins per book', exact: true });
  await bins.fill('23');
  await expect(pane).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(pane).toBeVisible();
  await expect(bins).toHaveValue('23');
  await expect(bins).toBeFocused();
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(pane).toBeVisible();
  await expect(bins).toHaveValue('23');
  await expect(bins).toBeFocused();
});

test('unchanged settings stay open while close discards the draft', async ({ page }) => {
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.click();
  let pane = page.getByRole('dialog', { name: 'Settings' });
  let bins = pane.getByRole('spinbutton', { name: 'Bins per book', exact: true });

  await pane.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(pane).toBeVisible();
  await expect(pane.getByRole('status').filter({ hasText: 'already current' }))
    .toContainText('already current');

  await bins.fill('23');
  await pane.getByRole('button', { name: 'close', exact: true }).click();
  await expect(settings).toBeFocused();

  await settings.click();
  pane = page.getByRole('dialog', { name: 'Settings' });
  bins = pane.getByRole('spinbutton', { name: 'Bins per book', exact: true });
  await expect(bins).toHaveValue('40');
});
