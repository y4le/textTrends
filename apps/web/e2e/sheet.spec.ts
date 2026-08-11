import { expect, test } from '@playwright/test';
import { awaitAllReady, trace } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
});

test('Method is a transient full-screen modal outside browser history', async ({ page }) => {
  const historyBefore = await page.evaluate(() => history.length);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const method = page.getByRole('button', { name: 'Method & settings', exact: true });
  await method.click();

  const pane = page.getByRole('dialog', { name: 'Method & settings' });
  await expect(pane).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  const box = await pane.boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.y).toBe(0);
  expect(box?.width).toBe(390);
  expect(box?.height).toBe(844);

  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await expect(method).toBeFocused();
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  expect((await trace(page)).events.filter((event) =>
    event.seq > mark && event.direction === 'to-worker' && event.t === 'query')).toEqual([]);
});

test('an open Method pane preserves its draft and focus across widths', async ({ page }) => {
  await page.getByRole('button', { name: 'Method & settings', exact: true }).click();
  const pane = page.getByRole('dialog', { name: 'Method & settings' });
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
  const method = page.getByRole('button', { name: 'Method & settings', exact: true });
  await method.click();
  let pane = page.getByRole('dialog', { name: 'Method & settings' });
  let bins = pane.getByRole('spinbutton', { name: 'Bins per book', exact: true });

  await pane.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(pane).toBeVisible();
  await expect(pane.getByRole('status').filter({ hasText: 'already current' }))
    .toContainText('already current');

  await bins.fill('23');
  await pane.getByRole('button', { name: 'close', exact: true }).click();
  await expect(method).toBeFocused();

  await method.click();
  pane = page.getByRole('dialog', { name: 'Method & settings' });
  bins = pane.getByRole('spinbutton', { name: 'Bins per book', exact: true });
  await expect(bins).toHaveValue('40');
});
