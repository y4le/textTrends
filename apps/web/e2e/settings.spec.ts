import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';

test('Trend settings separate result geometry from resident presentation', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  const contextualSettings = page.locator('.trend-panel-header')
    .getByRole('button', { name: 'Trend settings', exact: true });
  await expect(page.locator('.app-header')
    .getByRole('button', { name: 'Trend settings', exact: true })).toHaveCount(0);
  const historyBefore = await page.evaluate(() => history.length);
  await contextualSettings.click();
  let pane = page.getByRole('dialog', { name: 'Settings' });
  let settings = pane.getByRole('form', { name: 'Trend settings' });
  await expect(settings.getByRole('combobox', { name: 'Bins', exact: true })).toBeFocused();
  const landing = await pane.evaluate((element) => {
    const body = element.querySelector<HTMLElement>('.utility-pane-body');
    const heading = element.querySelector<HTMLElement>('#settings-place-heading');
    if (!body || !heading) return null;
    return {
      bodyTop: body.getBoundingClientRect().top,
      headingTop: heading.getBoundingClientRect().top,
    };
  });
  expect(landing).not.toBeNull();
  expect(Math.abs(landing!.bodyTop - landing!.headingTop)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);

  const geometryMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await settings.getByRole('combobox', { name: 'Bins', exact: true }).selectOption('fixed-tokens');
  const binCount = settings.getByRole('spinbutton', { name: 'Tokens per bin', exact: true });
  const extentStatus = settings.getByRole('status').filter({ hasText: 'Corpus token extents are ready.' });
  await expect(extentStatus).toHaveText('Corpus token extents are ready.');
  await expect(binCount).toHaveAttribute('aria-describedby', 'trend-bin-guidance');
  await binCount.fill('');
  await expect(extentStatus).toHaveText('Corpus token extents are ready.');
  await expect(settings.locator('#trend-bin-guidance')).not.toContainText('∞');
  await binCount.fill('250');
  await settings.getByRole('combobox', { name: 'Measure', exact: true }).selectOption('count');
  await settings.getByRole('button', { name: 'Apply', exact: true }).click();

  await expect.poll(async () => {
    const queries = (await trace(page)).events.filter((event) =>
      event.seq > geometryMark
      && event.direction === 'to-worker'
      && event.t === 'query');
    return queries.length > 0 && queries.every((event) => event.op === 'trend');
  }).toBe(true);
  await expect(page.getByText(/counts · 250 tokens per bin · unsmoothed/)).toHaveCount(0);
  await expect(page.locator('#trend-settings-open')).toHaveCount(1);
  await expect(page.getByRole('img', { name: /^Counts of / })).toBeVisible();
  await expect(pane).toHaveCount(0);
  await expect(contextualSettings).toBeFocused();

  const displayMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await contextualSettings.click();
  pane = page.getByRole('dialog', { name: 'Settings' });
  settings = pane.getByRole('form', { name: 'Trend settings' });
  await settings.getByRole('combobox', { name: 'Measure', exact: true }).selectOption('rate');
  await settings.getByRole('combobox', { name: 'Smoothing', exact: true }).selectOption('5');
  await settings.getByLabel('Show raw line behind smoothed line').check();
  await settings.getByRole('button', { name: 'Apply', exact: true }).click();

  const displayQueries = (await trace(page)).events.filter((event) =>
    event.seq > displayMark
    && event.direction === 'to-worker'
    && event.t === 'query');
  expect(displayQueries).toEqual([]);
  await expect(page.locator('[data-raw-series-path]')).not.toHaveCount(0);
  await expect(pane).toHaveCount(0);
  await gotoPlace(page, 'inputs');
  await expect(page.getByRole('table', { name: /Text details · full corpus/ })
    .getByRole('columnheader', { name: /\/10,000/ }).first()).toBeVisible();
});
