import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, DOC_COUNT, simulateKeyboard } from './helpers.ts';

test('temporary Find cycles exact corpus matches and preserves focus priority', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'trends' });

  const footer = page.getByRole('slider', { name: 'Corpus footer position' });
  await footer.focus();
  const before = await footer.getAttribute('aria-valuenow');
  await footer.press('/');

  const find = page.getByRole('search', { name: 'Find in corpus' });
  const input = find.getByRole('searchbox', { name: 'Find word or phrase' });
  const next = find.getByRole('button', { name: 'Next match' });
  const previous = find.getByRole('button', { name: 'Previous match' });
  const status = find.locator('#corpus-find-status');
  await expect(find).toBeVisible();
  await expect(input).toBeFocused();
  await input.fill('holmes');
  await input.press('Enter');
  await expect(next).toBeFocused();
  await expect(status).toContainText(/holmes/i);
  await expect(status).not.toContainText('Searching');
  await expect.poll(() => footer.getAttribute('aria-valuenow')).not.toBe(before);

  const first = await status.textContent();
  await input.press('Control+g');
  await expect.poll(async () => {
    const text = await status.textContent();
    return text?.includes('Searching') ? first : text;
  }).not.toBe(first);
  const second = await status.textContent();
  await previous.press('p');
  await expect.poll(async () => {
    const text = await status.textContent();
    return text?.includes('Searching') ? second : text;
  }).toBe(first);

  await page.keyboard.press('Escape');
  await expect(find).toHaveCount(0);
  await expect(footer).toBeFocused();

  await footer.press('Control+f');
  await expect(input).toBeFocused();
  await input.fill('one,two');
  await input.press('Enter');
  await expect(find.locator('#corpus-find-error')).toContainText('commas');
  await input.press('x');
  await expect(find.locator('#corpus-find-error')).toBeEmpty();
  await input.fill('');
  await input.pressSequentially('gi');
  await expect(input).toHaveValue('gi');
  await expect(page.getByRole('region', { name: 'Trends', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await footer.press('Enter');
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  const readerPosition = reader.locator('.reader-position');
  const readerBefore = await readerPosition.textContent();
  await reader.press('/');
  await expect(input).toBeFocused();
  await input.fill('moriarty');
  await input.press('Enter');
  await expect(status).not.toContainText('Searching');
  await expect(reader).toBeVisible();
  await expect.poll(() => readerPosition.textContent()).not.toBe(readerBefore);
  await page.keyboard.press('Escape');
  await expect(find).toHaveCount(0);
  await expect(reader).toBeVisible();

  await reader.press('/');
  await expect(input).toBeFocused();
  await reader.press('Escape');
  await expect(find).toHaveCount(0);
  await expect(reader).toBeVisible();
});

test('store-driven Find teardown restores focus instead of orphaning it', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'inputs' });

  const inputsRegion = page.getByRole('region', { name: 'Inputs', exact: true });
  await inputsRegion.focus();
  await inputsRegion.press('/');

  const find = page.getByRole('search', { name: 'Find in corpus' });
  await expect(find.getByRole('searchbox', { name: 'Find word or phrase' })).toBeFocused();
  await page.getByLabel('Add files').setInputFiles({
    name: 'focus-fence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('A small snapshot replacement for focus restoration.', 'utf-8'),
  });

  await awaitReadyCount(page, DOC_COUNT + 1);
  await expect(find).toHaveCount(0);
  await expect(inputsRegion).toBeFocused();
});

test('Shortcuts exposes a touch-sized Find entry above the visual keyboard', async ({ page }, testInfo) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'trends' });

  await page.getByRole('button', { name: 'shortcuts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog.getByRole('heading', { name: 'Tools', exact: true })).toBeVisible();
  const tool = dialog.getByRole('button', { name: /Find in corpus/ });
  if (testInfo.project.name === 'webkit-compact') {
    const box = await tool.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await tool.click();

  const find = page.getByRole('search', { name: 'Find in corpus' });
  const input = find.getByRole('searchbox', { name: 'Find word or phrase' });
  await expect(dialog).toHaveCount(0);
  await expect(input).toBeFocused();

  if (testInfo.project.name === 'webkit-compact') {
    for (const name of ['Previous match', 'Next match', 'Close find']) {
      const box = await find.getByRole('button', { name }).boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await simulateKeyboard(page, 280);
    const [box, viewport] = await Promise.all([
      find.boundingBox(),
      page.evaluate(() => ({ height: innerHeight, inset: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset'),
      ) })),
    ]);
    expect(box ? box.y + box.height : Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(viewport.height - viewport.inset);
  }
});
