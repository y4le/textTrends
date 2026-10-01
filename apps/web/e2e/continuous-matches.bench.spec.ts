import { expect, test } from '@playwright/test';
import { trace } from './helpers.ts';
import { awaitFreshWindow, prepareContinuousMatches, scrollMatchesFrames } from './continuous-matches-fixture.ts';

test('continuous Matches scrolling has no long tasks of 100ms or more', async ({ page, context }, testInfo) => {
  await context.addInitScript(() => {
    const tasks: { start: number; duration: number }[] = [];
    (window as unknown as { __ttMatchesLongTasks: typeof tasks }).__ttMatchesLongTasks = tasks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  });
  const grid = await prepareContinuousMatches(page);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await grid.evaluate((node) => {
    const port = node as HTMLElement;
    port.scrollTop = (port.scrollHeight - port.clientHeight) / 2;
  });
  await awaitFreshWindow(page, mark);
  const scrollWindowStart = await page.evaluate(() => performance.now());
  expect(await scrollMatchesFrames(grid)).toEqual([]);
  await page.waitForTimeout(250);
  const scrollWindowEnd = await page.evaluate(() => performance.now());
  const longTasks = await page.evaluate(() => (window as unknown as {
    __ttMatchesLongTasks: { start: number; duration: number }[];
  }).__ttMatchesLongTasks);
  await testInfo.attach('continuous-matches-long-tasks.json', {
    body: JSON.stringify({ window: { scrollWindowStart, scrollWindowEnd }, longTasks }, null, 2),
    contentType: 'application/json',
  });
  expect(longTasks.filter((task) => task.duration >= 100
    && task.start >= scrollWindowStart && task.start <= scrollWindowEnd)).toEqual([]);
});
