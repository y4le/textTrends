import { expect, test, type Locator, type Page } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { awaitAllReady, trace } from './helpers.ts';

async function openReader(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await awaitAllReady(page);
  await page.getByRole('navigation', { name: 'Analysis lenses' })
    .getByRole('link', { name: 'Concordance', exact: true }).click();
  const read = page.getByRole('table', { name: 'Concordance' })
    .getByRole('button').first();
  await expect(read).toBeVisible();
  await read.click();
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader.locator('[data-reader-page]')).toBeVisible();
  return { read, reader };
}

function workerQueriesAfter(
  events: Awaited<ReturnType<typeof trace>>['events'],
  mark: number,
) {
  return events.filter((event) =>
    event.seq > mark && event.direction === 'to-worker' && event.t === 'query');
}

async function expectNoBodyOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    documentClient: document.documentElement.clientWidth,
    documentScroll: document.documentElement.scrollWidth,
    bodyClient: document.body.clientWidth,
    bodyScroll: document.body.scrollWidth,
  }));
  expect(widths.documentScroll).toBeLessThanOrEqual(widths.documentClient);
  expect(widths.bodyScroll).toBeLessThanOrEqual(widths.bodyClient);
}

async function expectReaderFillsViewport(
  page: Page,
  reader: Locator,
  width: number,
  height: number,
) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const box = await reader.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeCloseTo(0, 0);
  expect(box!.y).toBeCloseTo(0, 0);
  expect(box!.width).toBeCloseTo(width, 0);
  expect(box!.height).toBeCloseTo(height, 0);
  const pane = reader.locator('.reader-prose-pane');
  await expect.poll(async () => {
    const published = await reader.getAttribute('data-reader-fit-size');
    const current = await pane.evaluate(
      (element) => `${element.clientWidth}x${element.clientHeight}`,
    );
    return published === current;
  }).toBe(true);
  await expect(reader.getByRole('navigation', { name: 'Reader navigation' })).toBeVisible();
  await expect(pane).not.toHaveAttribute('data-reader-fitting');
  await expectNoBodyOverflow(page);
}

function parseReaderRange(value: string | null): readonly [number, number] {
  const match = /^(\d+):(\d+)$/.exec(value ?? '');
  expect(match).not.toBeNull();
  return [Number(match![1]), Number(match![2])];
}

async function dispatchReaderPointer(
  target: Locator,
  pointerType: 'touch' | 'mouse',
  from: { readonly x: number; readonly y: number },
  to = from,
) {
  const init = {
    pointerType,
    pointerId: 7,
    isPrimary: true,
    button: 0,
  };
  await target.dispatchEvent('pointerdown', { ...init, clientX: from.x, clientY: from.y });
  await target.dispatchEvent('pointerup', { ...init, clientX: to.x, clientY: to.y });
}

async function settledReaderRange(reader: Locator): Promise<readonly [number, number]> {
  const pane = reader.locator('.reader-prose-pane');
  await expect(pane).not.toHaveAttribute('data-reader-fitting');
  return parseReaderRange(
    await reader.locator('[data-reader-page]').getAttribute('data-reader-page'),
  );
}

test('the lazy Reader fallback is titled, nonblank, and can go back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const dist = fileURLToPath(new URL('../dist/assets/', import.meta.url));
  const readerChunk = readdirSync(dist).find(
    (file) => file.endsWith('.js') && readFileSync(`${dist}${file}`, 'utf8').includes('Loading reader page'),
  );
  expect(readerChunk, 'dist contains a distinct Reader chunk').toBeTruthy();
  const gate: { release?: () => void } = {};
  await page.route(`**/assets/${readerChunk}`, (route) => new Promise<void>((resolve) => {
    gate.release = () => {
      void route.continue().finally(resolve);
    };
  }));
  await page.goto('./');
  await awaitAllReady(page);
  await page.getByRole('navigation', { name: 'Analysis lenses' })
    .getByRole('link', { name: 'Concordance', exact: true }).click();
  await page.getByRole('table', { name: 'Concordance' })
    .getByRole('button').first().click();
  const fallback = page.getByRole('main', { name: /Reader:/ });
  await expect(fallback.getByRole('status', { name: 'Reader keyboard status' })).toHaveCount(1);
  await expect(fallback.locator('p.reader-position')).toHaveText('loading reader…');
  await fallback.getByRole('button', { name: 'back', exact: true }).click();
  await expect(fallback).toHaveCount(0);
  await expect(page.locator('.app-header')).toBeVisible();
  gate.release?.();
});

test('Reader has one full-viewport presentation without mode or background work', async ({ page }) => {
  const { read, reader } = await openReader(page);

  await expect(reader).not.toHaveAttribute('role', 'dialog');
  await expect(reader.getByRole('group', { name: 'Reader width' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Terms' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Analysis lenses' })).toHaveCount(0);
  await expect(page.locator('.app-header')).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'back', exact: true })).toBeVisible();
  await expectReaderFillsViewport(page, reader, 1440, 900);

  await page.goBack();
  await expect(reader).toHaveCount(0);
  await expect(read).toBeFocused();
  await expect(page.locator('html')).not.toHaveClass(/reader-open/);
  await page.goForward();
  await expect(page.getByRole('main', { name: /Reader:/ })).toBeVisible();
});

test('Reader stays viewport-bound and locks outer scrolling at iPad and phone widths', async ({
  page,
  browserName,
}) => {
  const { reader } = await openReader(page);
  const pageRange = await reader.locator('[data-reader-page]').getAttribute('data-reader-page');
  await reader.evaluate((element) => { element.dataset.ttProbe = 'reader-stays-mounted'; });
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await expectReaderFillsViewport(page, reader, 768, 1024);
  await expect(reader).not.toHaveAttribute('role', 'dialog');
  await expect(reader).toHaveAttribute('data-tt-probe', 'reader-stays-mounted');
  await expect(reader).not.toHaveAttribute('aria-modal');
  await expect(page.locator('html')).toHaveClass(/reader-open/);
  expect(await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).overflowY,
    body: getComputedStyle(document.body).overflowY,
  }))).toEqual({ html: 'hidden', body: 'hidden' });

  if (browserName === 'chromium') {
    const beforeOuterScroll = await page.evaluate(() => window.scrollY);
    const header = await reader.locator('.reader-header').boundingBox();
    expect(header).not.toBeNull();
    await page.mouse.move(header!.x + 8, header!.y + 8);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(beforeOuterScroll);
  }
  await expectReaderFillsViewport(page, reader, 768, 1024);

  await expectReaderFillsViewport(page, reader, 390, 844);
  await expect(page.getByRole('region', { name: 'Scope' })).toHaveCount(0);
  await expect(page.locator('.sheet-scrim')).toHaveCount(0);
  await expect(page.locator('[inert]')).toHaveCount(0);
  expect(await page.locator('main button, main a, main input, main select, main textarea')
    .evaluateAll((elements, readerId) => elements.every(
      (element) => element.closest(`#${readerId}`) !== null,
    ), 'reader-region')).toBe(true);
  await expect(reader).toBeFocused();
  const pane = reader.locator('.reader-prose-pane');
  expect(await pane.evaluate(
    (element) => getComputedStyle(element).overflowY,
  )).toBe('hidden');
  expect(await reader.evaluate((element) => getComputedStyle(element).overflowY)).toBe('hidden');
  expect(await reader.evaluate((element) => getComputedStyle(element).touchAction)).not.toBe('none');
  expect(await reader.locator('[data-reader-page]').evaluate(
    (element) => {
      const style = getComputedStyle(element);
      // WebKit exposes this computed value only through its prefixed property.
      return style.getPropertyValue('user-select')
        || style.getPropertyValue('-webkit-user-select');
    },
  )).toBe('text');
  const fit = await pane.evaluate((element) => {
    const pageElement = element.querySelector<HTMLElement>('[data-reader-page]');
    const paneRect = element.getBoundingClientRect();
    const pageRect = pageElement?.getBoundingClientRect();
    return {
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      pageBottom: pageRect?.bottom ?? Number.POSITIVE_INFINITY,
      paneBottom: paneRect.bottom,
    };
  });
  expect(fit.pageBottom).toBeLessThanOrEqual(fit.paneBottom + 0.5);
  expect(fit.scrollHeight).toBeLessThanOrEqual(fit.clientHeight + 1);
  const compactRange = parseReaderRange(
    await reader.locator('[data-reader-page]').getAttribute('data-reader-page'),
  );
  const initialRange = parseReaderRange(pageRange);
  expect(compactRange[0]).toBe(initialRange[0]);
  expect(compactRange[1]).toBeLessThan(initialRange[1]);

  await expectReaderFillsViewport(page, reader, 320, 800);
  await expectReaderFillsViewport(page, reader, 1440, 900);
  await expect(reader).not.toHaveAttribute('role', 'dialog');
  await expect(reader).toHaveAttribute('data-tt-probe', 'reader-stays-mounted');
  await expect(reader.locator('[data-reader-page]')).toHaveAttribute('data-reader-page', pageRange!);
  expect(workerQueriesAfter((await trace(page)).events, mark)).toEqual([]);
});

test('touch edge taps turn fitted pages without stealing text interaction', async ({ page }) => {
  const { reader } = await openReader(page);
  await expectReaderFillsViewport(page, reader, 390, 844);
  const pane = reader.locator('.reader-prose-pane');
  const box = await reader.boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height / 2;
  const left = { x: box!.x + 4, y };
  const center = { x: box!.x + box!.width / 2, y };
  const right = { x: box!.x + box!.width - 4, y };
  const initial = await settledReaderRange(reader);

  await dispatchReaderPointer(reader, 'touch', center);
  await dispatchReaderPointer(reader, 'mouse', right);
  const mark = reader.locator('[data-reader-mark]').first();
  await expect(mark).toBeVisible();
  await dispatchReaderPointer(mark, 'touch', right);
  await dispatchReaderPointer(
    reader.getByRole('button', { name: 'back', exact: true }),
    'touch',
    right,
  );
  const pointer = { pointerType: 'touch', isPrimary: true, button: 0 };
  const rightPointer = { ...pointer, clientX: right.x, clientY: right.y };
  await reader.dispatchEvent('pointerdown', { ...rightPointer, pointerId: 8 });
  await reader.dispatchEvent('pointercancel', { ...rightPointer, pointerId: 8 });
  await reader.dispatchEvent('pointerup', { ...rightPointer, pointerId: 8 });
  await reader.dispatchEvent('pointerdown', { ...rightPointer, pointerId: 9 });
  await reader.dispatchEvent('pointerup', { ...rightPointer, pointerId: 10 });
  await page.waitForTimeout(100);
  expect(await settledReaderRange(reader)).toEqual(initial);

  await reader.locator('[data-reader-page]').evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    if (!text || !text.textContent) throw new Error('reader page has no selectable text');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(2, text.textContent.length));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await dispatchReaderPointer(pane, 'touch', right);
  await page.waitForTimeout(100);
  expect(await settledReaderRange(reader)).toEqual(initial);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  await dispatchReaderPointer(reader, 'touch', right, { x: center.x, y: center.y + 20 });
  await page.waitForTimeout(100);
  expect(await settledReaderRange(reader)).toEqual(initial);

  await dispatchReaderPointer(reader, 'touch', right);
  await expect(reader.locator('[data-reader-page]'))
    .toHaveAttribute('data-reader-page', new RegExp(`^${initial[1]}:`));
  const next = await settledReaderRange(reader);
  expect(next[0]).toBe(initial[1]);

  await dispatchReaderPointer(reader, 'touch', left);
  await expect(reader.locator('[data-reader-page]'))
    .toHaveAttribute('data-reader-page', new RegExp(`^${initial[0]}:`));
  expect(await settledReaderRange(reader)).toEqual(initial);
});
