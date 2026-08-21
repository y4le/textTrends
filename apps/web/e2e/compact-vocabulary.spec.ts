import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  clearDemoInputs,
  gotoPlace,
  trace,
} from './helpers.ts';

async function expectNoBodyOverflow(page: import('@playwright/test').Page) {
  const geometry = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(geometry.document).toBeLessThanOrEqual(geometry.client);
  expect(geometry.body).toBeLessThanOrEqual(geometry.client);
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
]) {
  test(`compact Vocabulary keeps one truthful ranking table at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await awaitAllReady(page, { loadDemo: true });
    await gotoPlace(page, 'vocabulary');

    const table = page.getByRole('table', { name: 'Vocabulary frequency list' });
    await expect(table).toBeVisible();
    await expect(table).toHaveAttribute('aria-colcount', '6');
    await expect(table.getByRole('columnheader')).toHaveCount(6);
    await expect(table.locator('thead .data-grid-sort-button')).toHaveCount(6);
    await expect(table.locator('thead .data-grid-sort-indicator')).toHaveCount(1);
    await expect(table.getByRole('columnheader', { name: /count/ })
      .locator('.data-grid-sort-indicator')).toHaveText('↓');
    await expect(table.getByRole('columnheader', { name: /term/ })
      .locator('.data-grid-sort-indicator')).toHaveCount(0);
    await expect(page.locator('.frequency-result-summary')).toHaveCount(0);
    const row = table.locator('tr[data-frequency-row]').first();
    await expect(row.getByRole('rowheader')).toHaveAttribute('aria-colindex', '1');
    await expect(row.getByRole('cell')).toHaveCount(5);
    await expect(row.locator('td.frequency-count')).toHaveAttribute('aria-colindex', '2');

    const term = row.getByRole('button');
    const filter = page.getByRole('searchbox', { name: 'filter (regex)' });
    const filterBox = await filter.boundingBox();
    expect(filterBox?.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('region', { name: 'Scrollable Vocabulary frequency list' }))
      .toBeFocused();
    await page.keyboard.press('j');
    await expect(term).toBeFocused();
    await row.locator('td.frequency-count').click();
    const detail = page.getByRole('region', { name: /Vocabulary detail:/ });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('document coverage');
    await expect(detail).toContainText('token interval');
    await expect(detail.locator('dt')).toHaveCount(10);
    await expectNoBodyOverflow(page);

    await page.goBack();
    await expect(detail).toHaveCount(0);
    await expect(term).toBeFocused();
  });
}

test('Vocabulary regex filter updates live, reports invalid input, and clears', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'vocabulary');

  const filter = page.getByRole('searchbox', { name: 'filter (regex)' });
  await expect(filter).toBeVisible();
  await expect(page.getByRole('button', { name: 'filter', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Vocabulary filters' })).toHaveCount(0);
  expect(await filter.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)))
    .toBeGreaterThanOrEqual(16);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await filter.fill('^Hol');
  await expect(page.locator('tr[data-frequency-row]')).not.toHaveCount(0);
  await expect.poll(async () => (await trace(page)).events.filter(
    (event) => event.seq > mark && event.direction === 'to-worker'
      && event.t === 'query' && event.op === 'freq-list',
  ).length).toBe(1);
  await expect(page.locator('tr[data-frequency-row] .frequency-term-label').first())
    .toHaveText(/^Hol/u);

  const invalidMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await filter.fill('[');
  await expect(filter).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#vocabulary-regex-status'))
    .toContainText('Invalid regular expression');
  await page.waitForTimeout(250);
  expect((await trace(page)).events.filter(
    (event) => event.seq > invalidMark && event.direction === 'to-worker'
      && event.t === 'query' && event.op === 'freq-list',
  )).toEqual([]);

  const clear = page.getByRole('button', { name: 'Clear vocabulary filter' });
  const clearBox = await clear.boundingBox();
  expect(clearBox?.height).toBeGreaterThanOrEqual(44);
  await clear.click();
  await expect(filter).toHaveValue('');
  await expect(clear).toHaveCount(0);
  await expect(filter).not.toHaveAttribute('aria-invalid', 'true');
  await expectNoBodyOverflow(page);
});

test('Vocabulary common-word filtering is off by default and updates live', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'vocabulary');

  const slider = page.getByRole('slider', { name: 'remove common words' });
  await expect(slider).toHaveAccessibleName('remove common words');
  await expect(slider).toHaveValue('0');
  await expect(slider).toHaveAttribute('aria-valuetext', /off/);
  expect((await slider.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('.frequency-term-label', { hasText: /^the$/iu }).first())
    .toBeVisible();

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await slider.fill('100');
  await expect(slider).toHaveValue('100');
  await expect.poll(async () => (await trace(page)).events.filter(
    (event) => event.seq > mark && event.direction === 'to-worker'
      && event.t === 'query' && event.op === 'freq-list',
  ).length).toBe(1);
  await expect(page.locator('.frequency-term-label', { hasText: /^the$/iu }))
    .toHaveCount(0);
  await expect(page.locator('.common-words-control output')).toContainText(/top 100.*rows hidden/);
  await expectNoBodyOverflow(page);
});

test('wide Vocabulary keeps six columns and an in-flow regex bar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'vocabulary');

  const table = page.getByRole('table', { name: 'Vocabulary frequency list' });
  await expect(table.getByRole('columnheader')).toHaveCount(6);
  await expect(table.locator('thead .data-grid-sort-button')).toHaveCount(6);
  await expect(table.getByRole('columnheader', { name: /class/ })).toHaveCount(0);
  await expect(page.getByRole('search', { name: 'Filter vocabulary' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'filter (regex)' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Vocabulary filters' })).toHaveCount(0);
});

test('Vocabulary shares responsive resize, tooltip, sort, and row-key behavior', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'vocabulary');

  const table = page.getByRole('table', { name: 'Vocabulary frequency list' });
  const port = page.getByRole('region', { name: 'Scrollable Vocabulary frequency list' });
  const alignmentError = () => table.evaluate((root) => {
    const headings = [...root.querySelectorAll<HTMLElement>('[role="columnheader"]')];
    const row = root.querySelector<HTMLElement>('tr[data-frequency-row]');
    const cells = row === null
      ? []
      : [...row.querySelectorAll<HTMLElement>(':scope > [role="rowheader"], :scope > [role="cell"]')];
    if (headings.length !== cells.length) return Number.POSITIVE_INFINITY;
    return headings.reduce((error, heading, index) => {
      const headerBox = heading.getBoundingClientRect();
      const cellBox = cells[index]!.getBoundingClientRect();
      return Math.max(
        error,
        Math.abs(headerBox.left - cellBox.left),
        Math.abs(headerBox.width - cellBox.width),
      );
    }, 0);
  });
  await expect.poll(alignmentError).toBeLessThanOrEqual(1);
  await expect.poll(() => port.evaluate((node) => node.scrollWidth <= node.clientWidth + 1))
    .toBe(true);
  const headerTop = await table.locator('thead').evaluate((node) => node.getBoundingClientRect().top);
  await port.evaluate((node) => { node.scrollTop = 300; });
  await expect.poll(() => table.locator('thead').evaluate((node, top) =>
    Math.abs(node.getBoundingClientRect().top - top), headerTop)).toBeLessThanOrEqual(1);
  await port.evaluate((node) => { node.scrollTop = 0; });

  const dpInfo = table.getByRole('button', { name: 'About DP', exact: true });
  await dpInfo.click();
  await expect(page.getByRole('tooltip')).toContainText('Deviation of proportions');

  const toolbar = page.getByRole('toolbar', { name: 'Vocabulary columns' });
  await toolbar.getByRole('button', { name: 'Adjust column widths' }).click();
  await expect(dpInfo).toBeDisabled();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  const separators = table.getByRole('separator');
  await expect(separators).toHaveCount(5);
  const termWidth = separators.first();
  const dragBefore = Number(await termWidth.getAttribute('aria-valuenow'));
  await termWidth.evaluate((handle) => {
    const box = handle.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      pointerId: 73,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    };
    handle.dispatchEvent(new PointerEvent('pointerdown', init));
    handle.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: init.clientX + 30 }));
    handle.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: init.clientX + 30 }));
  });
  await expect.poll(async () => Number(await termWidth.getAttribute('aria-valuenow')))
    .toBeGreaterThan(dragBefore);
  const before = Number(await termWidth.getAttribute('aria-valuenow'));
  await termWidth.focus();
  await termWidth.press('ArrowRight');
  await expect(termWidth).toHaveAttribute('aria-valuenow', String(before + 1));
  await expect.poll(alignmentError).toBeLessThanOrEqual(1);
  await termWidth.press('Escape');
  await expect(toolbar.getByRole('button', { name: 'Adjust column widths' })).toBeFocused();
  await expect(dpInfo).toBeEnabled();

  await table.getByRole('button', { name: 'rate/10k', exact: true }).click();
  await expect(table.getByRole('columnheader', { name: /rate\/10k/ }))
    .toHaveAttribute('aria-sort', 'descending');
  await expect(table.locator('thead .data-grid-sort-indicator')).toHaveCount(1);
  const termSort = table.getByRole('button', { name: 'term', exact: true });
  await termSort.focus();
  await termSort.press('Enter');
  await expect(table.getByRole('columnheader', { name: /term/ }))
    .toHaveAttribute('aria-sort', 'ascending');
  await expect(table.getByRole('columnheader', { name: /term/ })
    .locator('.data-grid-sort-indicator')).toHaveText('↑');

  const rows = table.locator('tr[data-frequency-row]');
  const firstControl = rows.first().locator('.frequency-term > button');
  await firstControl.focus();
  await firstControl.press('Control+d');
  const selected = table.locator('tr[data-frequency-row][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  expect(await selected.evaluate((row) =>
    [...row.parentElement!.querySelectorAll('tr[data-frequency-row]')].indexOf(row)))
    .toBeGreaterThan(0);
  await selected.locator('.frequency-term > button').press('Enter');
  await expect(page.getByRole('region', { name: /Vocabulary detail:/ })).toBeVisible();
  await selected.locator('td.frequency-rate').click();
  await expect(page.getByRole('region', { name: /Vocabulary detail:/ })).toHaveCount(0);

  await port.focus();
  await port.press('j');
  await expect(table.locator('tr[data-frequency-row][aria-selected="true"] .frequency-term > button'))
    .toBeFocused();
});

test('successful exact Matches routing restores the open Vocabulary detail on Back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'vocabulary');

  const row = page.locator('tr[data-frequency-row]').first();
  await row.getByRole('button').click();
  const detail = page.getByRole('region', { name: /Vocabulary detail:/ });
  await detail.getByRole('button', { name: 'matches' }).click();
  await expect(page).toHaveURL(/[?&]p=matches(?:&|$)/);

  await page.goBack();
  await expect(page).toHaveURL(/[?&]p=vocabulary(?:&|$)/);
  await expect(detail).toBeVisible();
  await expect(page.getByRole('region', { name: 'Scrollable Vocabulary frequency list' }))
    .toBeFocused();
});

test('Vocabulary loads every matching row progressively without pagination', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  const prose = Array.from(
    { length: 260 },
    (_, index) => `unique${index} marker.`,
  ).join(' ');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'large vocabulary.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(prose, 'utf8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'vocabulary');

  const rows = page.locator('tr[data-frequency-row]');
  const port = page.getByRole('region', { name: 'Scrollable Vocabulary frequency list' });
  const table = page.getByRole('table', { name: 'Vocabulary frequency list' });
  await expect(table).toHaveAttribute('data-loaded-rows', '100');
  expect(await rows.count()).toBeLessThan(100);
  await expect(page.locator('.frequency-pagination')).toHaveCount(0);
  await expect(page.locator('.frequency-result-summary')).toHaveCount(0);

  await port.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect(table).toHaveAttribute('data-loaded-rows', '200');
  await port.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect(table).toHaveAttribute('data-loaded-rows', '261');
  expect(await rows.count()).toBeLessThan(100);
  await port.focus();
  await port.press('j');
  const selected = table.locator('tr[data-frequency-row][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  expect(Number(await selected.getAttribute('aria-rowindex'))).toBeGreaterThan(100);
  await expectNoBodyOverflow(page);
});

test('a large Vocabulary result stays inside a compact page', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  const prose = Array.from(
    { length: 90 },
    (_, index) => `word${index} repeats repeats.`,
  ).join(' ');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'many words.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(prose, 'utf8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'vocabulary');

  await page.getByRole('button', { name: 'DPnorm', exact: true }).click();
  const compactMeasure = page.locator('tr[data-frequency-row]').first()
    .locator('td.frequency-dpnorm');
  await expect(page.getByRole('columnheader', { name: /DPnorm/ }))
    .toHaveAttribute('aria-sort', 'descending');
  await expect(compactMeasure).toHaveText('unavailable');
  await expectNoBodyOverflow(page);
});
