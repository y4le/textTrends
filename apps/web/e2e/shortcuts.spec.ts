import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace } from './helpers.ts';

test('shortcut help follows focus and restores its invoking control', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);

  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
  await page.keyboard.press('?');
  let dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Touch gestures' })).toBeVisible();
  await expect(dialog).toContainText('Press and hold a range start');
  await expect(dialog).toContainText('Tap or drag horizontally to read');
  await expect(dialog).toContainText('Drag a term only from its reorder handle');
  await page.keyboard.press('?');
  await expect(dialog).toHaveCount(0);

  await gotoPlace(page, 'catalog');
  await page.getByRole('button', { name: /Standard Ebooks library/ }).click();
  const catalogFilter = page.getByRole('searchbox', { name: 'Filter the Standard Ebooks library' });
  await catalogFilter.fill('sherlock');
  await catalogFilter.press('?');
  await expect(catalogFilter).toHaveValue('sherlock?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);

  const open = page.getByRole('button', { name: 'shortcuts', exact: true });
  await open.click();
  dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Reading footer' })).toBeVisible();
  await expect(dialog.getByText('Previous rendered passage')).toBeVisible();
  await expect(dialog.getByText(/Vim keys and conventional keys work together/)).toBeVisible();
  await page.keyboard.press('?');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();

  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  await slider.focus();
  await slider.press('?');
  dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'close' }).click();
  await expect(slider).toBeFocused();

  await slider.press('ArrowRight');
  await slider.press('Enter');
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await expect(reader.locator('[data-reader-page]')).toBeVisible();
  const readerShortcuts = reader.getByRole('button', { name: 'shortcuts', exact: true });
  await readerShortcuts.click();
  dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((layer, readerId) => {
    const readerLayer = document.getElementById(readerId);
    return readerLayer !== null
      && Number(getComputedStyle(layer).zIndex) > Number(getComputedStyle(readerLayer).zIndex);
  }, 'reader-region')).toBe(true);
  await expect(dialog.getByRole('heading', { name: 'Reader', exact: true })).toBeVisible();
  await expect(dialog.getByText('Next page', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Reading footer' })).toHaveCount(0);
  await page.keyboard.press('?');
  await expect(dialog).toHaveCount(0);
  await expect(readerShortcuts).toBeFocused();
});
