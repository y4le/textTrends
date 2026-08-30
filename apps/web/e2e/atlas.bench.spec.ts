/**
 * Atlas responsiveness gate from the spatial-reader contract: the shipped
 * 66-book Bible with five exact tracks. The Long Tasks API records every
 * >=50 ms main-window task; only tasks >=100 ms inside Atlas first paint or
 * a real horizontal wheel fling fail the existing repository budget. Window
 * elapsed times are descriptive only; this is a single-task responsiveness
 * gate, not a wall-clock rendering budget.
 */

import { expect, test } from '@playwright/test';
import { BIBLE } from '../src/lib/project.ts';
import { awaitReadyCount, gotoPlace, submitAndAwaitFreshResults } from './helpers.ts';

const TRACKS = ['God', 'Israel', 'Jesus', 'king', 'lord'] as const;

interface LongTaskRecord {
  readonly start: number;
  readonly duration: number;
  readonly name: string;
}

test.use({ viewport: { width: 1440, height: 900 } });

async function settlePaint(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
  }));
}

test('66-text Atlas first paint and horizontal fling stay below the long-task gate', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(240_000);
  await context.addInitScript(() => {
    const tasks: LongTaskRecord[] = [];
    (window as unknown as { __ttAtlasLongTasks: LongTaskRecord[] }).__ttAtlasLongTasks = tasks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        tasks.push({ start: entry.startTime, duration: entry.duration, name: entry.name });
      }
    }).observe({ type: 'longtask', buffered: true });
  });

  await page.goto('./?demo=bible&p=trends');
  await awaitReadyCount(page, BIBLE.length, 120_000);
  await submitAndAwaitFreshResults(page, TRACKS.join(', '));
  await gotoPlace(page, 'matches');

  const grid = page.getByRole('grid', { name: 'Matches' });
  const occurrence = grid.locator('.kwic-virtual-row .kwic-node button').first();
  await expect(occurrence).toBeVisible({ timeout: 30_000 });
  await occurrence.click();
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader.locator('[data-reader-page]')).toBeVisible();

  const firstPaintStart = await page.evaluate(() => {
    return performance.now();
  });
  await reader.getByRole('button', { name: 'Atlas', exact: true }).click();

  const plane = reader.locator('#reader-atlas-plane');
  const columns = reader.locator('[data-atlas-column]');
  await expect(columns).toHaveCount(BIBLE.length);
  await expect(plane).toBeVisible();
  await expect.poll(async () => {
    const descriptions = await columns.locator('footer .visually-hidden').allInnerTexts();
    return descriptions.length === BIBLE.length
      && descriptions.every((description) =>
        (description.match(/exact occurrence/g) ?? []).length === TRACKS.length
        && !description.includes('density band'));
  }, { timeout: 30_000, message: 'all 66 Atlas columns did not expose five exact tracks' })
    .toBe(true);
  const canvasBudget = await plane.evaluate((element) => {
    const shells = element.querySelectorAll<HTMLElement>('[data-atlas-column]');
    const pitch = (shells[1]?.offsetLeft ?? 0) - (shells[0]?.offsetLeft ?? 0);
    if (pitch <= 0) throw new Error('Atlas columns do not expose a positive pitch');
    // atlasCanvasWindow can span ceil(viewport / pitch) + 1 visible columns,
    // plus two columns of overscan per side. Active and ruler-focused texts
    // may each retain one additional canvas outside that window.
    return Math.ceil(element.clientWidth / pitch) + 1 + 2 * 2 + 2;
  });
  const firstPaintEnd = await settlePaint(page);
  const firstPaintCanvases = await reader.locator('[data-atlas-canvas]').count();
  expect(firstPaintCanvases).toBeLessThanOrEqual(canvasBudget);
  expect(firstPaintCanvases).toBeLessThan(BIBLE.length);

  const scrollBefore = await plane.evaluate((element) => element.scrollLeft);
  const flingStart = await page.evaluate(() => performance.now());
  const box = await plane.boundingBox();
  if (box === null) throw new Error('Atlas plane has no layout box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (const deltaX of [720, 960, 1_200]) await page.mouse.wheel(deltaX, 0);
  await expect.poll(() => plane.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(scrollBefore + 500);
  const flingEnd = await settlePaint(page);
  const flingCanvases = await reader.locator('[data-atlas-canvas]').count();
  expect(flingCanvases).toBeLessThanOrEqual(canvasBudget);
  expect(await plane.evaluate((element) => element.scrollLeft)).toBeGreaterThan(scrollBefore);

  // Give the observer callback one ordinary task to publish the final entry;
  // filtering remains bounded by the recorded Atlas windows below.
  await page.waitForTimeout(100);
  const longTasks = await page.evaluate(() => (
    window as unknown as { __ttAtlasLongTasks: LongTaskRecord[] }
  ).__ttAtlasLongTasks);
  const windows = {
    firstPaint: { start: firstPaintStart, end: firstPaintEnd },
    horizontalFling: { start: flingStart, end: flingEnd },
  };
  const attributed = longTasks.filter((task) => Object.values(windows).some(
    (window) => task.start <= window.end && task.start + task.duration >= window.start,
  ));
  const gated = attributed.filter((task) => task.duration >= 100);

  await testInfo.attach('atlas-long-tasks.json', {
    body: JSON.stringify({
      corpus: { name: 'World English Bible', documents: BIBLE.length },
      tracks: TRACKS,
      representations: 'exact',
      canvasBudget,
      canvases: { firstPaint: firstPaintCanvases, horizontalFling: flingCanvases },
      windows,
      longTasks,
      attributed,
      gated,
    }, null, 2),
    contentType: 'application/json',
  });
  console.log(
    `[bench] Atlas 66×5 exact · canvases ${firstPaintCanvases}/${flingCanvases}`
      + ` of ${canvasBudget}`
      + ` · first paint ${(firstPaintEnd - firstPaintStart).toFixed(1)}ms`
      + ` · fling ${(flingEnd - flingStart).toFixed(1)}ms`
      + ` · long tasks ${attributed.length} Atlas / ${longTasks.length} total`
      + ` · gated ${gated.length}`,
  );
  expect(gated, JSON.stringify(gated)).toEqual([]);
});
