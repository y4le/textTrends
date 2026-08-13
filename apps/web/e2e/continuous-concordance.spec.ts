import { expect, test, type Page } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  gotoPlace,
  submitAndAwaitFreshResults,
  trace,
} from './helpers.ts';

async function awaitFreshWindow(page: Page, mark: number): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await trace(page);
    const queries = snapshot.events.filter((event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query'
      && event.op === 'concordance-window');
    const jobs = new Set(queries.map((event) => event.job));
    return snapshot.events.some((event) =>
      event.seq > mark
      && event.direction === 'from-worker'
      && event.t === 'result'
      && jobs.has(event.job));
  }, { timeout: 30_000 }).toBe(true);
}

test('continuous Concordance virtualizes rows and synchronizes scrolling with the shared cursor', async ({ page, context }, testInfo) => {
  await context.addInitScript(() => {
    const tasks: { start: number; duration: number }[] = [];
    (window as unknown as { __ttConcordanceLongTasks: typeof tasks }).__ttConcordanceLongTasks = tasks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        tasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'inputs');
  const words = Array.from(
    { length: 1_200 },
    (_, index) => `holmes watson moriarty marker${index}`,
  ).join(' ');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'many-mentions.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(words, 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'holmes, watson, moriarty');
  await gotoPlace(page, 'concordance');

  const terms = page.getByRole('complementary', { name: 'Terms' });
  await expect(terms).toBeVisible();
  await expect(page.getByRole('group', { name: 'Concordance terms' })).toHaveCount(0);
  for (const term of ['holmes', 'watson']) {
    const toggleMark = (await trace(page)).events.at(-1)?.seq ?? -1;
    await terms.getByRole('button', { name: `Shown in analysis: ${term}` }).click();
    await awaitFreshWindow(page, toggleMark);
  }

  const grid = page.getByRole('grid', { name: 'Concordance' });
  await expect(grid).toBeVisible({ timeout: 30_000 });
  await expect(grid).toHaveAttribute('aria-rowcount', '1201');
  const occurrenceRows = grid.locator('.kwic-virtual-row[aria-rowindex]');
  await expect.poll(() => occurrenceRows.count()).toBeGreaterThan(0);
  expect(await occurrenceRows.count()).toBeLessThan(120);

  const centeredGeometry = async () => page.locator('.kwic-grid-shell').evaluate((shell) => {
    const line = shell.querySelector<HTMLElement>('.kwic-now-line')!.getBoundingClientRect();
    const port = shell.querySelector<HTMLElement>('.kwic-virtual-grid')!.getBoundingClientRect();
    const active = shell.querySelector<HTMLElement>('[role="row"][aria-selected="true"]')
      ?.getBoundingClientRect();
    return {
      lineToUsableMidpoint: Math.abs(
        line.top
        - (port.top + (shell.querySelector<HTMLElement>('.kwic-virtual-grid')!.clientHeight / 2)),
      ),
      lineToActiveRow: active === undefined
        ? Number.POSITIVE_INFINITY
        : Math.abs(line.top - (active.top + active.height / 2)),
    };
  });
  await expect.poll(async () => (await centeredGeometry()).lineToUsableMidpoint)
    .toBeLessThanOrEqual(1);
  await grid.focus();
  await grid.press('Home');
  await expect.poll(async () => (await centeredGeometry()).lineToActiveRow)
    .toBeLessThanOrEqual(1);

  const footerSlider = page.getByRole('slider', { name: 'Corpus footer position' });
  const initialFooter = await footerSlider
    .getAttribute('aria-valuenow');
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await grid.evaluate((node) => {
    const port = node as HTMLElement;
    port.scrollTop = (port.scrollHeight - port.clientHeight) / 2;
  });
  await awaitFreshWindow(page, mark);
  await expect.poll(async () => Number(await grid.getAttribute('data-logical-position')))
    .toBeGreaterThan(500);
  await expect(footerSlider)
    .not.toHaveAttribute('aria-valuenow', initialFooter ?? '');

  const activeOccurrenceToken = async () => {
    const text = await grid
      .locator('.kwic-virtual-row[aria-selected="true"] .kwic-token-position')
      .textContent();
    return Number.parseInt((text ?? '').split('/')[0]!.replaceAll(',', '').trim(), 10) - 1;
  };
  await expect.poll(async () =>
    Number(await footerSlider.getAttribute('aria-valuenow')) - await activeOccurrenceToken())
    .toBe(0);
  const centeredToken = await activeOccurrenceToken();
  await grid.evaluate((node) => { (node as HTMLElement).scrollTop += 32; });
  await expect.poll(activeOccurrenceToken).toBeGreaterThan(centeredToken);
  await expect.poll(async () =>
    Number(await footerSlider.getAttribute('aria-valuenow')) - await activeOccurrenceToken())
    .toBe(0);

  // Reverse direction: a shared-axis keyboard scrub drives the scroll plane,
  // lands a fresh exact window, and then stays fenced rather than oscillating.
  const reverseMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await footerSlider.focus();
  await footerSlider.press('Home');
  await awaitFreshWindow(page, reverseMark);
  await expect.poll(async () => Number(await grid.getAttribute('data-logical-position')))
    .toBeLessThanOrEqual(0.01);
  await expect.poll(async () => grid.evaluate((node) => (node as HTMLElement).scrollTop))
    .toBeLessThanOrEqual(0.75);
  const settledAtStart = Number(await grid.getAttribute('data-logical-position'));
  await page.waitForTimeout(250);
  expect(Number(await grid.getAttribute('data-logical-position'))).toBe(settledAtStart);

  const returnMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await grid.evaluate((node) => {
    const port = node as HTMLElement;
    port.scrollTop = (port.scrollHeight - port.clientHeight) / 2;
  });
  await awaitFreshWindow(page, returnMark);

  const residentMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const scrollWindowStart = await page.evaluate(() => performance.now());
  const unfilledFrames = await grid.evaluate(async (node) => {
    const port = node as HTMLElement;
    const gaps: { frame: number; from: number; to: number }[] = [];
    for (let frame = 0; frame < 48; frame++) {
      port.scrollTop += 32;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const portRect = port.getBoundingClientRect();
      const headerRect = port.querySelector<HTMLElement>('.kwic-grid-header')!.getBoundingClientRect();
      const top = Math.max(portRect.top, headerRect.bottom);
      const bottom = portRect.bottom;
      const rowRects = [...port.querySelectorAll<HTMLElement>('.kwic-virtual-row')]
        .map((row) => row.getBoundingClientRect())
        .filter((rect) => rect.bottom > top && rect.top < bottom)
        .sort((left, right) => left.top - right.top);
      let coveredThrough = top;
      for (const rect of rowRects) {
        if (rect.top > coveredThrough + 1) {
          gaps.push({ frame, from: coveredThrough - portRect.top, to: rect.top - portRect.top });
        }
        coveredThrough = Math.max(coveredThrough, rect.bottom);
      }
      if (coveredThrough < bottom - 1) {
        gaps.push({ frame, from: coveredThrough - portRect.top, to: bottom - portRect.top });
      }
    }
    return gaps;
  });
  await page.waitForTimeout(250);
  const scrollWindowEnd = await page.evaluate(() => performance.now());
  const prefetchQueries = (await trace(page)).events.filter((event) =>
    event.seq > residentMark
    && event.direction === 'to-worker'
    && event.t === 'query'
    && event.op === 'concordance-window');
  expect(prefetchQueries.length).toBeGreaterThan(0);
  expect(prefetchQueries.length).toBeLessThan(6);
  expect(unfilledFrames).toEqual([]);
  const longTasks = await page.evaluate(
    () => (window as unknown as {
      __ttConcordanceLongTasks: { start: number; duration: number }[];
    }).__ttConcordanceLongTasks,
  );
  await testInfo.attach('continuous-concordance-long-tasks.json', {
    body: JSON.stringify({ window: { scrollWindowStart, scrollWindowEnd }, longTasks }, null, 2),
    contentType: 'application/json',
  });
  expect(longTasks.filter((task) =>
    task.duration >= 100
    && task.start >= scrollWindowStart
    && task.start <= scrollWindowEnd)).toEqual([]);

  await grid.focus();
  await grid.press('End');
  await expect(grid).toHaveAttribute('aria-activedescendant', 'concordance-row-1199');
  await expect.poll(async () => (await centeredGeometry()).lineToActiveRow)
    .toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    const geometry = await grid.evaluate((node) => ({
      top: (node as HTMLElement).scrollTop,
      max: (node as HTMLElement).scrollHeight - (node as HTMLElement).clientHeight,
    }));
    return Math.abs((geometry.max - geometry.top) - 16);
  }).toBeLessThanOrEqual(1); // the last row is a half-pitch above the end sentinel

  await grid.press('Enter');
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: 'back', exact: true }).click();
  await expect(grid).toBeFocused();
});
