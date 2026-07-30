/**
 * Slice-4 acceptance journey: explicit two-book keyness, side-restricted
 * concordance evidence, inversion on swap, and independence from the trend
 * surface's transient linked brush.
 */

import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, trace } from './helpers.ts';

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
  await page.getByLabel('Create project from files').setInputFiles([
    { name: 'alpha.md', mimeType: 'text/markdown', buffer: Buffer.from(ALPHA, 'utf-8') },
    { name: 'beta.md', mimeType: 'text/markdown', buffer: Buffer.from(BETA, 'utf-8') },
  ]);
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 2);
  await expect(page.getByRole('heading', { name: 'Compare' })).toBeVisible({ timeout: 30_000 });

  await page.getByLabel('combined docs ≥').fill('1');
  let mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'apply keyness filters' }).click();
  await awaitOps(page, mark, ['keyness']);

  const aTable = page.getByRole('table', { name: 'A-key terms' });
  const bTable = page.getByRole('table', { name: 'B-key terms' });
  const forestA = aTable.getByRole('row', { name: /^forest / });
  const seaB = bTable.getByRole('row', { name: /^sea / });
  await expect(forestA).toBeVisible();
  await expect(seaB).toBeVisible();
  const positive = Number((await forestA.locator('td').nth(2).innerText()).replace('+', ''));
  expect(positive).toBeGreaterThan(0);
  await expect(page.getByText(/Small side/)).toHaveCount(2);

  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await forestA.getByRole('button', { name: 'concordance' }).click();
  await awaitOps(page, mark, ['kwic']);
  const evidence = page.getByRole('table', { name: 'Keyness concordance' });
  await expect(evidence).toBeVisible();
  await expect(evidence.locator('tbody tr').first()).toContainText('alpha');
  await expect(evidence.locator('tbody')).not.toContainText('beta');

  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'Swap keyness sides' }).click();
  await awaitOps(page, mark, ['keyness']);
  const forestB = bTable.getByRole('row', { name: /^forest / });
  await expect(forestB).toBeVisible();
  const negative = Number((await forestB.locator('td').nth(2).innerText()).replace('−', '-'));
  expect(negative).toBeLessThan(0);
  expect(negative).toBeCloseTo(-positive, 2);

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
  await expect(forestB).toBeVisible();

  await page.getByText('method and filter notes').click();
  await expect(page.getByText(/keyness-g2-2x2\/1/)).toBeVisible();
  await expect(page.getByText(/log-ratio-halves\/1/)).toBeVisible();
  await expect(page.getByText('No confidence intervals — see method notes.')).toBeVisible();
});
