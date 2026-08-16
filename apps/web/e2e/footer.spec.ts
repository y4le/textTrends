import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  clearDemoInputs,
  DOC_COUNT,
  gotoPlace,
  submitAndAwaitFreshResults,
  trace,
} from './helpers.ts';

async function expectPassageFilledAndCentered(page: import('@playwright/test').Page) {
  const passage = page.locator('.footer-passage[data-passage-for]');
  const selected = passage.locator('.footer-passage-node');
  const cursor = page.getByTestId('footer-cursor');
  await expect(selected).toBeVisible({ timeout: 15_000 });
  const [passageBox, textBox, selectedBox, cursorBox] = await Promise.all([
    passage.boundingBox(),
    passage.locator('.footer-passage-text').boundingBox(),
    selected.boundingBox(),
    cursor.boundingBox(),
  ]);
  if (!passageBox || !textBox || !selectedBox || !cursorBox) {
    throw new Error('footer passage geometry is unavailable');
  }
  expect(textBox.x).toBeLessThanOrEqual(passageBox.x + 1);
  expect(textBox.x + textBox.width).toBeGreaterThanOrEqual(passageBox.x + passageBox.width - 1);
  expect(Math.abs(
    selectedBox.x + selectedBox.width / 2 - (cursorBox.x + cursorBox.width / 2),
  )).toBeLessThanOrEqual(2);
}

async function expectSelectedInsidePassage(page: import('@playwright/test').Page) {
  const passage = page.locator('.footer-passage[data-passage-for]');
  const selected = passage.locator('.footer-passage-node');
  await expect(selected).toBeVisible({ timeout: 15_000 });
  const [passageBox, selectedBox] = await Promise.all([
    passage.boundingBox(),
    selected.boundingBox(),
  ]);
  if (!passageBox || !selectedBox) throw new Error('footer boundary geometry is unavailable');
  expect(selectedBox.x).toBeGreaterThanOrEqual(passageBox.x - 1);
  expect(selectedBox.x + selectedBox.width)
    .toBeLessThanOrEqual(passageBox.x + passageBox.width + 1);
}

test('the workbench footer shares one corpus axis and opens the current passage', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  await expect(footer).toBeVisible();
  await expect(slider).toBeVisible();
  expect(await footer.locator('.footer-sparkline path').count()).toBeGreaterThanOrEqual(2);
  await expect(footer.locator('.footer-book-boundary')).toHaveCount(DOC_COUNT - 1);
  await expect(footer.locator('canvas[data-barcode-band="series"]')).toHaveCount(1);
  const sparklineCommits = await page.evaluate(() =>
    (window as unknown as { __ttFooterCommits?: number }).__ttFooterCommits ?? 0);
  expect(sparklineCommits).toBeGreaterThan(0);

  const box = await slider.boundingBox();
  if (!box) throw new Error('footer slider has no layout box');
  await page.mouse.move(box.x + box.width * 0.38, box.y + 5);
  await expect(slider).not.toHaveAttribute('aria-valuetext', 'no position');
  await expect(footer.locator('.footer-reading-status')).toContainText(/token .* of .*% of corpus/);
  await expect.poll(async () => Number(await footer.getByTestId('footer-progress').getAttribute('data-progress')))
    .toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: /Open reader at .* token/ })).toBeVisible({
    timeout: 15_000,
  });
  const keyboardStart = Number(await slider.getAttribute('aria-valuenow'));
  const passageLine = footer.locator('.footer-passage[data-passage-for]');
  const firstWindow = {
    first: Number(await passageLine.getAttribute('data-passage-first')),
    last: Number(await passageLine.getAttribute('data-passage-last')),
    forToken: Number(await passageLine.getAttribute('data-passage-for')),
  };
  await expectPassageFilledAndCentered(page);
  await slider.focus();
  await slider.press('ArrowRight');
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(keyboardStart + 1);
  await expect.poll(async () => Number(await passageLine.getAttribute('data-passage-for')))
    .toBeGreaterThan(firstWindow.forToken);
  const nextWindow = {
    first: Number(await passageLine.getAttribute('data-passage-first')),
    last: Number(await passageLine.getAttribute('data-passage-last')),
    forToken: Number(await passageLine.getAttribute('data-passage-for')),
  };
  expect(nextWindow.first).toBeLessThanOrEqual(firstWindow.last + 1);
  expect(nextWindow.last).toBeGreaterThan(nextWindow.first);
  await expectPassageFilledAndCentered(page);

  await slider.press('ArrowLeft');
  await expect.poll(async () => Number(await passageLine.getAttribute('data-passage-for')))
    .toBeLessThan(nextWindow.forToken);
  await expectPassageFilledAndCentered(page);

  // Walk far enough to cross the first 400-token source reservoir. Every
  // settled page remains filled while the selected token stays over the
  // corpus cursor, including after the measured-margin re-center.
  let priorPageToken = Number(await passageLine.getAttribute('data-passage-for'));
  for (let index = 0; index < 12; index++) {
    await slider.press('ArrowRight');
    await expect.poll(async () => Number(await passageLine.getAttribute('data-passage-for')))
      .toBeGreaterThan(priorPageToken);
    priorPageToken = Number(await passageLine.getAttribute('data-passage-for'));
    await expectPassageFilledAndCentered(page);
  }
  expect(priorPageToken - firstWindow.forToken).toBeGreaterThan(200);
  expect(await page.evaluate(() =>
    (window as unknown as { __ttFooterCommits?: number }).__ttFooterCommits ?? 0))
    .toBe(sparklineCommits);

  const footerQueries = (await trace(page)).events.filter((event) =>
    event.direction === 'to-worker'
    && event.t === 'query'
    && event.op === 'reader-page');
  expect(footerQueries.length).toBeGreaterThan(0);

  for (const place of ['matches', 'vocabulary', 'compare', 'inputs'] as const) {
    await gotoPlace(page, place);
    await expect(footer).toBeVisible();
  }

  await page.getByRole('button', { name: /Open reader at .* token/ }).click();
  await expect(page.getByRole('main', { name: /Reader:/ })).toBeVisible();
  await expect(footer).toHaveCount(0);
  await page.getByRole('button', { name: 'back' }).click();
  await expect(footer).toBeVisible();
});

test('footer keyboard reading enters a cold corpus and exposes page, fine, and open actions', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const passage = page.locator('.footer-passage[data-passage-for]');
  await expect(slider).toHaveAttribute('aria-valuetext', 'no position');
  await slider.focus();
  await slider.press('l');
  await expect(slider).not.toHaveAttribute('aria-valuetext', 'no position');
  await expect(passage).toHaveAttribute('data-passage-for', '0');
  await expectSelectedInsidePassage(page);

  await slider.press('L');
  await expect(slider).toHaveAttribute('aria-valuenow', '1');
  await slider.press('H');
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await slider.press('Shift+ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '1');
  await slider.press('Shift+ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuenow', '0');

  const occurrenceMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await slider.press('w');
  await expect(footer.locator('.footer-reading-status'))
    .toContainText('next reference from any term');
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(0);
  const firstOccurrence = Number(await slider.getAttribute('aria-valuenow'));
  await slider.press('w');
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(firstOccurrence);
  await slider.press('b');
  await expect(slider).toHaveAttribute('aria-valuenow', String(firstOccurrence));
  expect((await trace(page)).events.filter((event) =>
    event.seq > occurrenceMark
    && event.direction === 'to-worker'
    && event.t === 'query'
    && event.op === 'occurrence-step')).toHaveLength(3);

  await slider.press('Enter');
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await expect(reader.getByRole('button', { name: 'previous reference' })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'next reference' })).toBeVisible();
  const readerProse = reader.locator('[data-reader-page]');
  await expect(readerProse).toHaveAttribute('data-reader-anchor', String(firstOccurrence));
  await reader.press('w');
  await expect.poll(async () => Number(await readerProse.getAttribute('data-reader-anchor')))
    .toBeGreaterThan(firstOccurrence);
  await reader.press('b');
  await expect(readerProse).toHaveAttribute('data-reader-anchor', String(firstOccurrence));
  await reader.getByRole('button', { name: 'back' }).click();
  await expect(slider).toBeFocused();
  await slider.press('o');
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: 'back' }).click();

  await page.reload();
  await awaitAllReady(page);
  const coldSlider = page.getByRole('slider', { name: 'Corpus footer position' });
  await coldSlider.focus();
  await coldSlider.press('ArrowLeft');
  await expect(coldSlider).not.toHaveAttribute('aria-valuetext', 'no position');
  await expect(coldSlider).toHaveAttribute(
    'aria-valuenow',
    await coldSlider.getAttribute('aria-valuemax') ?? '',
  );
});

test('a cold footer source request reports loading and offers a working retry', async ({ page }) => {
  await page.addInitScript(() => {
    const nativePostMessage = Worker.prototype.postMessage;
    let failFirstFooterPage = true;
    Worker.prototype.postMessage = function patchedPostMessage(
      message: unknown,
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      const envelope = message as {
        t?: string;
        query?: { op?: string; request?: { doc?: string } };
      };
      if (failFirstFooterPage && envelope.t === 'query' && envelope.query?.op === 'reader-page') {
        failFirstFooterPage = false;
        const broken = structuredClone(envelope);
        broken.query!.request!.doc = '__missing_footer_doc__';
        setTimeout(() => Reflect.apply(nativePostMessage, this, [broken]), 250);
        return;
      }
      Reflect.apply(
        nativePostMessage,
        this,
        transfer === undefined ? [message] : [message, transfer],
      );
    };
  });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(footer.getByText('loading source…', { exact: true })).toBeVisible();
  const retry = footer.getByRole('button', { name: 'retry', exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(footer.getByRole('button', { name: /Open reader at .* token/ })).toBeVisible({
    timeout: 15_000,
  });
});

test('Trends exposes footer reading keys without requiring footer focus', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const trendsSurface = page.getByRole('region', { name: 'Trends', exact: true });
  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const footerSlider = page.getByRole('slider', { name: 'Corpus footer position' });
  const trendSlider = page.getByRole('slider', { name: 'Reading position scrubber' });
  await expect(footerSlider).toBeVisible();
  await trendsSurface.focus();
  await trendsSurface.press('l');
  await expect(footerSlider).not.toHaveAttribute('aria-valuetext', 'no position');
  await expect(page.locator('.footer-passage[data-passage-for]')).toHaveAttribute(
    'data-passage-for',
    '0',
  );

  await trendSlider.focus();
  const beforeArrow = Number(await footerSlider.getAttribute('aria-valuenow'));
  await trendSlider.press('ArrowRight');
  await expect(footerSlider).toHaveAttribute('aria-valuenow', String(beforeArrow + 1));
  await trendSlider.press('l');
  await expect.poll(async () => Number(await footerSlider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(beforeArrow + 1);

  const presentation = page.getByRole('button', { name: 'separate', exact: true });
  await presentation.focus();
  await presentation.press('Enter');
  await expect(presentation).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);

  await presentation.press('o');
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await reader.press('Escape');
  await expect(trendsSurface).toBeFocused();
  await expect(footer).toBeVisible();
});

test('a mouse drag shuttles through source continuously and release pauses', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const box = await slider.boundingBox();
  if (!box) throw new Error('footer slider has no layout box');
  const anchorX = box.x + box.width * 0.3;
  const y = box.y + 5;

  await page.mouse.move(anchorX, y);
  await expect(page.getByRole('button', { name: /Open reader at .* token/ })).toBeVisible({
    timeout: 15_000,
  });
  await page.mouse.down();
  await page.mouse.move(anchorX + 24, y);
  await expect(slider).toHaveAttribute('data-shuttling', 'true');
  const anchored = Number(await slider.getAttribute('aria-valuenow'));
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')), {
    timeout: 5_000,
  }).toBeGreaterThan(anchored);

  await page.mouse.up();
  await expect(slider).not.toHaveAttribute('data-shuttling', 'true');
  const paused = Number(await slider.getAttribute('aria-valuenow'));
  await page.waitForTimeout(300);
  expect(Number(await slider.getAttribute('aria-valuenow'))).toBe(paused);

  // Native click/dblclick synthesis after real drags must never open Reader.
  for (let i = 0; i < 2; i++) {
    await page.mouse.move(anchorX, y);
    await page.mouse.down();
    await page.mouse.move(anchorX + 12, y);
    await page.waitForTimeout(60);
    await page.mouse.up();
  }
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);
});

test('passage text scrolls horizontally with a precise pointer', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const sliderBox = await slider.boundingBox();
  if (!sliderBox) throw new Error('footer slider has no layout box');
  await page.mouse.move(sliderBox.x + sliderBox.width * 0.4, sliderBox.y + 5);

  const passage = page.locator('.footer-passage-scrollable[data-passage-for]');
  await expect(passage).toBeVisible({ timeout: 15_000 });
  await expect(passage).toHaveCSS('overflow-x', 'auto');
  const passageBox = await passage.boundingBox();
  if (!passageBox) throw new Error('footer passage has no layout box');
  const metrics = await passage.evaluate((node) => ({
    before: node.scrollLeft,
    max: node.scrollWidth - node.clientWidth,
  }));
  expect(metrics.max).toBeGreaterThan(metrics.before);
  const corpusPosition = Number(await slider.getAttribute('aria-valuenow'));

  await page.mouse.move(
    passageBox.x + passageBox.width / 2,
    passageBox.y + passageBox.height / 2,
  );
  await page.mouse.wheel(120, 0);
  await expect.poll(() => passage.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(metrics.before);
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(corpusPosition);
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);
});

test('an exact footer barcode tick centers Matches without opening Reader', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'footer-ticks.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('the wolf ran. a fox saw the wolf sleep.\n', 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const band = footer.locator('canvas[data-barcode-band="series"]');
  await expect(band).toBeVisible();
  const box = await band.boundingBox();
  if (!box) throw new Error('footer barcode has no layout box');
  await band.click({ position: { x: box.width * (1 / 9), y: 3 } });

  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);
  await gotoPlace(page, 'matches');
  await expect(page.getByRole('grid', { name: 'Matches' })
    .locator('[role="row"][aria-selected="true"] .kwic-token-position'))
    .toHaveText('2 / 9', { timeout: 15_000 });
});

test('status and sparkline double-clicks open Reader at their raw corpus points', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'footer-reader.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('the wolf ran. a fox saw the wolf sleep.\n', 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const status = footer.locator('.footer-reading-status');
  const statusBox = await status.boundingBox();
  if (!statusBox) throw new Error('footer status has no layout box');

  await status.dblclick({
    position: { x: statusBox.width * (5.5 / 9), y: statusBox.height / 2 },
  });

  const reader = page.getByRole('main', { name: /Reader: footer-reader/ });
  await expect(reader).toBeVisible();
  await expect(reader.getByText('saw', { exact: true }))
    .toHaveCSS('text-decoration-line', 'underline');
  await reader.getByRole('button', { name: 'back' }).click();
  await expect(slider).toBeFocused();

  const sliderBox = await slider.boundingBox();
  const sparklineBox = await footer.locator('.footer-sparkline').boundingBox();
  if (!sliderBox || !sparklineBox) throw new Error('footer sparkline has no layout box');
  // This point is four pixels before wolf@1. A barcode lane would snap to
  // wolf, while the sparkline must retain the raw token 0 target (`the`).
  await slider.dblclick({
    position: {
      x: sliderBox.width * (1 / 9) - 4,
      y: sparklineBox.y - sliderBox.y + sparklineBox.height / 2,
    },
  });
  await expect(reader).toBeVisible();
  const articles = reader.locator('.source-text').getByText('the', { exact: true });
  await expect(articles).toHaveCount(1);
  await expect(articles.first()).toHaveCSS('text-decoration-line', 'underline');
});

test('a footer barcode double-click snaps to a nearby exact reference before opening Reader', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'footer-snap.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('the wolf ran. a fox saw the wolf sleep.\n', 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const band = footer.locator('canvas[data-barcode-band="series"]');
  const box = await band.boundingBox();
  if (!box) throw new Error('footer barcode has no layout box');

  // Four pixels before wolf@1 maps to token 0 on the raw axis, but remains
  // inside the exact barcode's eight-pixel snap tolerance.
  await page.mouse.move(box.x + box.width * (1 / 9) - 4, box.y + 3);
  // The retrying assertion spans the footer's 120ms entry dwell.
  await expect(slider).toHaveAttribute('aria-valuenow', '1');
  await band.dblclick({ position: { x: box.width * (1 / 9) - 4, y: 3 } });

  const reader = page.getByRole('main', { name: /Reader: footer-snap/ });
  await expect(reader).toBeVisible();
  const wolves = reader.locator('.source-text').getByText('wolf', { exact: true });
  await expect(wolves).toHaveCount(2);
  await expect(wolves.first()).toHaveCSS('text-decoration-line', 'underline');
  await expect(wolves.last()).not.toHaveCSS('text-decoration-line', 'underline');
});
