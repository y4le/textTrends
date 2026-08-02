import { expect, test } from '@playwright/test';
import { awaitAllReady, trace } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
});

async function revealEvidence(page: import('@playwright/test').Page) {
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scrubber.press('Home');
  await expect(page.getByRole('button', { name: 'Inspect', exact: true })).toBeVisible();
  await expect.poll(async () => {
    const snapshot = await trace(page);
    return ['kwic', 'passage'].every((op) => {
      const query = [...snapshot.events].reverse().find((event) =>
        event.seq > mark
        && event.direction === 'to-worker'
        && event.t === 'query'
        && event.op === op);
      return query !== undefined && snapshot.events.some((event) =>
        event.direction === 'from-worker'
        && (event.t === 'result' || event.t === 'error')
        && event.job === query.job);
    });
  }).toBe(true);
}

test('Evidence sheet detents replace one history layer and govern modality', async ({ page }) => {
  await revealEvidence(page);
  const historyBefore = await page.evaluate(() => history.length);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const inspect = page.getByRole('button', { name: 'Inspect', exact: true });
  await inspect.click();

  const sheet = page.getByRole('dialog', { name: 'Evidence sheet' });
  await expect(sheet).toHaveAttribute('data-detent', 'half');
  await expect(sheet).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  await expect(page.locator('.sheet-scrim')).toBeVisible();
  const buttonBoxes = await sheet.getByRole('button').evaluateAll((buttons) =>
    buttons
      .filter((button) => button.getClientRects().length > 0)
      .map((button) => {
        const box = button.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }));
  expect(buttonBoxes.length).toBeGreaterThan(0);
  for (const box of buttonBoxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('Shift+Tab');
  await expect(sheet.locator(':focus')).toHaveCount(1);
  await expect(page).toHaveURL(/[?&]e=sheet(?:&|$)/);
  expect(await page.evaluate(() => history.length)).toBe(historyBefore + 1);

  await sheet.getByRole('button', { name: 'tall', exact: true }).click();
  await expect(sheet).toHaveAttribute('data-detent', 'tall');
  expect((await sheet.boundingBox())?.height).toBeCloseTo(844 * 0.88, 0);
  await sheet.getByRole('button', { name: 'peek', exact: true }).click();
  await expect(sheet).toHaveAttribute('aria-modal', 'false');
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  const peekBox = await sheet.boundingBox();
  const lensBox = await page.locator('.lens-organ').boundingBox();
  expect(peekBox).not.toBeNull();
  expect(lensBox).not.toBeNull();
  expect(peekBox!.y + peekBox!.height).toBeLessThanOrEqual(lensBox!.y + 1);
  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(inspect).toBeFocused();
  await page.goForward();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Close Evidence sheet' })).toBeFocused();
  await sheet.getByRole('button', { name: 'Close Evidence sheet' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(inspect).toBeFocused();
  expect((await trace(page)).events.filter((event) =>
    event.seq > mark && event.direction === 'to-worker' && event.t === 'query')).toEqual([]);
});

test('Method and Evidence replace one sheet without adding history depth', async ({ page }) => {
  await revealEvidence(page);
  const method = page.getByRole('button', { name: 'Method & settings', exact: true });
  await method.click();
  const methodSheet = page.getByRole('dialog', { name: 'Method & settings sheet' });
  await expect(methodSheet.locator('details.method-summary')).toBeVisible();
  await expect(methodSheet.getByRole('heading', { name: 'Trend settings' })).toBeVisible();
  const historyWithSheet = await page.evaluate(() => history.length);

  await methodSheet.getByRole('button', { name: 'Evidence', exact: true }).click();
  const evidenceSheet = page.getByRole('dialog', { name: 'Evidence sheet' });
  await expect(evidenceSheet).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(historyWithSheet);

  await evidenceSheet.getByRole('button', { name: 'Method & settings', exact: true }).click();
  await expect(methodSheet).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(historyWithSheet);
  await page.keyboard.press('Escape');
  await expect(methodSheet).toHaveCount(0);
  await expect(method).toBeFocused();
});

test('a non-modal Method peek preserves an owner for Evidence shortcut feedback', async ({ page }) => {
  await revealEvidence(page);
  await page.getByRole('button', { name: 'Method & settings', exact: true }).click();
  const methodSheet = page.getByRole('dialog', { name: 'Method & settings sheet' });
  await methodSheet.getByRole('button', { name: 'peek', exact: true }).click();
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);

  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('p');
  const fallback = page.getByRole('complementary', { name: 'Evidence feedback' });
  await expect(fallback.getByRole('status')).toContainText(
    /Sav(?:ed|ing).*excerpt.*Findings/i,
  );
});

test('an open sheet remains the same governed surface across widths', async ({ page }) => {
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'Method & settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Method & settings sheet' });
  await expect(sheet).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('region', { name: 'Method', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(sheet).toBeVisible();
  expect((await trace(page)).events.filter((event) =>
    event.seq > mark && event.direction === 'to-worker' && event.t === 'query')).toEqual([]);
});

test('a wide Evidence deep link opens the sheet without a phantom sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?p=trends&e=sheet');
  await awaitAllReady(page);
  await expect(page.getByRole('dialog', { name: 'Evidence sheet' })).toBeVisible();
  await expect(page.locator('.workbench > .evidence-region')).toHaveCount(0);
});
