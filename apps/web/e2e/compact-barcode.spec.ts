import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  clearDemoInputs,
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
        && event.op === 'matches-window',
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

test('coarse pointers read the dense barcode through the first shown term\'s 48px stepper', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'trends');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  const scrubber = page.getByRole('slider', { name: /reading position/i });
  const canvas = scrubber.locator('canvas[data-pointer-contract="scrub-only"]').first();
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe('none');

  const stepper = page.getByRole('group', { name: /^Barcode (reference|bucket) navigation$/ });
  await expect(stepper).toBeVisible();
  await expect(stepper.getByRole('button')).toHaveCount(2);
  await expect(stepper.getByRole('button', { name: 'Previous reference' })).toBeVisible();
  const buttons = await stepper.getByRole('button').all();
  for (const button of buttons) {
    const box = await button.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(48);
    expect(box?.width).toBeGreaterThanOrEqual(48);
  }

  await stepper.getByRole('button', { name: 'Next reference' }).click();
  await expect(scrubber).toHaveAttribute('aria-valuetext', /token \d+ of/);
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);

  const footerSlider = page.getByRole('slider', { name: 'Corpus footer position' });
  expect((await footerSlider.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const footerReader = page.getByRole('button', { name: /Open reader at .* token/ });
  await expect(footerReader).toBeVisible({ timeout: 15_000 });
  // The squeezed default spends the governed passage lane down to its 24px
  // compact-coarse floor; the occurrence steppers retain full 48px targets.
  const passageHeight = await footerReader.evaluate((node) => Number.parseFloat(
    getComputedStyle(node).getPropertyValue('--footer-passage-height'),
  ));
  expect(passageHeight).toBe(24);
  expect((await footerReader.boundingBox())?.height).toBeGreaterThanOrEqual(passageHeight);
  await footerReader.click();
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: 'Return to workbench', exact: true }).click();
  await expect(footerSlider).toBeVisible();

  // A mouse on a coarse-presentation device keeps the barcode Reader door
  // and focus restoration; only the graph lane belongs to range gestures.
  const barcode = footerSlider.locator('canvas[data-barcode-band="series"]').first();
  await expect(barcode).toBeVisible();
  const barcodeBox = await barcode.boundingBox();
  if (!barcodeBox) throw new Error('footer barcode has no layout box');
  await footerSlider.focus();
  await page.mouse.dblclick(barcodeBox.x + 8, barcodeBox.y + 3);
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: 'Return to workbench', exact: true }).click();
  await expect(footerSlider).toBeFocused();

  const captions = [await scrubber.getAttribute('aria-valuetext')];
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  for (let index = 0; index < 2; index++) {
    await stepper.getByRole('button', { name: 'Next reference' }).click();
    await expect(scrubber).not.toHaveAttribute('aria-valuetext', captions.at(-1)! ?? '');
    captions.push(await scrubber.getAttribute('aria-valuetext'));
  }
  expect(new Set(captions).size).toBe(3);
  await awaitFreshKwic(page, mark);
  expect((await trace(page)).events.some(
    (event) => event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query'
      && event.op === 'matches-window',
  )).toBe(true);

  await page.getByRole('button', { name: 'Shown in analysis: Holmes' }).click();
  await page.getByRole('button', { name: 'Shown in analysis: Watson' }).click();
  const termRow = (term: string) => page.locator('[data-term-occurrences]').filter({ hasText: term });
  await expect(termRow('Moriarty').getByRole('group', { name: /^Barcode (reference|bucket) navigation$/ }))
    .toBeVisible();
  await expect(termRow('Holmes').getByRole('group', { name: /^Barcode (reference|bucket) navigation$/ }))
    .toHaveCount(0);

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
    await awaitAllReady(page, { loadDemo: true });
    await gotoPlace(page, 'inputs');
    await clearDemoInputs(page);
    await page.getByLabel('Add files').setInputFiles({
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

    // Expansion turns the footer barcode into a comfortable direct-touch
    // mention scrubber. Exact ticks snap the reading position without
    // adopting desktop click activation.
    const resizeHandle = page.getByRole('separator', { name: 'Resize reading footer' });
    await resizeHandle.focus();
    await resizeHandle.press('PageUp');
    const expandedFooterBox = await footerBand.boundingBox();
    if (!expandedFooterBox) throw new Error('expanded footer barcode has no layout box');
    expect(expandedFooterBox.height).toBeGreaterThan(footerBox.height);
    const touchPoint = (pointerId: number, x: number, buttons: number) => ({
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons,
      clientX: x,
      clientY: expandedFooterBox.y + expandedFooterBox.height / 2,
    });
    const firstMentionX = expandedFooterBox.x + expandedFooterBox.width * (1 / 9) - 4;
    const secondMentionX = expandedFooterBox.x + expandedFooterBox.width * (7 / 9) - 4;
    await footerSlider.dispatchEvent('pointerdown', touchPoint(31, firstMentionX, 1));
    await footerSlider.dispatchEvent('pointermove', touchPoint(31, secondMentionX, 1));
    await expect(footerSlider).toHaveAttribute('data-touch-scrubbing', 'true');
    await expect(footerSlider).toHaveAttribute('aria-valuenow', '7');
    await footerSlider.dispatchEvent('pointerup', touchPoint(31, secondMentionX, 0));
    await expect(footerSlider).not.toHaveAttribute('data-touch-scrubbing', 'true');
    await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);

    // Seeing a mouse must not collapse the persistent touch affordances.
    const stepper = page.getByRole('group', { name: /^Barcode (reference|bucket) navigation$/ });
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
