import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace } from './helpers.ts';

test('coarse pointers read the dense barcode through one focused 48px stepper', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'trends');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  const canvas = page.locator('canvas[data-pointer-contract="read-only"]');
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe('none');

  const stepper = page.getByRole('group', { name: 'Barcode occurrence navigation' });
  await expect(stepper).toBeVisible();
  await expect(stepper.getByRole('button')).toHaveCount(2);
  await expect(stepper.getByRole('button', { name: 'Previous Holmes occurrence' })).toBeVisible();
  const buttons = await stepper.getByRole('button').all();
  for (const button of buttons) {
    const box = await button.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(48);
    expect(box?.width).toBeGreaterThanOrEqual(48);
  }

  await stepper.getByRole('button', { name: 'Next Holmes occurrence' }).click();
  const evidence = page.getByRole('complementary', { name: 'Evidence' });
  await expect(evidence.getByRole('button', { name: 'Open passage in reader' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('dialog', { name: /Reader:/ })).toHaveCount(0);

  await page
    .getByRole('group', { name: 'Query terms' })
    .locator('.query-focus-chip')
    .filter({ hasText: 'Moriarty' })
    .click();
  await expect(stepper.getByRole('button', { name: 'Next Moriarty occurrence' })).toBeVisible();
  await expect(stepper.getByRole('button', { name: 'Next Holmes occurrence' })).toHaveCount(0);

  await context.close();
});
