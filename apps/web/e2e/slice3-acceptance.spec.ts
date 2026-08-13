/**
 * Slice-3 acceptance journey: bounded corpus inventory, book focus,
 * vocabulary ranking/concordance admission, and linked-range recomputation.
 */

import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, gotoPlace, trace } from './helpers.ts';

const prose = (terms: readonly string[], repetitions: number) =>
  Array.from({ length: repetitions }, () => `${terms.join(' ')}.`).join(' ');

const ALPHA = [
  '# Forest',
  prose(['wolf', 'pine', 'trail', 'moon'], 24),
  '# City',
  prose(['street', 'lamp', 'window', 'carriage'], 24),
].join('\n\n');

const BETA = [
  '# Sea',
  prose(['wave', 'salt', 'harbor', 'sail'], 24),
  '# Sky',
  prose(['cloud', 'star', 'wind', 'bird'], 24),
].join('\n\n');

async function awaitOps(
  page: Page,
  mark: number,
  required: readonly string[],
): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await trace(page);
    const queries = snapshot.events.filter(
      (event) =>
        event.seq > mark
        && event.direction === 'to-worker'
        && event.t === 'query'
        && required.includes(event.op ?? ''),
    );
    const jobs = new Set(queries.map((event) => event.job));
    const results = snapshot.events.filter(
      (event) =>
        event.seq > mark
        && event.direction === 'from-worker'
        && event.t === 'result'
        && jobs.has(event.job),
    );
    const seen = new Set(queries.map((event) => event.op));
    return required.every((op) => seen.has(op)) && jobs.size === results.length
      ? 'answered'
      : `${[...seen].join(',')}:${results.length}/${jobs.size}`;
  }, { timeout: 30_000 }).toBe('answered');
}

test('slice 3: corpus → focus → vocabulary → concordance → linked range → baseline', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'inputs');
  await page.getByLabel('Create project from files').setInputFiles([
    { name: 'alpha.md', mimeType: 'text/markdown', buffer: Buffer.from(ALPHA, 'utf-8') },
    { name: 'beta.md', mimeType: 'text/markdown', buffer: Buffer.from(BETA, 'utf-8') },
  ]);
  await expect(page.getByRole('heading', { name: 'library corpus', exact: true })).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 2);

  await expect(page.getByRole('region', { name: 'Catalog' })).toBeVisible({ timeout: 30_000 });
  const documents = page.getByRole('table', { name: 'Book analysis' });
  await expect(documents.locator(':scope > tbody > tr[data-catalog-book]')).toHaveCount(2);

  const betaRow = documents.getByRole('row', { name: /beta/ });
  const baselineTokens = await betaRow.locator('.catalog-book-tokens .selectable-stat').innerText();
  await betaRow.getByRole('button', { name: 'beta', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Vocabulary growth' })).toBeVisible();

  await gotoPlace(page, 'vocabulary');
  let mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'DP', exact: true }).click();
  await awaitOps(page, mark, ['freq-list']);

  await page.getByRole('button', { name: 'sort and filter' }).click();
  const prefix = page.getByLabel('starts with');
  await prefix.fill('wolf');
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'apply', exact: true }).click();
  await awaitOps(page, mark, ['freq-list']);
  const wolfRow = page.getByRole('table', { name: 'Vocabulary frequency list' })
    .getByRole('row', { name: /^wolf / });
  await expect(wolfRow).toBeVisible();
  await wolfRow.getByRole('button', { name: 'wolf', exact: true }).click();
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('region', { name: 'Vocabulary detail: wolf' })
    .getByRole('button', { name: 'concordance' })
    .click();
  await awaitOps(page, mark, ['trend', 'dispersion', 'concordance-window']);
  await expect(page).toHaveURL(/[?&]p=concordance(?:&|$)/);
  await expect(page.getByRole('grid', { name: 'Concordance' })).toBeVisible();

  await gotoPlace(page, 'trends');
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('End');
  await scrubber.press('ArrowRight');
  await scrubber.press('s');
  for (let index = 0; index < 12; index++) await scrubber.press('ArrowRight');
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scrubber.press('Enter');
  await awaitOps(page, mark, ['inventory', 'freq-list']);
  await gotoPlace(page, 'inputs');
  await expect(page.getByText(/across the active range/)).toBeVisible();
  await expect(betaRow.locator('.catalog-book-tokens .selectable-stat')).not.toHaveText(baselineTokens);

  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await gotoPlace(page, 'trends');
  await page.getByRole('button', { name: 'clear selection' }).click();
  await awaitOps(page, mark, ['inventory', 'freq-list']);
  await gotoPlace(page, 'inputs');
  await expect(betaRow.locator('.catalog-book-tokens .selectable-stat')).toHaveText(baselineTokens);
  await expect(page.getByText(/across the active range/)).toHaveCount(0);
});
