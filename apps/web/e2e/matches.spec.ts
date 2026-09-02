/**
 * Continuous corpus-order Matches acceptance in the real browser. A tiny
 * deterministic corpus proves merged order, shared-cursor synchronization,
 * and enabled-track filtering without a proximity sort.
 */

import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, clearDemoInputs, trace, gotoPlace, submitAndAwaitFreshResults } from './helpers.ts';

// wolf@1,@7 · fox@4,@10 (12 tokens), merged in declared corpus order.
const CORPUS = 'the wolf ran. a fox hid. the wolf slept. a fox fled.\n';
const LONG_ABSENT_TERM = 'pneumonoultramicroscopicsilicovolcanoconiosis';

/** Wait for a Matches window posted after `mark` to deliver its result. */
async function awaitFreshMatches(page: Page, mark: number): Promise<void> {
  await expect
    .poll(async () => {
      const t = await trace(page);
      if (t.dropped !== 0) return 'trace dropped events';
      const q = t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'query' && e.op === 'matches-window');
      if (q.length === 0) return 'no fresh matches query';
      const res = t.events.filter((e) => e.seq > mark && e.direction === 'from-worker' && e.t === 'result' && e.op === 'matches-window' && q.some((p) => p.job === e.job));
      return res.length > 0 ? 'answered' : 'no result';
    }, { timeout: 30_000, message: 'Matches did not deliver a fresh result' })
    .toBe('answered');
}

/** The node text of each match row, top to bottom. */
async function rowTerms(page: Page): Promise<string[]> {
  return page.getByRole('grid', { name: 'Matches' }).locator('[role="row"][aria-rowindex] .kwic-node').allInnerTexts();
}

/** Each match row's node + right-context — enough to
 *  distinguish two occurrences of the SAME term (fox@10's right is 'fled'). */
async function rowDetails(page: Page): Promise<{ term: string; right: string }[]> {
  const trs = page.getByRole('grid', { name: 'Matches' }).locator('[role="row"][aria-rowindex]');
  const n = await trs.count();
  const out: { term: string; right: string }[] = [];
  for (let i = 0; i < n; i++) {
    const row = trs.nth(i);
    out.push({
      term: (await row.locator('.kwic-node').innerText()).trim(),
      right: await row.locator('.kwic-right-context').innerText(),
    });
  }
  return out;
}

test('Matches merges all terms in corpus order and toggles a term off', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({ name: 'beasts.txt', mimeType: 'text/plain', buffer: Buffer.from(CORPUS, 'utf-8') });
  await expect(page.getByRole('region', { name: 'Inputs', exact: true })).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);

  // Compare two terms; Matches merges BOTH by default (reading order).
  await gotoPlace(page, 'trends');
  const mark0 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await submitAndAwaitFreshResults(page, `wolf, fox, ${LONG_ABSENT_TERM}`);
  await awaitFreshMatches(page, mark0);
  await gotoPlace(page, 'matches');
  const grid = page.getByRole('grid', { name: 'Matches' });
  await expect(grid).toBeVisible({ timeout: 30_000 });
  expect(new Set(await rowTerms(page))).toEqual(new Set(['wolf', 'fox'])); // both tagged

  // Enabled term mentions in context retain the cell's exact text/layout but
  // receive a quiet, non-interactive visual emphasis.
  const mention = grid.locator('.kwic-context-mention').first();
  await expect(mention).toBeVisible();
  await expect(mention).toHaveText(/wolf|fox/);
  const foxNodeColor = await grid.locator('.kwic-node button').filter({ hasText: /^fox$/ })
    .first().evaluate((element) => getComputedStyle(element).color);
  const mentionPresentation = await mention.evaluate((element) => {
    const style = getComputedStyle(element);
    const cell = element.closest<HTMLElement>('.kwic-left-context, .kwic-right-context')!;
    const row = element.closest<HTMLElement>('.kwic-virtual-row')!;
    return {
      backgroundColor: style.backgroundColor,
      borderBottomColor: style.borderBottomColor,
      borderBottomWidth: style.borderBottomWidth,
      color: style.color,
      foregroundColor: getComputedStyle(document.body).color,
      cellText: cell.textContent,
      wrapperText: cell.firstElementChild?.textContent,
      wrapperChildren: cell.children.length,
      rowHeight: row.getBoundingClientRect().height,
    };
  });
  expect(mentionPresentation.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(mentionPresentation.borderBottomColor).toBe(foxNodeColor);
  expect(mentionPresentation.borderBottomWidth).toBe('2px');
  expect(mentionPresentation.color).toBe(mentionPresentation.foregroundColor);
  expect(mentionPresentation.cellText).toBe(mentionPresentation.wrapperText);
  expect(mentionPresentation.wrapperChildren).toBe(1);
  expect(mentionPresentation.rowHeight).toBe(36);

  // A single-book corpus omits the redundant book column and keeps corpus
  // progress in its own rightmost column.
  await expect(grid.locator('.kwic-book-heading')).toHaveCount(0);
  await expect(grid.getByRole('separator', { name: /^text width$/i })).toHaveCount(0);
  await expect(grid
    .getByRole('columnheader', { name: /^position/ })).toBeVisible();
  await expect(grid
    .getByRole('columnheader', { name: /^match/ })).toBeVisible();
  await expect(grid.locator('[role="row"][aria-rowindex] .kwic-book')).toHaveCount(0);
  const firstToken = grid.locator('[role="row"][aria-rowindex] .kwic-token').first();
  await expect(firstToken).toHaveText(/^\d+ \/ \d+$/);
  const tokenGeometry = await firstToken.evaluate((cell) => {
    const grid = cell.closest<HTMLElement>('.kwic-virtual-grid')!;
    const gridFont = getComputedStyle(grid);
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(14);
    Object.assign(probe.style, {
      position: 'absolute',
      visibility: 'hidden',
      whiteSpace: 'pre',
      fontFamily: gridFont.fontFamily,
      fontSize: gridFont.fontSize,
    });
    document.body.append(probe);
    const minimum = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      usesSpareRoom: cell.getBoundingClientRect().width > minimum + 1,
      truncated: cell.scrollWidth > cell.clientWidth,
    };
  });
  expect(tokenGeometry).toEqual({ usesSpareRoom: false, truncated: false });

  // Context columns own all spare width. Fixed tracks keep their pixels while
  // a viewport change preserves the current left:right ratio.
  const contextWidths = () => grid.evaluate((port) => ({
    left: port.querySelector<HTMLElement>('.kwic-left-heading')!
      .getBoundingClientRect().width,
    right: port.querySelector<HTMLElement>('.kwic-right-heading')!
      .getBoundingClientRect().width,
  }));
  const columnAlignmentError = () => grid.evaluate((port) => {
    const header = [...port.querySelectorAll<HTMLElement>(
      '.kwic-grid-header > [role="columnheader"]',
    )];
    const firstRow = port.querySelector<HTMLElement>('.kwic-virtual-row[aria-rowindex]');
    const row = firstRow === null
      ? []
      : [...firstRow.querySelectorAll<HTMLElement>(':scope > [role="gridcell"]')];
    if (header.length !== row.length) return Number.POSITIVE_INFINITY;
    return header.reduce((error, cell, index) => {
      const heading = cell.getBoundingClientRect();
      const body = row[index]!.getBoundingClientRect();
      return Math.max(
        error,
        Math.abs(heading.left - body.left),
        Math.abs(heading.width - body.width),
      );
    }, 0);
  });
  await page.setViewportSize({ width: 1_400, height: 800 });
  await expect.poll(columnAlignmentError).toBeLessThanOrEqual(1);
  const responsiveBefore = await contextWidths();
  const fixedBefore = await grid.evaluate((port) => ({
    node: port.querySelector<HTMLElement>('.kwic-node-heading')!.getBoundingClientRect().width,
    token: port.querySelector<HTMLElement>('.kwic-token-heading')!.getBoundingClientRect().width,
  }));
  await page.setViewportSize({ width: 1_700, height: 800 });
  await expect.poll(async () => {
    const next = await contextWidths();
    return next.left > responsiveBefore.left + 20
      && next.right > responsiveBefore.right + 20;
  }).toBe(true);
  await expect.poll(() => grid.evaluate((port, before) => {
    const width = (selector: string) =>
      port.querySelector<HTMLElement>(selector)!.getBoundingClientRect().width;
    return Math.max(
      Math.abs(width('.kwic-node-heading') - before.node),
      Math.abs(width('.kwic-token-heading') - before.token),
    );
  }, fixedBefore)).toBeLessThanOrEqual(1);
  await expect.poll(columnAlignmentError).toBeLessThanOrEqual(1);

  const columnToolbar = page.getByRole('toolbar', { name: 'Match columns' });
  await columnToolbar.getByRole('button', { name: 'Adjust column widths' }).click();
  const leftWidth = grid.getByRole('separator', { name: 'Left context width' });
  await leftWidth.focus();
  await leftWidth.press('ArrowRight');
  const ratioBefore = await contextWidths();
  expect(Number(await leftWidth.getAttribute('aria-valuenow'))).toBe(51);

  await page.setViewportSize({ width: 1_900, height: 800 });
  await expect.poll(async () => {
    const next = await contextWidths();
    return Math.abs(next.left / next.right - ratioBefore.left / ratioBefore.right);
  }).toBeLessThanOrEqual(0.01);

  await columnToolbar.getByRole('button', { name: 'Reset column widths' }).click();
  await expect(leftWidth).toHaveAttribute('aria-valuenow', '50');
  await page.setViewportSize({ width: 1_024, height: 800 });
  await expect.poll(() => grid.evaluate((port) =>
    port.scrollWidth <= port.clientWidth + 1)).toBe(true);
  const resetResponsive = await contextWidths();
  await page.setViewportSize({ width: 2_100, height: 800 });
  await expect.poll(async () => (await contextWidths()).left > resetResponsive.left + 10)
    .toBe(true);
  await expect.poll(columnAlignmentError).toBeLessThanOrEqual(1);
  // Catalog labels the book by reading-order ordinal + title alongside exact totals.
  await gotoPlace(page, 'inputs');
  await expect(page.getByRole('table', { name: 'Text details' }).getByText('1 · beasts')).toBeVisible();

  // Move the shared cursor to the END via the keyboard scrubber. The logical
  // surface stays in corpus order and selects its last row without requerying:
  // the four-row result is already wholly resident.
  await gotoPlace(page, 'trends');
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  const mark1 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scrubber.press('End');
  await gotoPlace(page, 'matches');
  await expect(grid).toHaveAttribute('aria-activedescendant', 'matches-row-3');
  await page.waitForTimeout(200);
  expect((await trace(page)).events.filter((event) =>
    event.seq > mark1
    && event.direction === 'to-worker'
    && event.t === 'query'
    && event.op === 'matches-window')).toEqual([]);
  // Matches centers the nearest enabled mention without rewriting an external
  // cursor that falls after it in source text.
  await gotoPlace(page, 'trends');
  await expect(page.getByRole('slider', { name: /reading position/i }))
    .toHaveAttribute('aria-valuetext', /^beasts · token 12\b/);
  await gotoPlace(page, 'matches');
  await expect
    .poll(async () => (await rowDetails(page)).map((r) => r.term), { message: 'wrong merged corpus order' })
    .toEqual(['wolf', 'fox', 'wolf', 'fox']);
  await expect(grid.locator('[role="row"][aria-selected="true"] .kwic-right-context'))
    .toContainText('fled');

  // Toggle 'fox' OFF in the shared terms rail: a fresh matches drops
  // that globally hidden track and keeps wolf.
  const mark2 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('complementary', { name: 'Terms' })
    .getByRole('button', { name: 'Shown in analysis: fox' }).click();
  await awaitFreshMatches(page, mark2);
  await expect.poll(async () => new Set(await rowTerms(page)), { message: 'fox track did not disappear' }).toEqual(new Set(['wolf']));
});

test('Matches labels corpus edges without moving the centered reading geometry', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'beasts.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(CORPUS, 'utf-8'),
  });
  await awaitReadyCount(page, 1);

  await gotoPlace(page, 'trends');
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await submitAndAwaitFreshResults(page, 'wolf, fox');
  await awaitFreshMatches(page, mark);
  await gotoPlace(page, 'matches');

  const grid = page.getByRole('grid', { name: 'Matches' });
  const startBand = grid.locator('[data-corpus-edge="start"]');
  const endBand = grid.locator('[data-corpus-edge="end"]');
  await expect(startBand).toHaveText('Corpus start · 1 token before the first match');
  await expect(endBand).toHaveText('Corpus end · last match begins 1 token before the end');
  await expect(startBand).toHaveAttribute('aria-hidden', 'true');
  await expect(endBand).toHaveAttribute('aria-hidden', 'true');
  await expect(grid).toHaveAttribute(
    'aria-describedby',
    'matches-corpus-start-description matches-corpus-end-description',
  );
  await expect(page.locator('#matches-corpus-start-description')).toHaveText(
    'Corpus start · 1 token before the first match',
  );
  await expect(page.locator('#matches-corpus-end-description')).toHaveText(
    'Corpus end · last match begins 1 token before the end',
  );

  const geometry = (edge: 'start' | 'end') => grid.evaluate((port, requestedEdge) => {
    const shell = port.closest<HTMLElement>('.kwic-grid-shell')!;
    const line = shell.querySelector<HTMLElement>('.kwic-now-line')!.getBoundingClientRect();
    const band = port.querySelector<HTMLElement>(`[data-corpus-edge="${requestedEdge}"]`)!
      .getBoundingClientRect();
    const rank = requestedEdge === 'start' ? '0' : '3';
    const row = port.querySelector<HTMLElement>(`[data-matches-rank="${rank}"]`)!
      .getBoundingClientRect();
    return {
      bandBoundary: requestedEdge === 'start' ? band.bottom - line.top : band.top - line.top,
      logical: port.dataset.logicalPosition,
      maxScroll: port.scrollHeight - port.clientHeight,
      pointerEvents: getComputedStyle(
        port.querySelector<HTMLElement>(`[data-corpus-edge="${requestedEdge}"]`)!,
      ).pointerEvents,
      rowCenterOffset: row.top + row.height / 2 - line.top,
      rowHeight: row.height,
      scrollTop: port.scrollTop,
    };
  }, edge);

  await grid.evaluate((port) => { port.scrollTop = 0; });
  await expect(grid).toHaveAttribute('data-logical-position', '0.000');
  const atStart = await geometry('start');
  expect(atStart.bandBoundary).toBeCloseTo(0, 0);
  expect(atStart.pointerEvents).toBe('none');
  expect(atStart.rowCenterOffset).toBeCloseTo(atStart.rowHeight / 2, 0);
  expect(atStart.scrollTop).toBe(0);

  await grid.evaluate((port) => { port.scrollTop = port.scrollHeight; });
  await expect(grid).toHaveAttribute('data-logical-position', '4.000');
  const atEnd = await geometry('end');
  expect(atEnd.bandBoundary).toBeCloseTo(0, 0);
  expect(atEnd.pointerEvents).toBe('none');
  expect(atEnd.rowCenterOffset).toBeCloseTo(-atEnd.rowHeight / 2, 0);
  expect(atEnd.scrollTop).toBeCloseTo(atEnd.maxScroll, 0);
});
