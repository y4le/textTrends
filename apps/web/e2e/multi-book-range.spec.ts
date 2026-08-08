import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, gotoPlace } from './helpers.ts';

const book = (prefix: string) => Array.from(
  { length: 40 },
  (_, index) => `${prefix}${index} Holmes`,
).join(' ');

test('a reading-order drag selects across a book boundary', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');
  await page.getByLabel('Create project from files').setInputFiles([
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from(book('a'), 'utf-8') },
    { name: 'beta.txt', mimeType: 'text/plain', buffer: Buffer.from(book('b'), 'utf-8') },
  ]);
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 2);

  await gotoPlace(page, 'trends');
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await expect(scrubber).toBeVisible();
  const box = (await scrubber.boundingBox())!;
  const y = box.y + Math.min(40, box.height * 0.25);
  // Leave enough room for the chart's right-side direct-label gutter: the
  // two equal-length books meet slightly left of the slider's visual centre.
  await page.mouse.move(box.x + box.width * 0.35, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, y, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByText(/Selected alpha token .* → beta token .* across 2 books/i))
    .toBeVisible();
  await expect(page.getByTestId('linked-selection')).toBeVisible();
  await expect(page.locator('canvas[data-selected-layer="ready"]')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'by book', exact: true }).click();
  await expect(page.locator('[data-range-selection-segment="true"]')).toHaveCount(2);

  await gotoPlace(page, 'corpus');
  await expect(page.getByRole('button', {
    name: /alpha token .* → beta token .* across 2 books — review linked range in Trends/i,
  })).toBeVisible();
  const rows = page.getByRole('table', { name: 'Corpus documents' })
    .locator(':scope > tbody > tr:not([data-book-detail])');
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row.locator('.corpus-selected-tokens')).not.toHaveText('0');
  }

  await gotoPlace(page, 'concordance');
  await expect(page.getByText(/occurrences · selected range across 2 books/i)).toBeVisible();
});
