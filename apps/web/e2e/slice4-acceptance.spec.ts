/**
 * Slice-4 acceptance journey: explicit two-book keyness, side-restricted
 * concordance evidence, inversion on swap, and independence from the trend
 * surface's transient linked brush.
 */

import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, gotoPlace, trace } from './helpers.ts';

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

test('slice 4: A-key/B-key → side evidence → swap inversion → brush independence', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');
  await page.getByLabel('Create project from files').setInputFiles([
    { name: 'alpha.md', mimeType: 'text/markdown', buffer: Buffer.from(ALPHA, 'utf-8') },
    { name: 'beta.md', mimeType: 'text/markdown', buffer: Buffer.from(BETA, 'utf-8') },
  ]);
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 2);
  await gotoPlace(page, 'compare');
  await expect(page.getByRole('heading', { name: 'Compare' })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'sort and filter' }).click();
  const settings = page.getByRole('form', { name: 'Compare sort and filter' });
  await settings.getByLabel('combined documents ≥').fill('1');
  let mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await settings.getByRole('button', { name: 'apply' }).click();
  await awaitOps(page, mark, ['keyness']);

  const signedAxis = page.getByRole('table', { name: 'Compare signed axis' });
  await expect(signedAxis).toHaveAttribute('aria-colcount', '3');
  await expect(signedAxis.getByRole('columnheader')).toHaveCount(3);
  await expect(signedAxis.locator('caption')).toContainText('page-local log₂-ratio scale');
  const sideA = signedAxis.getByRole('rowgroup', { name: /^Side A ·/ });
  const sideB = signedAxis.getByRole('rowgroup', { name: /^Side B ·/ });
  await expect(sideA).toHaveAttribute('aria-label', /5 projected terms$/);
  await expect(sideB).toHaveAttribute('aria-label', /5 projected terms$/);
  const forestA = sideA.getByRole('row', { name: /^forest / });
  const seaB = sideB.getByRole('row', { name: /^sea / });
  await expect(forestA).toBeVisible();
  await expect(seaB).toBeVisible();
  const positive = Number(
    (await forestA.locator('.compare-effect-value').innerText()).replace('+', ''),
  );
  expect(positive).toBeGreaterThan(0);
  await expect(page.getByText(/Small side/)).toHaveCount(2);
  const readingOrder = await page.locator('.compare-panel').evaluate((panel) =>
    [
      '.compare-definition',
      '.compare-side-summaries',
      '.compare-warnings',
      '.compare-view-bar',
      '.compare-axis-section',
    ].map((selector) => panel.querySelector(selector)?.getBoundingClientRect().top ?? -1));
  expect(readingOrder).toEqual([...readingOrder].sort((a, b) => a - b));

  await forestA.getByRole('button', { name: /forest/ }).click();
  const detail = page.getByRole('region', { name: 'Compare detail: forest, side A' });
  await expect(detail.locator('dt')).toHaveCount(11);
  await expect(detail).toContainText(`log₂ ratio${(positive >= 0 ? '+' : '')}${positive}`);
  await expect(detail).toContainText('Evidence is restricted to side A');
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await detail
    .getByRole('button', { name: 'show evidence' })
    .click();
  await awaitOps(page, mark, ['kwic']);
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  const evidenceSheet = page.getByRole('dialog', { name: 'Evidence sheet' });
  const evidence = evidenceSheet.getByRole('table', { name: 'Comparison occurrence evidence' });
  await expect(evidence).toBeVisible();
  await expect(evidence.locator('tbody tr').first()).toContainText('alpha');
  await expect(evidence.locator('tbody')).not.toContainText('beta');
  const occurrences = page.locator('.comparison-occurrences');
  await expect(occurrences).toHaveAttribute(
    'aria-label',
    'Occurrences of “forest” restricted to side A: alpha',
  );
  await occurrences.getByRole('button', { name: 'inspect' }).first().click();
  await expect(evidenceSheet).toContainText('alpha');

  const read = occurrences.getByRole('button', { name: 'Read' }).first();
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await read.click();
  await awaitOps(page, mark, ['reader-page']);
  await expect(page.getByRole('main', { name: /Reader: alpha/ })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);
  await expect(read).toBeFocused();
  await occurrences.getByRole('button', { name: 'dismiss' }).click();
  await expect(occurrences).toHaveCount(0);
  await evidenceSheet.getByRole('button', { name: 'Close Evidence sheet' }).click();
  await expect(evidenceSheet).toHaveCount(0);

  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'Swap keyness sides' }).click();
  await awaitOps(page, mark, ['keyness']);
  const forestB = sideB.getByRole('row', { name: /^forest / });
  await expect(forestB).toBeVisible();
  const negative = Number(
    (await forestB.locator('.compare-effect-value').innerText()).replace('−', '-'),
  );
  expect(negative).toBeLessThan(0);
  expect(negative).toBeCloseTo(-positive, 2);
  await expect(detail).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Compare', exact: true })).toBeFocused();

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
  await expect(forestB).toBeVisible();

  await page.getByRole('button', { name: 'Method', exact: true }).click();
  const method = page.getByRole('dialog', { name: 'Method sheet' });
  await method.locator('details.method-summary > summary').click();
  await expect(method.getByText('keyness-g2-2x2/1', { exact: true })).toBeVisible();
  await expect(method.getByText('log-ratio-halves/1', { exact: true })).toBeVisible();
  await expect(page.getByText(/No confidence intervals are available/)).toBeVisible();
});
