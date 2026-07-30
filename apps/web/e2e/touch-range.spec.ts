import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  trace,
} from './helpers.ts';
import { TREND_LABEL_SPACE } from '../src/lib/trend-geometry.ts';

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

const CORPUS = Array.from(
  { length: 240 },
  (_, index) => (index % 17 === 0 ? 'Holmes' : `word${index}`),
).join(' ');

test('touch reads by default and commits only through explicit range mode', async ({ page, context }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'touch-range.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(CORPUS, 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await expect(page.getByText('Holmes: 15 occurrences', { exact: true })).toBeVisible();

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
  const plotWidth = box.width - TREND_LABEL_SPACE;
  const point = (fraction: number) => ({
    x: box.x + plotWidth * fraction,
    y: box.y + 80,
  });

  await page.touchscreen.tap(point(0.25).x, point(0.25).y);
  await expect(page.getByRole('button', { name: /Pin passage at token/ })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Scope' }).getByText('0 of 8 pinned', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(
    () => (window as unknown as { __ttScrubberCaptures?: number }).__ttScrubberCaptures,
  )).toBe(0);

  await page.getByRole('button', { name: 'select range' }).click();
  const controls = page.getByRole('group', { name: 'Range selection controls' });
  await expect(controls).toBeVisible();
  await expect(page.locator('[data-range-handle="start"]')).toHaveCount(0);
  await expect(page.locator('[data-range-handle="end"]')).toBeVisible();
  await expect(page.getByTestId('range-draft')).toBeVisible();
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  expect(await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))).toEqual({ client: 390, scroll: 390 });

  // Cancel is entirely local: the draft disappears, no committed selection
  // appears, and entering the mode again starts from the live cursor.
  await controls.getByRole('button', { name: 'cancel' }).click();
  await expect(controls).toHaveCount(0);
  await expect(page.getByTestId('range-draft')).toHaveCount(0);
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await page.getByRole('button', { name: 'select range' }).click();

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const rangeBox = (await scrubber.boundingBox())!;
  const livePoint = {
    x: rangeBox.x + (rangeBox.width - TREND_LABEL_SPACE) * 0.7,
    y: rangeBox.y + 80,
  };
  await page.touchscreen.tap(livePoint.x, livePoint.y);
  await expect(page.locator('[data-range-handle="start"]')).toBeVisible();
  await expect(page.locator('[data-range-handle="end"]')).toBeVisible();
  await controls.getByRole('button', { name: 'Move range start forward one token' }).click();
  await expect(page.getByText(/Range draft in touch-range, tokens/)).toBeVisible();

  const beforeUse = await trace(page);
  const draftOps = beforeUse.events
    .filter(
      (event) =>
        event.seq > mark
        && event.direction === 'to-worker'
        && event.t === 'query',
    )
    .map((event) => event.op);
  // Moving the reading cursor may re-center KWIC or fetch a passage. The
  // range draft itself must not issue any scope-changing operation.
  const prohibitedBeforeUse = draftOps.filter(
    (op) => ['trend', 'dispersion', 'inventory', 'freq-list'].includes(op ?? ''),
  );
  expect(prohibitedBeforeUse).toHaveLength(0);
  expect(draftOps.every((op) => op === 'kwic' || op === 'passage')).toBe(true);

  const handle = page.locator('[data-range-handle="start"]');
  await handle.evaluate((node) => {
    const probe = window as unknown as { __ttHandleCaptures?: number };
    probe.__ttHandleCaptures = 0;
    const original = node.setPointerCapture.bind(node);
    node.setPointerCapture = (pointerId: number) => {
      probe.__ttHandleCaptures = (probe.__ttHandleCaptures ?? 0) + 1;
      original(pointerId);
    };
  });
  const handleBox = (await handle.boundingBox())!;
  await page.touchscreen.tap(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  expect(await page.evaluate(
    () => (window as unknown as { __ttHandleCaptures?: number }).__ttHandleCaptures,
  )).toBe(1);
  expect(await page.evaluate(
    () => (window as unknown as { __ttScrubberCaptures?: number }).__ttScrubberCaptures,
  )).toBe(0);

  const useMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await controls.getByRole('button', { name: 'use range' }).click();
  await expect(page.getByTestId('range-draft')).toHaveCount(0);
  await expect(page.getByText(/Selected .* tokens in touch-range/)).toBeVisible();
  await expect(page.getByTestId('linked-selection')).toBeVisible();
  const required = ['trend', 'dispersion', 'kwic', 'inventory', 'freq-list'];
  await expect
    .poll(async () => {
      const snapshot = await trace(page);
      return new Set(
        snapshot.events
          .filter(
            (event) =>
              event.seq > useMark
              && event.direction === 'to-worker'
              && event.t === 'query',
          )
          .map((event) => event.op),
      );
    })
    .toEqual(new Set(required));
  const afterUse = await trace(page);
  const unexpected = afterUse.events.filter(
    (event) =>
      event.seq > useMark
      && event.direction === 'to-worker'
      && event.t === 'query'
      && !required.includes(event.op ?? ''),
  );
  expect(unexpected).toHaveLength(0);

  // A real touch drag beginning over the chart remains page-owned vertically.
  await scrubber.scrollIntoViewIfNeeded();
  const liveBox = (await scrubber.boundingBox())!;
  const beforeScroll = await page.evaluate(() => window.scrollY);
  const cdp = await context.newCDPSession(page);
  const x = Math.round(liveBox.x + Math.min(plotWidth * 0.5, liveBox.width / 2));
  const y = Math.round(liveBox.y + 100);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x, y: y - 60 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x, y: y - 120 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x, y: y - 180 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeScroll);
});
