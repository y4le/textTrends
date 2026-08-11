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
  await awaitAllReady(page);

  const footer = page.getByRole('complementary', { name: 'Reading position' });
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  await expect(slider).toHaveCSS('touch-action', 'pan-y pinch-zoom');
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

test('a real vertical touch beginning on the footer remains page-owned', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'CDP supplies the browser-owned scroll proof');
  await page.goto('./');
  await awaitAllReady(page);
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  const box = await slider.boundingBox();
  if (!box) throw new Error('footer slider has no layout box');
  const before = await page.evaluate(() => window.scrollY);
  const max = await page.evaluate(() =>
    Math.max(0, document.documentElement.scrollHeight - window.innerHeight));
  const direction = before < max ? -1 : 1;
  const point = {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + Math.min(5, box.height / 2)),
  };
  const cdp = await context.newCDPSession(page);
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
  await expect.poll(() => page.evaluate(() => window.scrollY)).not.toBe(before);
});
