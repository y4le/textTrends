import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, trace } from './helpers.ts';

async function openReader(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await awaitAllReady(page);
  const setupMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  const read = page.getByRole('button', { name: 'Open passage in reader' });
  await expect(read).toBeVisible();
  await expect.poll(async () => (await trace(page)).events.some(
    (event) => event.seq > setupMark && event.direction === 'to-worker'
      && event.t === 'query' && event.op === 'kwic',
  )).toBe(true);
  await read.click();
  const reader = page.getByRole('dialog', { name: /Reader:/ });
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

test('wide Reader offers only study and full without history or query work', async ({ page }) => {
  const { read, reader } = await openReader(page);
  const modes = reader.getByRole('group', { name: 'Reader width' });

  await expect(modes.getByRole('button')).toHaveText(['study', 'full']);
  await expect(reader).toHaveAttribute('data-mode', 'study');
  await expect(reader).toHaveAttribute('data-requested', 'study');
  await expect(page.getByRole('complementary', { name: 'Terms' })).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Trends', exact: true })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Evidence' })).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Analysis lenses' })).toHaveCount(1);

  const historyWithReader = await page.evaluate(() => history.length);
  const urlWithReader = page.url();
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const full = modes.getByRole('button', { name: 'full', exact: true });
  await full.click();
  await expect(full).toHaveAttribute('aria-pressed', 'true');
  await expect(reader).toHaveAttribute('data-mode', 'full');
  await expect(reader).toHaveAttribute('data-slot', 'workbench');
  await expect(page.getByRole('complementary', { name: 'Terms' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Evidence' })).toHaveCount(0);
  await reader.getByRole('button', { name: /Save reader excerpt at token/ }).click();
  await expect(reader.getByRole('status')).toContainText(
    'Saved the loaded excerpt to Findings.',
  );
  expect(await page.evaluate(() => history.length)).toBe(historyWithReader);
  expect(page.url()).toBe(urlWithReader);
  expect(workerQueriesAfter((await trace(page)).events, mark)).toEqual([]);

  await page.goBack();
  await expect(reader).toHaveCount(0);
  await expect(read).toBeFocused();
  await page.goForward();
  await expect(page.getByRole('dialog', { name: /Reader:/ }))
    .toHaveAttribute('data-requested', 'full');
});

test('Reader retains one DOM and study preference across every width class', async ({ page }) => {
  const { reader } = await openReader(page);
  const pageRange = await reader.locator('[data-reader-page]').getAttribute('data-reader-page');
  await reader.evaluate((element) => { element.dataset.ttProbe = 'reader-stays-mounted'; });
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(reader).toHaveAttribute('data-mode', 'study');
  await expect(reader).toHaveAttribute('data-requested', 'study');
  await expect(reader).toHaveAttribute('data-tt-probe', 'reader-stays-mounted');
  await expect(reader).toHaveAttribute('aria-modal', 'false');
  await expectNoBodyOverflow(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(reader).toHaveAttribute('data-mode', 'full');
  await expect(reader).toHaveAttribute('data-slot', 'viewport');
  await expect(reader).toHaveAttribute('data-requested', 'study');
  await expect(reader).toHaveAttribute('data-tt-probe', 'reader-stays-mounted');
  await expect(page.getByRole('region', { name: 'Scope' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Analysis lenses' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Terms' })).toHaveCount(0);
  await expect(page.locator('.app-header')).toHaveCount(0);
  await expect(page.locator('.sheet-scrim')).toHaveCount(0);
  await expect(page.locator('[inert]')).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'back', exact: true })).toBeVisible();
  expect(await page.locator('main button, main a, main input, main select, main textarea')
    .evaluateAll((elements, readerId) => elements.every(
      (element) => element.closest(`#${readerId}`) !== null,
    ), 'reader-region')).toBe(true);
  await expect(reader).toBeFocused();
  const pagesBox = await reader.getByRole('navigation', { name: 'Reader pages' }).boundingBox();
  expect(pagesBox!.y + pagesBox!.height).toBeCloseTo(844, 0);
  expect(await reader.locator('.reader-prose-scroll').evaluate(
    (element) => getComputedStyle(element).overflowY,
  )).toBe('auto');
  expect(await reader.evaluate((element) => getComputedStyle(element).overflowY)).toBe('hidden');
  expect(await reader.evaluate((element) => getComputedStyle(element).touchAction)).not.toBe('none');
  expect(await reader.locator('[data-reader-page]').evaluate(
    (element) => getComputedStyle(element).userSelect,
  )).toBe('text');
  await expectNoBodyOverflow(page);

  await page.setViewportSize({ width: 320, height: 800 });
  await expect(reader).toHaveAttribute('data-mode', 'full');
  const narrowPagesBox = await reader
    .getByRole('navigation', { name: 'Reader pages' })
    .boundingBox();
  expect(narrowPagesBox).not.toBeNull();
  expect(narrowPagesBox!.y + narrowPagesBox!.height).toBeCloseTo(800, 0);
  await expectNoBodyOverflow(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(reader).toHaveAttribute('data-mode', 'study');
  await expect(reader).toHaveAttribute('data-tt-probe', 'reader-stays-mounted');
  await expect(reader.locator('[data-reader-page]')).toHaveAttribute('data-reader-page', pageRange!);
  await expectNoBodyOverflow(page);
  expect(workerQueriesAfter((await trace(page)).events, mark)).toEqual([]);
});
