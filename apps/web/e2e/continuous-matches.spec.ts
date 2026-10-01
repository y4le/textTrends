import { expect, test } from '@playwright/test';
import { trace } from './helpers.ts';
import { awaitFreshWindow, prepareContinuousMatches, scrollMatchesFrames } from './continuous-matches-fixture.ts';

test('continuous Matches virtualizes rows and synchronizes scrolling with the shared cursor', async ({ page }) => {
  const grid = await prepareContinuousMatches(page);
  const anchoredGeometry = async () => page.locator('.kwic-grid-shell').evaluate((shell) => {
    const mark = shell.querySelector<HTMLElement>('.kwic-now-mark')!.getBoundingClientRect();
    const port = shell.querySelector<HTMLElement>('.kwic-virtual-grid')!.getBoundingClientRect();
    const active = shell.querySelector<HTMLElement>('[role="row"][aria-selected="true"]')
      ?.getBoundingClientRect();
    const expectedAnchor = Math.round(Math.min(port.height / 2, mark.height * 4));
    const markCenter = mark.top + mark.height / 2;
    return {
      markToAnchor: Math.abs(markCenter - (port.top + expectedAnchor)),
      markToActiveRow: active === undefined
        ? Number.POSITIVE_INFINITY
        : Math.abs(markCenter - (active.top + active.height / 2)),
    };
  });
  await expect.poll(async () => (await anchoredGeometry()).markToAnchor)
    .toBeLessThanOrEqual(1);
  await grid.focus();
  await grid.press('Home');
  await expect.poll(async () => (await anchoredGeometry()).markToActiveRow)
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
  const unfilledFrames = await scrollMatchesFrames(grid);
  await page.waitForTimeout(250);
  const prefetchQueries = (await trace(page)).events.filter((event) =>
    event.seq > residentMark
    && event.direction === 'to-worker'
    && event.t === 'query'
    && event.op === 'matches-window');
  expect(prefetchQueries.length).toBeGreaterThan(0);
  expect(prefetchQueries.length).toBeLessThan(6);
  expect(unfilledFrames).toEqual([]);
  await grid.focus();
  await grid.press('End');
  await expect(grid).toHaveAttribute('aria-activedescendant', 'matches-row-1199');
  await expect.poll(async () => (await anchoredGeometry()).markToActiveRow)
    .toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    const geometry = await grid.evaluate((node) => ({
      top: (node as HTMLElement).scrollTop,
      max: (node as HTMLElement).scrollHeight - (node as HTMLElement).clientHeight,
    }));
    return Math.abs((geometry.max - geometry.top) - 16);
  // Native scroll extents can round once at each edge; the independent
  // anchoredGeometry assertion above remains the stricter 1px gate.
  }).toBeLessThanOrEqual(2); // the last row is a half-pitch above the end sentinel

  await grid.press('Enter');
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: 'Return to workbench', exact: true }).click();
  await expect(grid).toBeFocused();
});
