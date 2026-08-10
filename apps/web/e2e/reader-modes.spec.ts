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
  const box = await reader.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeCloseTo(0, 0);
  expect(box!.y).toBeCloseTo(0, 0);
  expect(box!.width).toBeCloseTo(width, 0);
  expect(box!.height).toBeCloseTo(height, 0);
  await expect(reader.getByRole('navigation', { name: 'Reader pages' })).toBeVisible();
  await expectNoBodyOverflow(page);
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
  expect(await reader.locator('.reader-prose-scroll').evaluate(
    (element) => getComputedStyle(element).overflowY,
  )).toBe('auto');
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

  await expectReaderFillsViewport(page, reader, 320, 800);
  await expectReaderFillsViewport(page, reader, 1440, 900);
  await expect(reader).not.toHaveAttribute('role', 'dialog');
  await expect(reader).toHaveAttribute('data-tt-probe', 'reader-stays-mounted');
  await expect(reader.locator('[data-reader-page]')).toHaveAttribute('data-reader-page', pageRange!);
  expect(workerQueriesAfter((await trace(page)).events, mark)).toEqual([]);
});
