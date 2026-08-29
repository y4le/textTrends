import { expect, test } from '@playwright/test';
import { awaitAllReady } from './helpers.ts';
import { POSITION_HISTORY_SETTLE_MS } from '../src/lib/position-history.ts';

test('reading position history traverses the workbench and Reader without using browser Back', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const header = page.locator('.app-header');
  const historyGroup = header.getByRole('group', { name: 'Reading position history' });
  const previous = historyGroup.getByRole('button', { name: 'Previous reading position' });
  const next = historyGroup.getByRole('button', { name: 'Next reading position' });
  await expect(previous).toBeVisible();
  await expect(next).toBeVisible();
  await expect(previous).toBeDisabled();
  await expect(next).toBeDisabled();

  const headerGeometry = await header.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(headerGeometry.scrollWidth).toBeLessThanOrEqual(headerGeometry.clientWidth + 1);
  const coarse = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
  for (const button of [previous, next]) {
    const box = await button.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(coarse ? 44 : 32);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(await button.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)))
      .toBeGreaterThanOrEqual(16);
  }

  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  await slider.focus();
  await slider.press('Home');
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await page.waitForTimeout(POSITION_HISTORY_SETTLE_MS + 50);
  await slider.press('End');
  const end = await slider.getAttribute('aria-valuenow');
  expect(Number(end)).toBeGreaterThan(0);
  await expect(previous).toBeEnabled();
  await expect(next).toBeDisabled();

  const workbenchHistoryLength = await page.evaluate(() => history.length);
  await previous.click();
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await expect(next).toBeEnabled();
  expect(await page.evaluate(() => history.length)).toBe(workbenchHistoryLength);

  await page.keyboard.press('Control+i');
  await expect(slider).toHaveAttribute('aria-valuenow', end!);
  await expect(page.getByRole('status', { name: 'Navigation status' }))
    .toContainText('Next reading position');

  await slider.focus();
  await slider.press('Enter');
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  const readerPage = reader.locator('[data-reader-page]');
  await expect(readerPage).toBeVisible();
  const readerAnchor = await readerPage.getAttribute('data-reader-anchor');
  const readerBrowserHistoryLength = await page.evaluate(() => history.length);

  await page.keyboard.press('Control+o');
  await expect(reader).toBeVisible();
  await expect(readerPage).not.toHaveAttribute('data-reader-anchor', readerAnchor!);
  expect(await page.evaluate(() => history.length)).toBe(readerBrowserHistoryLength);
  await expect(reader.getByRole('button', { name: 'back', exact: true })).toBeVisible();

  await page.keyboard.press('Control+i');
  await expect(readerPage).toHaveAttribute('data-reader-anchor', readerAnchor!);
});
