import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  gotoPlace,
  submitAndAwaitFreshResults,
  trace,
} from './helpers.ts';

async function awaitFreshKwic(
  page: import('@playwright/test').Page,
  mark: number,
): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await trace(page);
    const query = snapshot.events.find(
      (event) =>
        event.seq > mark
        && event.direction === 'to-worker'
        && event.t === 'query'
        && event.op === 'concordance-window',
    );
    if (!query) return 'waiting for query';
    return snapshot.events.some(
      (event) =>
        event.seq > mark
        && event.direction === 'from-worker'
        && event.t === 'result'
        && event.job === query.job,
    )
      ? 'ready'
      : 'waiting for result';
  }, { timeout: 30_000 }).toBe('ready');
}

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

  const scrubber = page.getByRole('slider', { name: /reading position/i });
  const canvas = scrubber.locator('canvas[data-pointer-contract="scrub-only"]');
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
  await expect(scrubber).toHaveAttribute('aria-valuetext', /token \d+ of/);
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);

  const footerSlider = page.getByRole('slider', { name: 'Corpus footer position' });
  expect((await footerSlider.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const footerReader = page.getByRole('button', { name: /Open reader at .* token/ });
  await expect(footerReader).toBeVisible({ timeout: 15_000 });
  expect((await footerReader.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await footerReader.click();
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: 'back' }).click();
  await expect(footerSlider).toBeVisible();

  // A mouse on a coarse-presentation device still gets the whole-footer
  // double-click door and focus restoration.
  const footerBox = await footerSlider.boundingBox();
  if (!footerBox) throw new Error('footer slider has no layout box');
  await footerSlider.dblclick({
    position: { x: footerBox.width * 0.63, y: footerBox.height / 2 },
  });
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: 'back' }).click();
  await expect(footerSlider).toBeFocused();

  const captions = [await scrubber.getAttribute('aria-valuetext')];
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  for (let index = 0; index < 2; index++) {
    await stepper.getByRole('button', { name: 'Next Holmes occurrence' }).click();
    await expect(scrubber).not.toHaveAttribute('aria-valuetext', captions.at(-1)! ?? '');
    captions.push(await scrubber.getAttribute('aria-valuetext'));
  }
  expect(new Set(captions).size).toBe(3);
  await awaitFreshKwic(page, mark);
  expect((await trace(page)).events.some(
    (event) => event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query'
      && event.op === 'concordance-window',
  )).toBe(true);

  await page
    .getByRole('group', { name: 'Query terms' })
    .getByRole('button', { name: /^Moriarty \d+$/ })
    .click();
  await expect(stepper.getByRole('button', { name: 'Next Moriarty occurrence' })).toBeVisible();
  await expect(stepper.getByRole('button', { name: 'Next Holmes occurrence' })).toHaveCount(0);

  await context.close();
});

test('a mouse on a coarse iPad-style device hovers and snaps both barcodes without disabling touch layout', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await page.goto('./');
    await awaitAllReady(page);
    await gotoPlace(page, 'inputs');
    await page.getByLabel('Create project from files').setInputFiles({
      name: 'hybrid-pointer.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('the wolf ran. a fox saw the wolf sleep.\n', 'utf-8'),
    });
    await awaitReadyCount(page, 1);
    await gotoPlace(page, 'trends');
    await submitAndAwaitFreshResults(page, 'wolf');

    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const scrubber = page.getByRole('slider', { name: /reading position/i });
    const trendsBand = scrubber.locator('canvas[data-barcode-band="series"]');
    const trendsBox = await trendsBand.boundingBox();
    if (!trendsBox) throw new Error('trend barcode has no layout box');
    const nearFirstTrendTick = trendsBox.x + trendsBox.width * (1 / 9) - 4;

    // Playwright's mouse emits pointerType=mouse even though this context's
    // media query remains coarse, matching an iPad with a trackpad attached.
    await page.mouse.move(nearFirstTrendTick, trendsBox.y + 3);
    await expect(scrubber).toHaveAttribute('aria-valuenow', '1');

    const footer = page.getByRole('complementary', { name: 'Reading position' });
    const footerSlider = page.getByRole('slider', { name: 'Corpus footer position' });
    const footerBand = footer.locator('canvas[data-barcode-band="series"]');
    const footerBox = await footerBand.boundingBox();
    if (!footerBox) throw new Error('footer barcode has no layout box');
    await page.mouse.move(footerBox.x + footerBox.width * (1 / 9) - 4, footerBox.y + 3);
    // This retry spans the footer's intentional 120ms hover dwell.
    await expect(footerSlider).toHaveAttribute('aria-valuenow', '1');
    // Once the dwell has elapsed, subsequent moves must keep using the armed
    // exact index rather than falling back to the raw corpus axis.
    await page.mouse.move(footerBox.x + footerBox.width * 0.5, footerBox.y + 3);
    await expect(footerSlider).toHaveAttribute('aria-valuenow', '4');
    await page.mouse.move(footerBox.x + footerBox.width * (1 / 9) - 4, footerBox.y + 3);
    await expect(footerSlider).toHaveAttribute('aria-valuenow', '1');

    // Seeing a mouse must not collapse the persistent touch affordances.
    const stepper = page.getByRole('group', { name: 'Barcode occurrence navigation' });
    await expect(stepper).toBeVisible();
    for (const button of await stepper.getByRole('button').all()) {
      const box = await button.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(48);
      expect(box?.width).toBeGreaterThanOrEqual(48);
    }

    // Touch stays direct even after precise snapping has been armed. Four
    // pixels before wolf@1 is raw token 0, within the mouse snap tolerance.
    await page.touchscreen.tap(nearFirstTrendTick, trendsBox.y + 3);
    await expect(scrubber).toHaveAttribute('aria-valuenow', '0');
  } finally {
    await context.close();
  }
});
