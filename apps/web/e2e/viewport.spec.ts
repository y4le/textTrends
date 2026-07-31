/**
 * Dynamic-viewport contract. Playwright cannot raise an OS keyboard, so the
 * resizes-visual case shadows the VisualViewport geometry consumed by the app.
 * The WebKit project proves that contract in a real WebKit engine; it is not a
 * claim about iOS Safari's platform keyboard or fixed-position quirks.
 */

import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  simulateKeyboard,
  simulatePinchZoom,
  trace,
} from './helpers.ts';

function queriesAfter(
  events: Awaited<ReturnType<typeof trace>>['events'],
  mark: number,
) {
  return events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  );
}

async function keyboardInset(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset').trim());
}

async function expectAboveOccludedBand(
  page: import('@playwright/test').Page,
  locator: import('@playwright/test').Locator,
  occlusion: number,
) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const innerHeight = await page.evaluate(() => window.innerHeight);
  expect(box!.y + box!.height).toBeLessThanOrEqual(innerHeight - occlusion + 1);
}

test('full-height editors honor resizes-visual geometry without losing draft or issuing work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);

  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('viewport-fit=cover');
  expect(viewport).toContain('interactive-widget=resizes-content');
  expect(viewport).not.toContain('user-scalable=no');
  expect(viewport).not.toContain('maximum-scale');

  const css = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')?.href;
    if (!href) throw new Error('production stylesheet link is missing');
    return (await fetch(href)).text();
  });
  for (const rule of [
    /\.workbench-sheet\{[^}]*block-size:28vh;block-size:28dvh/,
    /\.workbench-sheet\[data-detent=half\]\{[^}]*block-size:58vh;block-size:58dvh/,
    /\.workbench-sheet\[data-detent=tall\]\{[^}]*block-size:88vh;block-size:88dvh/,
    /\.reader-region\[data-slot=viewport\]\{[^}]*block-size:100vh;[^}]*block-size:100dvh/,
    /\.form-layer\{[^}]*min-block-size:100vh;min-block-size:100dvh/,
    /\.query-editor-form\{[^}]*min-block-size:calc\(100vh[^;]+;min-block-size:calc\(100dvh/,
    /\.form-layer \.group-editor\{[^}]*min-block-size:calc\(100vh[^;]+;min-block-size:calc\(100dvh/,
  ]) {
    expect(css).toMatch(rule);
  }

  await page.getByRole('button', { name: 'Edit members: Holmes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Query editor: Holmes' });
  const draft = dialog.getByRole('textbox', { name: /Add member to Holmes/ });
  await draft.fill('watson');
  await draft.focus();
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await simulateKeyboard(page, 284);
  await expect.poll(() => keyboardInset(page)).toBe('284px');
  await expect(draft).toHaveValue('watson');
  await expect(draft).toBeFocused();
  await expectAboveOccludedBand(page, draft, 284);
  await expectAboveOccludedBand(
    page,
    dialog.getByRole('button', { name: 'Apply changes to Holmes' }),
    284,
  );
  await expectAboveOccludedBand(
    page,
    dialog.getByRole('button', { name: 'Cancel editing Holmes' }),
    284,
  );
  const compactOverflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(compactOverflow.document).toBeLessThanOrEqual(compactOverflow.client);
  expect(compactOverflow.body).toBeLessThanOrEqual(compactOverflow.client);
  expect(queriesAfter((await trace(page)).events, mark)).toEqual([]);

  await simulatePinchZoom(page, 2);
  await expect.poll(() => keyboardInset(page)).toBe('0px');
  await simulatePinchZoom(page, 1);
  await expect.poll(() => keyboardInset(page)).toBe('284px');
  await simulateKeyboard(page, 0);
  await expect.poll(() => keyboardInset(page)).toBe('0px');
  await expect(draft).toHaveValue('watson');

  await page.setViewportSize({ width: 568, height: 320 });
  await simulateKeyboard(page, 180);
  const overflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.client);
  expect(overflow.body).toBeLessThanOrEqual(overflow.client);
  expect(queriesAfter((await trace(page)).events, mark)).toEqual([]);
});

test('Chromium resizes-content uses dvh once and preserves the open draft', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'interactive-widget resizes-content is the Chromium model');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await page.getByRole('button', { name: 'Edit members: Holmes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Query editor: Holmes' });
  const draft = dialog.getByRole('textbox', { name: /Add member to Holmes/ });
  await draft.fill('watson');
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await page.setViewportSize({ width: 390, height: 400 });
  await expect.poll(() => keyboardInset(page)).toBe('0px');
  await expect(draft).toHaveValue('watson');
  await expectAboveOccludedBand(
    page,
    dialog.getByRole('button', { name: 'Apply changes to Holmes' }),
    0,
  );
  await expectAboveOccludedBand(
    page,
    dialog.getByRole('button', { name: 'Cancel editing Holmes' }),
    0,
  );
  expect(queriesAfter((await trace(page)).events, mark)).toEqual([]);
});
