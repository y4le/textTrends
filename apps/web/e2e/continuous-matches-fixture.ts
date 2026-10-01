import { expect, type Page, type Locator } from '@playwright/test';
import { awaitReadyCount, gotoPlace, submitAndAwaitFreshResults, trace } from './helpers.ts';

export async function awaitFreshWindow(page: Page, mark: number): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await trace(page);
    const queries = snapshot.events.filter((event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query'
      && event.op === 'matches-window');
    const jobs = new Set(queries.map((event) => event.job));
    return snapshot.events.some((event) =>
      event.seq > mark
      && event.direction === 'from-worker'
      && event.t === 'result'
      && jobs.has(event.job));
  }, { timeout: 30_000 }).toBe(true);
}

export async function prepareContinuousMatches(page: Page): Promise<Locator> {
  await page.goto('./');
  await expect(page.locator('.scope-organ > [role="status"]')).toContainText('No active inputs');
  await gotoPlace(page, 'inputs');
  const words = Array.from(
    { length: 1_200 },
    (_, index) => `holmes watson moriarty marker${index}`,
  ).join(' ');
  await page.getByLabel('Add files').setInputFiles({
    name: 'many-mentions.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(words, 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'holmes, watson, moriarty');
  await gotoPlace(page, 'matches');

  const terms = page.getByRole('complementary', { name: 'Terms' });
  await expect(terms).toBeVisible();
  await expect(page.getByRole('group', { name: 'Match terms' })).toHaveCount(0);
  for (const term of ['holmes', 'watson']) {
    const toggleMark = (await trace(page)).events.at(-1)?.seq ?? -1;
    await terms.getByRole('button', { name: `Shown in analysis: ${term}` }).click();
    await awaitFreshWindow(page, toggleMark);
  }

  const grid = page.getByRole('grid', { name: 'Matches' });
  await expect(grid).toBeVisible({ timeout: 30_000 });
  await expect(grid).toHaveAttribute('aria-rowcount', '1201');
  const occurrenceRows = grid.locator('.kwic-virtual-row[aria-rowindex]');
  await expect.poll(() => occurrenceRows.count()).toBeGreaterThan(0);
  expect(await occurrenceRows.count()).toBeLessThan(120);

  return grid;
}

export async function scrollMatchesFrames(grid: Locator) {
  return grid.evaluate(async (node) => {
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
}
