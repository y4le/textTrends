/**
 * Main-thread responsiveness (plan M6 bullet; M6 consult §9): the Long
 * Tasks API records every >= 50 ms main-window task from BEFORE app
 * modules execute; the gate initially fails only tasks >= 100 ms inside
 * the analysis window (first begin-generation post -> last settled
 * result). Worker compute never appears here — the claim is that the app
 * STAYS RESPONSIVE while analysis, delivery, and rendering happen.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, submitAndAwaitFreshResults, trace } from './helpers.ts';

test.use({ viewport: { width: 1280, height: 900 } });

test('no main-thread task reaches 100ms during cold analysis and a query burst', async ({ page, context }, testInfo) => {
  await context.addInitScript(() => {
    const tasks: { start: number; duration: number; name: string }[] = [];
    (window as unknown as { __ttLongTasks: typeof tasks }).__ttLongTasks = tasks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        tasks.push({ start: entry.startTime, duration: entry.duration, name: entry.name });
      }
    }).observe({ type: 'longtask', buffered: true });
  });

  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  // Query burst across the loaded corpus — each submission is awaited by
  // ITS OWN fresh job's result, so the analysis window provably contains
  // the burst's delivery (review round 1: unscoped counts were satisfied
  // by cold-load results before any burst work).
  let lastFresh = null as Awaited<ReturnType<typeof submitAndAwaitFreshResults>> | null;
  for (const terms of ['watson, lestrade', 'moriarty, mycroft, adler', 'holmes, watson']) {
    lastFresh = await submitAndAwaitFreshResults(page, terms);
  }
  // Let the burst's final render settle INSIDE the gated window — render is
  // part of the responsiveness claim.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const windowEnd = await page.evaluate(() => performance.now());

  const t = await trace(page);
  const beginAt = t.events.find((e) => e.direction === 'to-worker' && e.t === 'begin-generation')?.at ?? 0;
  // EVERY fresh job of the final submission delivered inside the window.
  const lastDeliveryAt = Math.max(...lastFresh!.map((e) => e.at));
  expect(lastDeliveryAt).toBeLessThanOrEqual(windowEnd);
  const lastResultAt = windowEnd;

  const longTasks = await page.evaluate(
    () => (window as unknown as { __ttLongTasks: { start: number; duration: number; name: string }[] }).__ttLongTasks,
  );
  // Record EVERYTHING >= 50ms for the report; gate only >= 100ms inside the
  // analysis window (no browser baseline exists yet — M6 consult §9).
  await testInfo.attach('long-tasks.json', {
    body: JSON.stringify({ window: { beginAt, lastResultAt }, longTasks }, null, 2),
    contentType: 'application/json',
  });
  const gated = longTasks.filter((task) => task.duration >= 100 && task.start >= beginAt && task.start <= lastResultAt);
  expect(gated, JSON.stringify(gated)).toEqual([]);
});
