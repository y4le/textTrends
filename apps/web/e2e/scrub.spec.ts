/**
 * Scrub-isolation regression (Phase B ruling): moving the reading cursor —
 * pointer or keyboard, in both chart views — must never re-commit the chart
 * SVG. The proof is a deterministic commit COUNT (an e2e-only probe inside
 * each chart view records every React commit of that subtree), not a flaky
 * wall-clock budget: scrub across many frames, assert the slider value,
 * caption, and cursor all moved while the active view's commit count stayed
 * frozen — then change the view and the width to prove the probe itself is
 * live (the counter must increment when the chart legitimately re-renders).
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, submitAndAwaitFreshResults } from './helpers.ts';

const commits = (page: import('@playwright/test').Page, view: 'series' | 'by-book') =>
  page.evaluate(
    (v) => (window as unknown as { __ttChartCommits?: Record<string, number> }).__ttChartCommits?.[v] ?? 0,
    view,
  );

test('scrubbing moves the cursor without re-committing the chart', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await submitAndAwaitFreshResults(page, 'holmes');

  const scrubber = page.getByRole('slider', { name: /reading position/i });
  const seriesChart = page.locator('svg[data-trend-view="series"]');
  const cursor = page.getByTestId('chart-cursor');
  await expect(scrubber).toBeVisible();
  await expect(seriesChart).toBeVisible();
  const seriesBounds = await seriesChart.boundingBox();
  const viewport = page.viewportSize()!;
  expect(seriesBounds).not.toBeNull();
  expect(Math.abs(
    seriesBounds!.x - (viewport.width - seriesBounds!.x - seriesBounds!.width),
  )).toBeLessThanOrEqual(1);
  const axis = await seriesChart.locator('[data-trend-axis="series"]').evaluate((element) => ({
    x1: Number(element.getAttribute('x1')),
    x2: Number(element.getAttribute('x2')),
    chartWidth: element.closest('svg')?.getBoundingClientRect().width ?? 0,
  }));
  expect(axis.x1).toBe(0);
  expect(Math.abs(axis.x2 - axis.chartWidth)).toBeLessThanOrEqual(1);
  await expect(seriesChart.getByText('holmes', { exact: true })).toHaveCount(0);
  const seriesBaseline = await commits(page, 'series');
  expect(seriesBaseline).toBeGreaterThan(0);

  // Keyboard scrub across many frames: value, caption, and cursor move.
  await scrubber.focus();
  for (let i = 0; i < 20; i += 1) await scrubber.press('ArrowRight');
  await expect(scrubber).toHaveAttribute('aria-valuenow', '20');
  await expect(scrubber).toHaveAttribute('aria-valuetext', /token 21 of/);
  await expect(cursor).toBeVisible();
  const keyboardTransform = await cursor.evaluate((el) => (el as HTMLElement).style.transform);

  // Pointer scrub: many coalesced samples across the plot.
  const box = (await scrubber.boundingBox())!;
  await page.mouse.move(box.x + 120, box.y + 60);
  await page.mouse.move(box.x + 340, box.y + 80, { steps: 15 });
  await expect
    .poll(async () => cursor.evaluate((el) => (el as HTMLElement).style.transform))
    .not.toBe(keyboardTransform);

  // The load-bearing assertion: all of that motion committed ZERO chart renders.
  expect(await commits(page, 'series')).toBe(seriesBaseline);

  // Probe liveness 1: switching views really commits the other chart.
  await page.getByRole('button', { name: 'by book' }).click();
  await expect.poll(() => commits(page, 'by-book')).toBeGreaterThan(0);
  await expect(page.locator('svg[data-trend-view="by-book"] text')).toHaveCount(0);
  const byBookBaseline = await commits(page, 'by-book');

  // Cursor stays frozen-chart in the by-book view too.
  await scrubber.focus();
  for (let i = 0; i < 10; i += 1) await scrubber.press('ArrowRight');
  await expect(cursor).toBeVisible();
  expect(await commits(page, 'by-book')).toBe(byBookBaseline);

  // Probe liveness 2: a genuine geometry change (viewport width → plotW)
  // must increment the counter — proving the frozen counts above are not a
  // dead probe.
  await page.setViewportSize({ width: viewport.width + 200, height: viewport.height });
  await expect.poll(() => commits(page, 'by-book')).toBeGreaterThan(byBookBaseline);
});
