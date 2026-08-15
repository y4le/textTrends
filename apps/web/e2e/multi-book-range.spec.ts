import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, clearDemoInputs, gotoPlace } from './helpers.ts';

const book = (prefix: string) => Array.from(
  { length: 40 },
  (_, index) => `${prefix}${index} Holmes`,
).join(' ');

test('a reading-order drag selects across a book boundary', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles([
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from(book('a'), 'utf-8') },
    { name: 'beta.txt', mimeType: 'text/plain', buffer: Buffer.from(book('b'), 'utf-8') },
  ]);
  await expect(page.getByRole('region', { name: 'Inputs', exact: true })).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 2);

  await gotoPlace(page, 'trends');
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await expect(scrubber).toBeVisible();
  const box = (await scrubber.boundingBox())!;
  const y = box.y + Math.min(40, box.height * 0.25);
  // Cross the midpoint where the two equal-length books meet.
  await page.mouse.move(box.x + box.width * 0.35, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, y, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByRole('button', { name: 'clear selection' })).toBeVisible();
  await expect(page.getByText(/^Selected /)).toHaveCount(0);
  await expect(page.getByTestId('linked-selection')).toBeVisible();
  await expect(scrubber.locator('canvas[data-selected-layer="ready"]'))
    .toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'separate', exact: true }).click();
  await expect(page.locator('[data-range-selection-segment="true"]')).toHaveCount(2);

  await gotoPlace(page, 'inputs');
  await expect(page.getByRole('button', {
    name: /alpha token .* → beta token .* across 2 books — review linked range in Trends/i,
  })).toBeVisible();
  const rows = page.getByRole('table', { name: 'Text details' })
    .locator(':scope > tbody > tr[data-catalog-book]');
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row.locator('.catalog-book-tokens .selectable-stat')).not.toHaveText('0');
  }

  await gotoPlace(page, 'matches');
  const matches = page.getByRole('grid', { name: 'Matches' });
  await expect(matches).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/occurrences · .*ready books/i)).toHaveCount(0);
  await expect(matches.locator('.kwic-book-heading')).toBeVisible();
  await expect(matches.getByRole('columnheader', { name: 'token', exact: true }))
    .toBeVisible();
  const firstBook = matches.locator('[role="row"][aria-rowindex] .kwic-book').first();
  await expect(firstBook).toHaveText(/^\([12]\) (alpha|beta)$/);
  await expect(firstBook).toHaveAttribute('title', /^\([12]\) (alpha|beta)$/);
  const wideBook = await firstBook.evaluate((cell) => ({
    clipped: cell.querySelector('span')!.scrollWidth
      > cell.querySelector('span')!.clientWidth,
    width: cell.getBoundingClientRect().width,
  }));
  expect(wideBook.clipped).toBe(false);

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowBook = await firstBook.evaluate((cell) => {
    const span = cell.querySelector('span')!;
    const text = span.firstChild!;
    const bounds = span.getBoundingClientRect();
    const prefix = document.createRange();
    prefix.setStart(text, 0);
    prefix.setEnd(text, 3);
    const titleStart = document.createRange();
    titleStart.setStart(text, 4);
    titleStart.setEnd(text, 5);
    return {
      clipped: span.scrollWidth > span.clientWidth,
      prefixVisible: prefix.getBoundingClientRect().right <= bounds.right + 1,
      titleHidden: titleStart.getBoundingClientRect().left >= bounds.right - 1,
      width: cell.getBoundingClientRect().width,
    };
  });
  expect(narrowBook.clipped).toBe(true);
  expect(narrowBook.prefixVisible).toBe(true);
  expect(narrowBook.titleHidden).toBe(true);

  await page.getByRole('toolbar', { name: 'Match columns' })
    .getByRole('button', { name: 'Adjust column widths' }).click();
  const bookWidth = matches.getByRole('separator', { name: 'Book width' });
  await expect(bookWidth).toHaveAttribute('aria-valuenow', '3');
  await bookWidth.focus();
  await bookWidth.press('End');
  await expect(bookWidth).toHaveAttribute('aria-valuenow', '80');
  const expandedBook = await firstBook.evaluate((cell) => ({
    clipped: cell.querySelector('span')!.scrollWidth
      > cell.querySelector('span')!.clientWidth,
    width: cell.getBoundingClientRect().width,
  }));
  expect(expandedBook.clipped).toBe(false);
  expect(expandedBook.width).toBeGreaterThan(narrowBook.width);
  await expect(matches.locator('[data-linked-selection="true"]').first()).toBeVisible();
});
