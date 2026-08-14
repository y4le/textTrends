import { expect, test } from '@playwright/test';
import { awaitAllReady, trace } from './helpers.ts';

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 500 },
});

const pointer = (
  pointerId: number,
  x: number,
  y: number,
  isPrimary = true,
) => ({
  pointerId,
  pointerType: 'touch',
  isPrimary,
  button: 0,
  buttons: 1,
  clientX: x,
  clientY: y,
});

test('footer touch is direct, axis-locked, multi-touch-safe, and never shuttles', async ({
  page,
}) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  await expect(slider).toHaveCSS('touch-action', 'none');
  const box = await slider.boundingBox();
  if (!box) throw new Error('footer slider has no layout box');
  const y = box.y + Math.min(5, box.height / 2);
  const x = (fraction: number) => box.x + box.width * fraction;

  await slider.dispatchEvent('pointerdown', pointer(1, x(0.2), y));
  await slider.dispatchEvent('pointerup', {
    ...pointer(1, x(0.2), y),
    buttons: 0,
  });
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(0);

  const beforeDrag = Number(await slider.getAttribute('aria-valuenow'));
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await slider.dispatchEvent('pointerdown', pointer(2, x(0.25), y));
  await slider.dispatchEvent('pointermove', pointer(2, x(0.75), y + 1));
  await expect(slider).toHaveAttribute('data-touch-scrubbing', 'true');
  await expect(slider).not.toHaveAttribute('data-shuttling', 'true');
  await expect(footer.getByTestId('footer-cursor')).toHaveCSS('width', '3px');
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(beforeDrag);
  const duringDrag = Number(await slider.getAttribute('aria-valuenow'));
  await slider.dispatchEvent('pointerup', {
    ...pointer(2, x(0.8), y + 1),
    buttons: 0,
  });
  await expect(slider).not.toHaveAttribute('data-touch-scrubbing', 'true');
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(duringDrag);
  const afterDrag = Number(await slider.getAttribute('aria-valuenow'));
  const analyticalQueries = (await trace(page)).events.filter((event) =>
    event.seq > mark
    && event.direction === 'to-worker'
    && event.t === 'query'
    && ['trend', 'dispersion', 'inventory', 'freq-list'].includes(event.op ?? ''));
  expect(analyticalQueries).toEqual([]);

  await slider.dispatchEvent('pointerdown', pointer(3, x(0.4), y));
  await slider.dispatchEvent('pointermove', pointer(3, x(0.405), y - 40));
  await slider.dispatchEvent('pointerup', {
    ...pointer(3, x(0.405), y - 40),
    buttons: 0,
  });
  expect(Number(await slider.getAttribute('aria-valuenow'))).toBe(afterDrag);

  await slider.dispatchEvent('pointerdown', pointer(4, x(0.3), y));
  await slider.dispatchEvent('pointerdown', pointer(5, x(0.7), y, false));
  await slider.dispatchEvent('pointermove', pointer(4, x(0.1), y));
  await slider.dispatchEvent('pointerup', {
    ...pointer(5, x(0.7), y, false),
    buttons: 0,
  });
  await slider.dispatchEvent('pointerup', {
    ...pointer(4, x(0.1), y),
    buttons: 0,
  });
  expect(Number(await slider.getAttribute('aria-valuenow'))).toBe(afterDrag);

  await slider.dispatchEvent('pointerdown', pointer(6, x(0.5), y));
  await slider.dispatchEvent('pointerup', {
    ...pointer(6, x(0.5), y),
    buttons: 0,
  });
  await footer.dispatchEvent('dblclick', {
    button: 0,
    buttons: 0,
    clientX: x(0.5),
    clientY: y,
    detail: 2,
  });
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);
});

test('the footer resize handle accepts a direct touch drag', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'CDP supplies a real touch stream');
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const handle = page.getByRole('separator', { name: 'Resize reading footer' });
  await expect(handle).toHaveCSS('touch-action', 'none');
  const [before, handleBox] = await Promise.all([
    footer.boundingBox(),
    handle.boundingBox(),
  ]);
  if (!before || !handleBox) throw new Error('touch resize geometry is unavailable');
  const point = {
    x: Math.round(handleBox.x + handleBox.width / 2),
    y: Math.round(handleBox.y + handleBox.height / 2),
  };
  const pageY = await page.evaluate(() => window.scrollY);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [point],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...point, y: point.y - 48 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  await expect.poll(async () => (await footer.boundingBox())?.height)
    .toBe(before.height + 48);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageY);
});

test('passage text pans freely and advances the shared corpus position', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'CDP supplies a real momentum-capable touch stream');
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const sliderBox = await slider.boundingBox();
  if (!sliderBox) throw new Error('footer slider has no layout box');
  await page.touchscreen.tap(sliderBox.x + sliderBox.width / 2, sliderBox.y + 5);

  const passage = page.locator('.footer-passage-coarse[data-passage-for]');
  await expect(passage).toBeVisible({ timeout: 15_000 });
  await expect(passage).toHaveCSS('touch-action', 'pan-x pinch-zoom');
  const passageBox = await passage.boundingBox();
  if (!passageBox) throw new Error('footer passage has no layout box');
  const metrics = await passage.evaluate((node) => ({
    before: node.scrollLeft,
    max: node.scrollWidth - node.clientWidth,
  }));
  expect(metrics.max).toBeGreaterThan(metrics.before);
  const corpusPosition = Number(await slider.getAttribute('aria-valuenow'));
  const pageY = await page.evaluate(() => window.scrollY);
  const point = {
    x: Math.round(passageBox.x + passageBox.width * 0.7),
    y: Math.round(passageBox.y + passageBox.height / 2),
  };
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [point],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...point, x: point.x - 70 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...point, x: point.x - 130 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => passage.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(metrics.before);
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(corpusPosition);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageY);
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);
});

test('scrolling to resident text edges loads another source window without blank space', async ({
  page,
}) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const sliderBox = await slider.boundingBox();
  if (!sliderBox) throw new Error('footer slider has no layout box');
  await page.touchscreen.tap(sliderBox.x + sliderBox.width / 2, sliderBox.y + 5);

  const passage = page.locator('.footer-passage-coarse[data-passage-for]');
  await expect(passage).toBeVisible({ timeout: 15_000 });
  const initial = await passage.evaluate((node) => ({
    start: Number(node.getAttribute('data-passage-page-start')),
    end: Number(node.getAttribute('data-passage-page-end')),
    position: Number(document.querySelector('[aria-label="Corpus footer position"]')
      ?.getAttribute('aria-valuenow')),
  }));
  const readerQueries = () => trace(page).then(({ events }) => events.filter((event) =>
    event.direction === 'to-worker'
    && event.t === 'query'
    && event.op === 'reader-page').length);
  const queryCount = await readerQueries();

  await passage.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(initial.position);
  await expect.poll(readerQueries).toBeGreaterThan(queryCount);
  await expect.poll(async () => ({
    start: Number(await passage.getAttribute('data-passage-page-start')),
    end: Number(await passage.getAttribute('data-passage-page-end')),
  })).not.toEqual({ start: initial.start, end: initial.end });
  const forward = {
    start: Number(await passage.getAttribute('data-passage-page-start')),
    position: Number(await slider.getAttribute('aria-valuenow')),
    queryCount: await readerQueries(),
  };

  const fill = await passage.evaluate((node) => {
    const port = node.getBoundingClientRect();
    const text = node.querySelector('.footer-passage-text')?.getBoundingClientRect();
    return text ? {
      leftGap: Math.max(0, text.left - port.left),
      rightGap: Math.max(0, port.right - text.right),
    } : null;
  });
  expect(fill).not.toBeNull();
  expect(fill!.leftGap).toBeLessThanOrEqual(1);
  expect(fill!.rightGap).toBeLessThanOrEqual(1);

  await passage.evaluate((node) => { node.scrollLeft = 0; });
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeLessThan(forward.position);
  await expect.poll(readerQueries).toBeGreaterThan(forward.queryCount);
  await expect.poll(async () => Number(await passage.getAttribute('data-passage-page-start')))
    .toBeLessThan(forward.start);
});

test('vertical touches on the scrub and tag bars do not scroll the page', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'CDP supplies the browser-owned scroll proof');
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const tagPort = page.getByRole('group', { name: 'Query terms' });
  const dock = page.locator('.workbench-dock');
  await expect(slider).toHaveCSS('touch-action', 'none');
  await expect(tagPort).toHaveCSS('touch-action', 'pan-x');
  await expect(dock).toHaveCSS('touch-action', 'pan-x pinch-zoom');
  const cdp = await context.newCDPSession(page);
  for (const [label, target] of [['scrub', slider], ['tag', tagPort]] as const) {
    const box = await target.boundingBox();
    if (!box) throw new Error('dock touch target has no layout box');
    const before = await page.evaluate(() => window.scrollY);
    const max = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight));
    const direction = before < max ? -1 : 1;
    const point = {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + Math.min(8, box.height / 2)),
    };
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [point],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ ...point, y: point.y + direction * 60 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ ...point, y: point.y + direction * 120 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.scrollY), `${label} bar moved the page`).toBe(before);
  }
});
