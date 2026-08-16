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
  clearDemoInputs,
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
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'slice-two.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(CORPUS, 'utf-8'),
  });
  await expect(page.getByRole('region', { name: 'Inputs', exact: true })).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  // Author one multi-alias term: wolf OR hound.
  await page.getByRole('button', { name: 'Edit term: wolf' }).click();
  const manager = page.getByRole('dialog', { name: 'Manage terms' });
  const editor = manager.getByRole('form', { name: 'Edit term: wolf' });
  await editor.getByRole('textbox', { name: 'Term and aliases for wolf' }).fill('wolf, hound');
  let mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await editor.getByRole('button', { name: 'Save term' }).click();
  await awaitOps(page, mark, ['trend', 'dispersion', 'matches-window']);
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
  let termTotal = page.getByRole('list', { name: 'Term totals' })
    .getByRole('listitem').filter({ hasText: 'wolf' })
    .locator('[data-term-occurrence-count]');
  await expect(termTotal).toHaveText('6');
  await expect(page.getByRole('group', { name: 'Query terms' })
    .locator('.term-bucket-summary').filter({ hasText: /wolf\s*6/ })).toBeVisible();

  // Activate the exact barcode tick at wolf@430. It reveals a fresh
  // Matches window
  // evidence and also demonstrates the exact reader open path; return so
  // the rest of the journey continues on the analysis surface.
  const trendScrubber = page.getByRole('slider', { name: /reading position/i });
  const canvas = trendScrubber.locator('canvas').first();
  const canvasBox = (await canvas.boundingBox())!;
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await canvas.click({ position: { x: canvasBox.width * (430.5 / 900), y: 3 } });
  await awaitOps(page, mark, ['matches-window', 'reader-page']);
  await page.getByRole('main', { name: /Reader: slice-two/ }).getByRole('button', { name: 'back' }).click();
  await gotoPlace(page, 'matches');
  await expect(page.getByRole('grid', { name: 'Matches' })
    .locator('[role="row"][aria-selected="true"] .kwic-token-position')).toHaveText('431 / 900');
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
  await awaitOps(page, mark, ['trend', 'dispersion']);

  // Analytical overlays describe the range, while Matches retains all
  // six full-corpus occurrences and marks the four selected rows.
  await expect(page.getByRole('button', { name: 'clear selection' })).toBeVisible();
  await expect(page.locator('[data-selected-overlay]').first()).toBeVisible();
  await expect(trendScrubber.locator('canvas[data-selected-layer="ready"]')).toBeVisible();
  termTotal = page.getByRole('list', { name: 'Term totals' })
    .getByRole('listitem').filter({ hasText: 'wolf' })
    .locator('[data-term-occurrence-count]');
  await expect(termTotal).toHaveText('4');
  await expect(
    page.getByRole('group', { name: 'Query terms' })
      .locator('.term-bucket-summary').filter({ hasText: /wolf\s*4 selected \/ 6/ }),
  ).toBeVisible();
  await gotoPlace(page, 'matches');
  const rows = page.getByRole('grid', { name: 'Matches' }).locator('[role="row"][aria-rowindex]');
  await expect(rows).toHaveCount(6);
  const rowText = (await rows.allInnerTexts()).join(' ');
  for (const marker of ['in0430', 'in0440', 'in0450', 'in0470']) {
    expect(rowText).toContain(marker);
  }
  expect(rowText).toContain('out0100');
  expect(rowText).toContain('out0820');
  await expect(page.getByRole('grid', { name: 'Matches' })
    .locator('[role="row"][data-linked-selection="true"]')).toHaveCount(4);

  // Open one selected matches occurrence in the current-semantics Reader.
  const readerOpen = page.getByRole('grid', { name: 'Matches' })
    .locator('[role="row"][data-linked-selection="true"]')
    .first()
    .getByRole('button');
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await readerOpen.click();
  await awaitOps(page, mark, ['reader-page']);
  const drawer = page.getByRole('main', { name: /Reader: slice-two/ });
  const initialRange = await drawer.locator('[data-reader-page]').getAttribute('data-reader-page');
  expect(initialRange).not.toBeNull();
  await expect(drawer.locator('[data-reader-selection="true"]').first()).toBeVisible();

  // Directional source cursors tile at the served seam. With this uniform
  // fixture, returning across the same seam reproduces the initial range.
  await drawer.getByRole('button', { name: 'next →', exact: true }).focus();
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.keyboard.press('Enter');
  await awaitOps(page, mark, ['reader-page']);
  const nextRange = await drawer.locator('[data-reader-page]').getAttribute('data-reader-page');
  expect(nextRange).not.toBe(initialRange);
  await drawer.getByRole('button', { name: '← previous', exact: true }).focus();
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.keyboard.press('Enter');
  await awaitOps(page, mark, ['reader-page']);
  await expect(drawer.locator(`[data-reader-page="${initialRange}"]`)).toBeVisible();
  await drawer.getByRole('button', { name: 'back' }).click();

  // Clearing restores baseline consumers without recomputing/relabeling them
  // as selected evidence.
  await gotoPlace(page, 'trends');
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'clear selection' }).click();
  await awaitOps(page, mark, ['freq-list']);
  const clearQueries = (await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  );
  expect(clearQueries.filter((event) => event.op === 'trend' || event.op === 'dispersion'))
    .toHaveLength(0);
  expect(clearQueries.filter((event) => event.op === 'inventory')).toHaveLength(0);
  await expect(page.getByTestId('linked-selection')).toHaveCount(0);
  await expect(page.locator('[data-selected-overlay]')).toHaveCount(0);
  await expect(trendScrubber.locator('canvas[data-selected-layer]')).toHaveCount(0);
  termTotal = page.getByRole('list', { name: 'Term totals' })
    .getByRole('listitem').filter({ hasText: 'wolf' })
    .locator('[data-term-occurrence-count]');
  await expect(termTotal).toHaveText('6');
  await gotoPlace(page, 'matches');
  await expect(rows).toHaveCount(6);
});
