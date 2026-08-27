import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace } from './helpers.ts';

test('contextual Help follows focus and unifies guidance, actions, credits, and shortcuts', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'inputs' });

  const acquisitionToggle = page.getByRole('button', { name: 'Show options' });
  await expect(acquisitionToggle).toBeFocused();
  const coarsePointer = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
  if (coarsePointer) {
    expect((await acquisitionToggle.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await acquisitionToggle.press('?');
  let dialog = page.getByRole('dialog', { name: 'Help' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'This view', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Quick actions', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Method & privacy', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Keyboard & gestures', exact: true })).toBeVisible();
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
  await expect(page.getByRole('dialog', { name: 'Help' })).toHaveCount(0);

  const open = page.getByRole('button', { name: 'Help', exact: true });
  const openBox = await open.boundingBox();
  expect(openBox?.width).toBeGreaterThanOrEqual(44);
  expect(openBox?.height).toBeGreaterThanOrEqual(44);
  expect(await open.evaluate((node) => getComputedStyle(node).textDecorationLine))
    .toContain('underline');
  await open.click();
  dialog = page.getByRole('dialog', { name: 'Help' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Build the corpus you want to study and set its reading order.'))
    .toBeVisible();
  await expect(dialog.getByText('Imported text is processed in this browser and is never uploaded.'))
    .toBeVisible();
  await expect(dialog.getByRole('button', { name: /Find in corpus/ })).toHaveCount(0);
  await expect(dialog.getByRole('heading', { name: 'Rows', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Trends', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('heading', { name: 'Reading footer' })).toBeVisible();
  await expect(dialog.getByText('Go to Inputs', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Go to Trends', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Previous rendered passage')).toBeVisible();
  await expect(dialog.getByText('Start a range at the footer cursor')).toBeVisible();
  const panel = dialog.locator('.help-pane');
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

  await dialog.getByRole('button', { name: 'Display settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('heading', { name: 'Display', exact: true })).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Help & method', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();

  await open.click();
  dialog = page.getByRole('dialog', { name: 'Help' });
  const creditsButton = dialog.getByRole('button', { name: 'Credits & sources', exact: true });
  await creditsButton.click();
  const credits = page.getByRole('dialog', { name: 'Credits & sources', exact: true });
  await expect(credits.getByRole('heading', { name: 'Project', exact: true })).toBeVisible();
  await expect(credits.getByRole('heading', { name: 'Text sources', exact: true })).toBeVisible();
  await expect(credits.getByRole('heading', { name: 'Under the hood', exact: true })).toBeVisible();
  await expect(credits.getByText(/catalog makes no external request; it ships with the app/))
    .toBeVisible();
  await expect(credits.getByText(/source files download from GitHub \(raw\.githubusercontent\.com\)/))
    .toBeVisible();
  await credits.getByRole('button', { name: 'Help', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Help' });
  await expect(dialog.getByRole('button', { name: 'Credits & sources', exact: true })).toBeFocused();

  const debugButton = dialog.getByRole('button', { name: 'Debug', exact: true });
  const debugButtonBox = await debugButton.boundingBox();
  expect(debugButtonBox?.width).toBeGreaterThanOrEqual(44);
  expect(debugButtonBox?.height).toBeGreaterThanOrEqual(44);
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
  dialog = page.getByRole('dialog', { name: 'Help' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Trends', exact: true })).toBeVisible();
  await expect(dialog.getByText(/double-tap the graph to clear that range/i)).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Rows', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Go to Trends', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'close' }).click();
  await expect(slider).toBeFocused();

  await slider.press('ArrowRight');
  await slider.press('Enter');
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await expect(reader.locator('[data-reader-page]')).toBeVisible();
  const readerHelp = reader.getByRole('button', { name: 'help', exact: true });
  await readerHelp.click();
  dialog = page.getByRole('dialog', { name: 'Help' });
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
  await expect(readerHelp).toBeFocused();
});

test('Help and Credits remain contained at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'inputs' });
  await page.getByRole('button', { name: 'Help', exact: true }).click();

  let dialog = page.getByRole('dialog', { name: 'Help', exact: true });
  let pane = dialog.locator('.help-pane');
  const helpBox = await pane.boundingBox();
  expect(helpBox?.x).toBeGreaterThanOrEqual(0);
  expect((helpBox?.x ?? 0) + (helpBox?.width ?? Number.POSITIVE_INFINITY))
    .toBeLessThanOrEqual(320);
  for (const action of await dialog.locator('.utility-pane-footer button').all()) {
    const box = await action.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(320);
  }

  await dialog.getByRole('button', { name: 'Credits & sources', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Credits & sources', exact: true });
  pane = dialog.locator('.help-pane');
  const creditsBox = await pane.boundingBox();
  expect(creditsBox?.x).toBeGreaterThanOrEqual(0);
  expect((creditsBox?.x ?? 0) + (creditsBox?.width ?? Number.POSITIVE_INFINITY))
    .toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
