import { expect, test } from '@playwright/test';
import { awaitAllReady, trace } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
});

test('Evidence sheet detents replace one history layer and govern modality', async ({ page }) => {
  const historyBefore = await page.evaluate(() => history.length);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const more = page.getByRole('button', { name: 'More evidence' });
  await more.click();

  const sheet = page.getByRole('dialog', { name: 'Evidence sheet' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-detent', 'peek');
  await expect(sheet).toHaveAttribute('aria-modal', 'false');
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await expect(page).toHaveURL(/[?&]e=sheet(?:&|$)/);
  expect(await page.evaluate(() => history.length)).toBe(historyBefore + 1);
  const peekBox = await sheet.boundingBox();
  const lensBox = await page.locator('.lens-organ').boundingBox();
  expect(peekBox?.height).toBeCloseTo(844 * 0.28, 0);
  expect(peekBox).not.toBeNull();
  expect(lensBox).not.toBeNull();
  expect(peekBox!.y + peekBox!.height).toBeLessThanOrEqual(lensBox!.y + 1);
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

  await sheet.getByRole('button', { name: 'half', exact: true }).click();
  await expect(sheet).toHaveAttribute('data-detent', 'half');
  await expect(sheet.getByRole('button', { name: 'half', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(sheet).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  await expect(page.locator('.sheet-scrim')).toBeVisible();
  expect((await sheet.boundingBox())?.height).toBeCloseTo(844 * 0.58, 0);
  expect(await page.evaluate(() => history.length)).toBe(historyBefore + 1);
  await page.keyboard.press('Shift+Tab');
  await expect(sheet.locator(':focus')).toHaveCount(1);

  await sheet.getByRole('button', { name: 'tall', exact: true }).click();
  await expect(sheet).toHaveAttribute('data-detent', 'tall');
  expect((await sheet.boundingBox())?.height).toBeCloseTo(844 * 0.88, 0);
  expect(await page.evaluate(() => history.length)).toBe(historyBefore + 1);

  await sheet.getByRole('button', { name: 'peek', exact: true }).click();
  await expect(sheet).toHaveAttribute('aria-modal', 'false');
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(page).not.toHaveURL(/[?&]e=sheet(?:&|$)/);

  await page.goForward();
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-detent', 'peek');
  await expect(sheet.getByRole('button', { name: 'Close Evidence sheet' })).toBeFocused();

  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);
});

test('Method and Evidence replace one sheet without adding history depth', async ({ page }) => {
  const method = page.getByRole('button', { name: 'Method', exact: true });
  await method.click();
  const methodSheet = page.getByRole('dialog', { name: 'Method sheet' });
  await expect(methodSheet).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(methodSheet.locator('details.method-summary')).toBeVisible();
  const historyWithSheet = await page.evaluate(() => history.length);

  await methodSheet.getByRole('button', { name: 'Evidence', exact: true }).click();
  const evidenceSheet = page.getByRole('dialog', { name: 'Evidence sheet' });
  await expect(evidenceSheet).toBeVisible();
  await expect(methodSheet).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect(await page.evaluate(() => history.length)).toBe(historyWithSheet);

  await evidenceSheet.getByRole('button', { name: 'Method', exact: true }).click();
  await expect(methodSheet).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(historyWithSheet);
  await page.keyboard.press('Escape');
  await expect(methodSheet).toHaveCount(0);
  await expect(method).toBeFocused();
});

test('an open sheet transforms into wide regions and back without semantic work', async ({ page }) => {
  const setupMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  await expect(page.getByRole('button', { name: 'Open passage in reader' })).toBeVisible();
  await expect.poll(async () => (await trace(page)).events.some(
    (event) =>
      event.seq > setupMark
      && event.direction === 'to-worker'
      && event.t === 'query'
      && event.op === 'kwic',
  )).toBe(true);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'Method', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Method sheet' });
  await expect(sheet).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(sheet).toHaveCount(0);
  const wideMethod = page.getByRole('region', { name: 'Method', exact: true });
  await expect(wideMethod).toBeVisible();
  await expect(wideMethod).toBeFocused();
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await expect(page).toHaveURL(/[?&]e=sheet(?:&|$)/);
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);
  const read = page.getByRole('button', { name: 'Open passage in reader' });
  await read.click();
  const reader = page.getByRole('dialog', { name: /Reader:/ });
  await reader.getByRole('button', { name: 'close', exact: true }).click();
  await expect(read).toBeFocused();
  const returnMark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Close Method sheet' })).toBeFocused();
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > returnMark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);
});

test('an Evidence sheet transforms to its wide landmark and back', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  const setupMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  await expect(page.getByRole('button', { name: 'Open passage in reader' })).toBeVisible();
  await expect.poll(async () => (await trace(page)).events.some(
    (event) =>
      event.seq > setupMark
      && event.direction === 'to-worker'
      && event.t === 'query'
      && event.op === 'kwic',
  )).toBe(true);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'More evidence' }).click();
  const sheet = page.getByRole('dialog', { name: 'Evidence sheet' });
  await expect(sheet).toBeVisible();

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(sheet).toHaveCount(0);
  const wideEvidence = page.getByRole('complementary', { name: 'Evidence' });
  await expect(wideEvidence).toBeVisible();
  await expect(wideEvidence).toBeFocused();
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);
  const read = page.getByRole('button', { name: 'Open passage in reader' });
  await read.click();
  const reader = page.getByRole('dialog', { name: /Reader:/ });
  await reader.getByRole('button', { name: 'close', exact: true }).click();
  await expect(read).toBeFocused();
  const returnMark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Close Evidence sheet' })).toBeFocused();
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > returnMark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);
});

test('a wide sheet deep link does not move focus without a live transform', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?p=trends&e=sheet');
  await awaitAllReady(page);
  await expect(page.getByRole('complementary', { name: 'Evidence' })).not.toBeFocused();
  await expect(page.getByRole('region', { name: 'Method', exact: true })).not.toBeFocused();
});
