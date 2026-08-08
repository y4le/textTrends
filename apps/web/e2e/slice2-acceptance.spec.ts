/**
 * Slice-2 acceptance journey: one authored semantic flows through exact
 * dispersion, linked detail scope, and canonical reading.
 * The corpus is local and deterministic; every assertion rests on a fresh
 * job-correlated result.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  gotoPlace,
  submitAndAwaitFreshResults,
  trace,
} from './helpers.ts';

const SPECIAL = new Map<number, string>([
  [100, 'wolf'], [101, 'out0100'],
  [430, 'wolf'], [431, 'in0430'],
  [440, 'hound'], [441, 'in0440'],
  [450, 'wolf'], [451, 'in0450'],
  [470, 'hound'], [471, 'in0470'],
  [820, 'wolf'], [821, 'out0820'],
]);
const CORPUS = Array.from(
  { length: 900 },
  (_, index) => SPECIAL.get(index) ?? `w${String(index).padStart(4, '0')}`,
).join(' ');

async function awaitOps(
  page: Page,
  mark: number,
  required: readonly string[],
): Promise<void> {
  await expect
    .poll(async () => {
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
    }, { timeout: 30_000 })
    .toBe('answered');
}

test('slice 2: exact occurrences → linked range → gap-free reader → baseline', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'slice-two.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(CORPUS, 'utf-8'),
  });
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  // Author one multi-member group: wolf OR hound.
  await page.getByRole('button', { name: 'Edit members: wolf' }).click();
  const editor = page.getByRole('group', { name: 'Edit members: wolf' });
  await editor.getByLabel(/Add member to wolf/).fill('hound');
  await editor.getByRole('button', { name: 'add', exact: true }).click();
  let mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await editor.getByRole('button', { name: 'Apply changes to wolf' }).click();
  await awaitOps(page, mark, ['trend', 'dispersion', 'kwic']);
  await expect(page.getByText('wolf: 6 occurrences', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Query terms' })
    .getByRole('button', { name: 'wolf 6', exact: true })).toBeVisible();

  // Activate the exact barcode tick at wolf@430. It centres fresh KWIC
  // evidence and also demonstrates the exact reader open path; return so
  // the rest of the journey continues on the analysis surface.
  const trendScrubber = page.getByRole('slider', { name: /reading position/i });
  const canvas = trendScrubber.locator('canvas').first();
  const canvasBox = (await canvas.boundingBox())!;
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await canvas.click({ position: { x: canvasBox.width * (430.5 / 900), y: 3 } });
  await awaitOps(page, mark, ['kwic', 'reader-page']);
  await page.getByRole('main', { name: /Reader: slice-two/ }).getByRole('button', { name: 'back' }).click();
  await gotoPlace(page, 'concordance');
  await expect(page.getByText(/nearest to .* token 431\b/)).toBeVisible();
  await gotoPlace(page, 'trends');

  // Keyboard-only brush: token 420 through 480 inclusive → [420,481).
  // PageDown advances one 23-token bin in this 900-token / 40-bin document.
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  for (let index = 0; index < 18; index++) await scrubber.press('PageDown');
  for (let index = 0; index < 6; index++) await scrubber.press('ArrowRight');
  await expect(scrubber).toHaveAttribute('aria-valuetext', /token 421 of 900/);
  await scrubber.press('s');
  for (let index = 0; index < 60; index++) await scrubber.press('ArrowRight');
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scrubber.press('Enter');
  await awaitOps(page, mark, ['trend', 'dispersion', 'kwic']);

  // All detail consumers describe the same range: four occurrences inside,
  // six in the corpus, with no outside-marker row admitted.
  await expect(page.getByText(/Selected 61 tokens in slice-two/)).toBeVisible();
  await expect(page.locator('[data-selected-overlay]').first()).toBeVisible();
  await expect(trendScrubber.locator('canvas[data-selected-layer="ready"]')).toBeVisible();
  await expect(page.getByText('wolf: 6 occurrences · 4 selected', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Query terms' })
      .getByRole('button', { name: 'wolf 4 selected / 6', exact: true }),
  ).toBeVisible();
  await gotoPlace(page, 'concordance');
  const rows = page.getByRole('table', { name: 'Concordance' }).locator('tbody tr');
  await expect(rows).toHaveCount(4);
  const rowText = (await rows.allInnerTexts()).join(' ');
  for (const marker of ['in0430', 'in0440', 'in0450', 'in0470']) {
    expect(rowText).toContain(marker);
  }
  expect(rowText).not.toContain('out0100');
  expect(rowText).not.toContain('out0820');

  // Open one selected concordance occurrence in the current-semantics Reader.
  const readerOpen = rows.getByRole('button').first();
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await readerOpen.click();
  await awaitOps(page, mark, ['reader-page']);
  const drawer = page.getByRole('main', { name: /Reader: slice-two/ });
  await expect(drawer.locator('[data-reader-page="400:800"]')).toBeVisible();
  await expect(drawer.locator('[data-reader-selection="true"]').first()).toBeVisible();

  // Keyboard reader navigation uses served canonical cursors. Forward starts
  // exactly at the prior exclusive end; Previous returns to the exact range.
  await drawer.getByRole('button', { name: 'next' }).focus();
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.keyboard.press('Enter');
  await awaitOps(page, mark, ['reader-page']);
  await expect(drawer.locator('[data-reader-page="800:900"]')).toBeVisible();
  await drawer.getByRole('button', { name: 'previous' }).focus();
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.keyboard.press('Enter');
  await awaitOps(page, mark, ['reader-page']);
  await expect(drawer.locator('[data-reader-page="400:800"]')).toBeVisible();
  await drawer.getByRole('button', { name: 'back' }).click();

  // Clearing restores baseline consumers without recomputing/relabeling them
  // as selected evidence.
  await gotoPlace(page, 'trends');
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'clear selection' }).click();
  await awaitOps(page, mark, ['kwic']);
  const clearQueries = (await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  );
  expect(clearQueries.filter((event) => event.op === 'trend' || event.op === 'dispersion'))
    .toHaveLength(0);
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(page.locator('[data-selected-overlay]')).toHaveCount(0);
  await expect(trendScrubber.locator('canvas[data-selected-layer]')).toHaveCount(0);
  await expect(page.getByText('wolf: 6 occurrences', { exact: true })).toBeVisible();
  await gotoPlace(page, 'concordance');
  await expect(rows).toHaveCount(6);
});
