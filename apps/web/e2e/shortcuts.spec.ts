import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace } from './helpers.ts';

test('shortcut help follows focus and restores its invoking control', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'inputs' });

  const acquisitionToggle = page.getByRole('button', { name: 'Show options' });
  await expect(acquisitionToggle).toBeFocused();
  const coarsePointer = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
  if (coarsePointer) {
    expect((await acquisitionToggle.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await acquisitionToggle.press('?');
  let dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Terms' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Trends' })).toHaveCount(0);
  await expect(dialog.getByRole('heading', { name: 'Footer size' })).toBeVisible();
  await expect(dialog.getByText('Restore the default size', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'close', exact: true }))
    .toHaveAttribute('aria-keyshortcuts', 'Escape ?');
  await page.keyboard.press('?');
  await expect(dialog).toHaveCount(0);
  await expect(acquisitionToggle).toBeFocused();

  await gotoPlace(page, 'inputs');
  await acquisitionToggle.click();
  if (coarsePointer) {
    expect((await page.getByLabel('Add files — import and analyze').locator('..').boundingBox())?.height)
      .toBeGreaterThanOrEqual(44);
    expect((await page.getByLabel('Save files to library').locator('..').boundingBox())?.height)
      .toBeGreaterThanOrEqual(44);
  }
  await page.getByRole('button', { name: /Browse Standard Ebooks/ }).click();
  const catalogFilter = page.getByRole('searchbox', { name: 'Filter the Standard Ebooks library' });
  await catalogFilter.fill('sherlock');
  await catalogFilter.press('?');
  await expect(catalogFilter).toHaveValue('sherlock?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);

  const open = page.getByRole('button', { name: 'Help', exact: true });
  const openBox = await open.boundingBox();
  expect(openBox?.width).toBeGreaterThanOrEqual(44);
  expect(openBox?.height).toBeGreaterThanOrEqual(44);
  expect(await open.evaluate((node) => getComputedStyle(node).textDecorationLine))
    .toContain('underline');
  await open.click();
  dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Rows', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Trends', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('heading', { name: 'Reading footer' })).toBeVisible();
  await expect(dialog.getByText('Go to Inputs', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Go to Trends', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Previous rendered passage')).toBeVisible();
  const debugButton = dialog.getByRole('button', { name: 'Debug', exact: true });
  const debugButtonBox = await debugButton.boundingBox();
  expect(debugButtonBox?.width).toBeGreaterThanOrEqual(44);
  expect(debugButtonBox?.height).toBeGreaterThanOrEqual(44);
  const panel = dialog.locator('.shortcut-help-pane');
  const [panelBox, viewport] = await Promise.all([
    panel.boundingBox(),
    page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
  ]);
  expect(panelBox?.width).toBeLessThan(viewport.width);
  expect(panelBox?.height).toBeLessThan(viewport.height);
  expect(await dialog.evaluate((node) => getComputedStyle(node).backdropFilter)).toContain('blur');
  await expect(dialog.locator('.shortcut-help-key-separator').first()).toHaveText('/');
  expect(await dialog.locator('kbd').first().evaluate((node) =>
    getComputedStyle(node).borderTopStyle)).toBe('solid');
  await debugButton.click();
  const debug = page.getByRole('dialog', { name: 'Debug' });
  await expect(debug).toBeVisible();
  await expect(debug.getByRole('button', { name: 'Clear cache' })).toBeVisible();
  await page.keyboard.press('Shift+D');
  await expect(debug).toHaveCount(0);
  await expect(open).toBeFocused();

  await page.keyboard.press('Shift+D');
  await expect(page.getByRole('dialog', { name: 'Debug' })).toBeVisible();
  await page.keyboard.press('Escape');

  await gotoPlace(page, 'trends');
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  await slider.focus();
  await slider.press('?');
  dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Trends', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Rows', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Go to Trends', { exact: true })).toHaveCount(0);
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
