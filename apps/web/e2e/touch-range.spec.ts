import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  gotoPlace,
  trace,
} from './helpers.ts';

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 500 },
});

const CORPUS = Array.from(
  { length: 240 },
  (_, index) => (index % 17 === 0 ? 'Holmes' : `word${index}`),
).join(' ');

test('single touch reads and scrolls while two touches commit one range', async ({ page, context }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'inputs');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'touch-range.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(CORPUS, 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  const holmesRow = page.getByRole('list', { name: 'Term totals' })
    .getByRole('listitem').filter({ hasText: 'Holmes' });
  await expect(holmesRow.locator('[data-term-occurrence-count]')).toHaveText('15');

  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await expect(scrubber).toHaveCSS('touch-action', 'pan-y');
  await scrubber.evaluate((node) => {
    const probe = window as unknown as { __ttScrubberCaptures?: number };
    probe.__ttScrubberCaptures = 0;
    const original = node.setPointerCapture.bind(node);
    node.setPointerCapture = (pointerId: number) => {
      probe.__ttScrubberCaptures = (probe.__ttScrubberCaptures ?? 0) + 1;
      original(pointerId);
    };
  });

  const box = (await scrubber.boundingBox())!;
  const plotWidth = box.width;
  const point = (fraction: number) => ({
    x: box.x + plotWidth * fraction,
    y: box.y + box.height / 2,
  });

  await page.touchscreen.tap(point(0.25).x, point(0.25).y);
  await expect(scrubber).toHaveAttribute('aria-valuetext', /token \d+ of 240/);
  expect(await page.evaluate(
    () => (window as unknown as { __ttScrubberCaptures?: number }).__ttScrubberCaptures,
  )).toBe(0);
  await expect(page.getByRole('button', { name: 'select range' })).toHaveCount(0);
  await expect(page.getByText(/arrows step by token/i)).toHaveCount(0);
  expect(await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))).toEqual({ client: 390, scroll: 390 });

  // A stationary hold exposes the single-pointer, non-path alternative.
  const singlePointer = (
    pointerId: number,
    position: { readonly x: number; readonly y: number },
    isPrimary = true,
  ) => ({
    pointerId,
    pointerType: 'touch',
    isPrimary,
    button: 0,
    buttons: 1,
    clientX: position.x,
    clientY: position.y,
  });
  const anchor = point(0.3);
  await scrubber.dispatchEvent('pointerdown', singlePointer(21, anchor));
  await expect(page.getByText(/^Range start set at/)).toBeVisible({ timeout: 2_000 });
  await scrubber.dispatchEvent('pointerup', {
    ...singlePointer(21, anchor),
    buttons: 0,
  });
  await expect(page.getByRole('button', { name: 'cancel range' })).toBeVisible();
  const endpoint = point(0.55);
  const singleCommitMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scrubber.dispatchEvent('pointerdown', singlePointer(22, endpoint));
  await scrubber.dispatchEvent('pointerup', {
    ...singlePointer(22, endpoint),
    buttons: 0,
  });
  await expect(page.getByTestId('linked-selection')).toBeVisible();
  await expect(page.getByRole('button', { name: 'clear selection' })).toBeVisible();
  await expect.poll(async () => new Set(
    (await trace(page)).events
      .filter(
        (event) => event.seq > singleCommitMark
          && event.direction === 'to-worker'
          && event.t === 'query',
      )
      .map((event) => event.op),
  )).toEqual(new Set(['trend', 'dispersion', 'inventory', 'freq-list']));

  const handles = scrubber.locator('[data-range-handle]');
  await expect(handles).toHaveCount(2);
  for (const edge of ['start', 'end'] as const) {
    const handleBox = await scrubber.locator(`[data-range-handle="${edge}"]`).boundingBox();
    expect(handleBox?.width).toBeGreaterThanOrEqual(44);
    expect(handleBox?.height).toBeGreaterThanOrEqual(44);
  }
  const committedBeforeHandle = (await page.getByTestId('linked-selection').boundingBox())!;
  const endHandle = scrubber.locator('[data-range-handle="end"]');
  const initialEndHandleBox = (await endHandle.boundingBox())!;
  await page.evaluate((top) => window.scrollBy(0, top - 160), initialEndHandleBox.y);
  const endHandleBox = (await endHandle.boundingBox())!;
  const handlePoint = {
    x: endHandleBox.x + 4,
    y: endHandleBox.y + endHandleBox.height / 2,
  };
  expect(await page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest('[data-range-handle]')
      ?.getAttribute('data-range-handle') ?? null, handlePoint)).toBe('end');
  const cdp = await context.newCDPSession(page);
  const handleMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ id: 23, ...handlePoint, radiusX: 2, radiusY: 2, force: 1 }],
  });
  await expect(endHandle).toHaveAttribute('data-dragging', 'true');
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{
      id: 23,
      x: handlePoint.x + 70,
      y: handlePoint.y,
      radiusX: 2,
      radiusY: 2,
      force: 1,
    }],
  });
  await expect(endHandle).toHaveAttribute('data-dragging', 'true');
  await expect(page.getByTestId('selection-preview')).toBeVisible();
  expect((await trace(page)).events.filter((event) =>
    event.seq > handleMark
    && event.direction === 'to-worker'
    && event.t === 'query')).toEqual([]);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByTestId('selection-preview')).toHaveCount(0);
  await expect.poll(async () => (await page.getByTestId('linked-selection').boundingBox())?.width ?? 0)
    .toBeGreaterThan(committedBeforeHandle.width);
  await expect.poll(async () => new Set(
    (await trace(page)).events
      .filter(
        (event) => event.seq > handleMark
          && event.direction === 'to-worker'
          && event.t === 'query',
      )
      .map((event) => event.op),
  )).toEqual(new Set(['trend', 'dispersion', 'inventory', 'freq-list']));
  await page.getByRole('button', { name: 'clear selection' }).click();
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);

  const rangeBox = (await scrubber.boundingBox())!;
  const touchPoint = (id: number, fraction: number) => ({
    id,
    x: Math.round(rangeBox.x + rangeBox.width * fraction),
    y: Math.round(rangeBox.y + Math.min(80, rangeBox.height / 2)),
    radiusX: 2,
    radiusY: 2,
    force: 1,
  });
  const first = touchPoint(1, 0.2);
  let second = touchPoint(2, 0.65);
  const capturesBeforeMulti = await page.evaluate(
    () => (window as unknown as { __ttScrubberCaptures?: number }).__ttScrubberCaptures ?? 0,
  );
  const rangeMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [first, second],
  });
  await expect(page.getByTestId('selection-preview')).toBeVisible();
  expect(await page.evaluate(
    () => (window as unknown as { __ttScrubberCaptures?: number }).__ttScrubberCaptures,
  )).toBe(capturesBeforeMulti + 2);

  const initialPreview = (await page.getByTestId('selection-preview').boundingBox())!;
  second = touchPoint(2, 0.8);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [first, second],
  });
  await expect.poll(async () => (await page.getByTestId('selection-preview').boundingBox())?.width ?? 0)
    .toBeGreaterThan(initialPreview.width);

  const previewQueries = (await trace(page)).events.filter(
    (event) =>
      event.seq > rangeMark
      && event.direction === 'to-worker'
      && event.t === 'query'
      && ['trend', 'dispersion', 'inventory', 'freq-list'].includes(event.op ?? ''),
  );
  expect(previewQueries).toEqual([]);

  const commitMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect(page.getByTestId('selection-preview')).toHaveCount(0);
  await expect(page.getByTestId('linked-selection')).toBeVisible();
  await expect(page.getByRole('button', { name: 'clear selection' })).toBeVisible();
  const required = ['trend', 'dispersion', 'inventory', 'freq-list'];
  await expect.poll(async () => new Set(
    (await trace(page)).events
      .filter(
        (event) =>
          event.seq > commitMark
          && event.direction === 'to-worker'
          && event.t === 'query',
      )
      .map((event) => event.op),
  )).toEqual(new Set(required));
  await page.getByRole('button', { name: 'clear selection' }).click();
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);

  // A real touch drag beginning over the chart remains page-owned vertically.
  await scrubber.scrollIntoViewIfNeeded();
  const liveBox = (await scrubber.boundingBox())!;
  const scroll = await page.evaluate(() => ({
    before: window.scrollY,
    max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  }));
  const dragDirection = scroll.before < scroll.max ? -1 : 1;
  const x = Math.round(liveBox.x + Math.min(plotWidth * 0.5, liveBox.width / 2));
  const y = Math.round(liveBox.y + 100);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x, y: y + dragDirection * 60 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x, y: y + dragDirection * 120 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).not.toBe(scroll.before);
});
