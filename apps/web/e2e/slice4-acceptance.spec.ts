/**
 * Slice-4 acceptance journey: explicit two-book keyness, side-restricted
 * comparison inversion on swap and independence from the trend
 * surface's transient linked brush.
 */

import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, clearDemoInputs, gotoPlace, trace } from './helpers.ts';

const prose = (terms: readonly string[], repetitions: number) =>
  Array.from({ length: repetitions }, () => `${terms.join(' ')}.`).join(' ');

const ALPHA = [
  '# Forest',
  prose(['forest', 'wolf', 'pine', 'common'], 30),
  '# Road',
  prose(['forest', 'carriage', 'trail', 'common'], 20),
].join('\n\n');

const BETA = [
  '# Sea',
  prose(['sea', 'wave', 'salt', 'common'], 30),
  '# Harbor',
  prose(['sea', 'sail', 'harbor', 'common'], 20),
].join('\n\n');

async function awaitOps(
  page: Page,
  mark: number,
  required: readonly string[],
): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await trace(page);
    const queries = snapshot.events.filter(
      (event) =>
        event.seq > mark
        && event.direction === 'to-worker'
        && event.t === 'query'
        && required.includes(event.op ?? ''),
    );
    const jobs = new Set(queries.map((event) => event.job));
    const results = snapshot.events.filter(
      (event) =>
        event.seq > mark
        && event.direction === 'from-worker'
        && event.t === 'result'
        && jobs.has(event.job),
    );
    const seen = new Set(queries.map((event) => event.op));
    return required.every((op) => seen.has(op)) && jobs.size === results.length
      ? 'answered'
      : `${[...seen].join(',')}:${results.length}/${jobs.size}`;
  }, { timeout: 30_000 }).toBe('answered');
}

test('slice 4: A-key/B-key → swap inversion → brush independence', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles([
    { name: 'alpha.md', mimeType: 'text/markdown', buffer: Buffer.from(ALPHA, 'utf-8') },
    { name: 'beta.md', mimeType: 'text/markdown', buffer: Buffer.from(BETA, 'utf-8') },
  ]);
  await expect(page.getByRole('region', { name: 'Inputs', exact: true })).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 2);
  await gotoPlace(page, 'compare');
  await expect(page.getByRole('region', { name: 'Compare' })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Compare settings' }).click();
  const settings = page.getByRole('form', { name: 'Compare settings' });
  await settings.getByLabel('combined documents ≥').fill('1');
  let mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await settings.getByRole('button', { name: 'apply' }).click();
  await awaitOps(page, mark, ['keyness']);

  const pyramid = page.getByRole('table', { name: 'Compare population pyramid' });
  await expect(pyramid).toHaveAttribute('aria-colcount', '2');
  await expect(pyramid.getByRole('columnheader')).toHaveCount(0);
  await expect(pyramid.locator('caption')).toContainText('shared scale over the loaded ranks');
  const forestA = pyramid.getByRole('button', { name: /^forest,/ });
  const seaB = pyramid.getByRole('button', { name: /^sea,/ });
  await expect(forestA).toBeVisible();
  await expect(seaB).toBeVisible();
  const positive = Number(
    await forestA.locator('.compare-pyramid-value').innerText(),
  );
  expect(positive).toBeGreaterThan(0);
  await expect(forestA.locator('xpath=..')).toHaveAttribute('data-side', 'a');
  await expect(seaB.locator('xpath=..')).toHaveAttribute('data-side', 'b');
  await expect(page.getByText(/Small side/)).toHaveCount(2);
  const readingOrder = await page.locator('.compare-panel').evaluate((panel) =>
    [
      '.compare-warnings',
      '.compare-definition',
      '.compare-axis-section',
    ].map((selector) => panel.querySelector(selector)?.getBoundingClientRect().top ?? -1));
  expect(readingOrder).toEqual([...readingOrder].sort((a, b) => a - b));

  await forestA.click();
  const detail = page.getByRole('region', { name: 'Compare detail: forest, side A' });
  await expect(detail.locator('dt')).toHaveCount(9);
  await expect(detail).toContainText('log₂ ratio');
  await expect(detail).toContainText('95% interval');

  await expect(page.getByRole('button', { name: 'Swap keyness sides' })).toHaveCount(0);

  await gotoPlace(page, 'trends');
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  for (let index = 0; index < 12; index++) await scrubber.press('ArrowRight');
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scrubber.press('Enter');
  await awaitOps(page, mark, ['inventory', 'freq-list']);
  const brushQueries = (await trace(page)).events.filter(
    (event) => event.seq > mark && event.direction === 'to-worker' && event.t === 'query',
  );
  expect(brushQueries.some((event) => event.op === 'keyness')).toBe(false);
  await gotoPlace(page, 'compare');
  await expect(pyramid.getByRole('button', { name: /^forest,/ })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
});
