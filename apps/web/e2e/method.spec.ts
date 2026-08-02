import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';

test('Trend settings separate result geometry from resident presentation', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await page.getByRole('button', { name: 'Method & settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Method & settings sheet' });
  const settings = sheet.getByRole('form', { name: 'Trend settings' });

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
  await expect(page.getByText(/counts · 250 tokens per bin · unsmoothed/)).toBeVisible();
  await expect(page.getByRole('img', { name: /^Counts of / })).toBeVisible();

  const displayMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await settings.getByRole('combobox', { name: 'Measure', exact: true }).selectOption('rate');
  await settings.getByRole('combobox', { name: 'Rate denominator', exact: true }).selectOption('100000');
  await settings.getByRole('combobox', { name: 'Smoothing', exact: true }).selectOption('5');
  await settings.getByLabel('Show raw line behind smoothed line').check();
  await settings.getByRole('button', { name: 'Apply', exact: true }).click();

  const displayQueries = (await trace(page)).events.filter((event) =>
    event.seq > displayMark
    && event.direction === 'to-worker'
    && event.t === 'query');
  expect(displayQueries).toEqual([]);
  await expect(page.getByText(/rate per 100,000 tokens · 250 tokens per bin · 5-bin rolling mean · raw behind/)).toBeVisible();
  await expect(page.locator('[data-raw-series-path]')).not.toHaveCount(0);
});

test('Method exposes visible, copyable provenance and result text', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByText('6/6 books ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Method & settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Method & settings sheet' });
  const method = sheet.locator('details.method-summary');
  await expect(method.locator('summary')).toContainText('trend');
  await method.locator('summary').click();

  await expect(method.getByText('rate per 10,000 selected tokens')).toBeVisible();
  await expect(method.getByText('declared-sequence')).toBeVisible();
  await expect(method.getByText('none', { exact: true })).toBeVisible();

  await method.getByRole('button', { name: 'copy provenance' }).click();
  const prepared = method.getByTestId('prepared-export');
  await expect(prepared).toContainText('textTrends provenance (texttrends/provenance/1)');
  await expect(prepared).toContainText('Place: trends');
  await expect(prepared).toContainText(/Snapshot: [0-9a-f]{64}/);

  await method.getByRole('button', { name: 'copy result as TSV' }).click();
  await expect(prepared).toContainText('# Result: Trends');
  await expect(prepared).toContainText('series\tdocument\tbin');
  await expect(prepared).toContainText('# Method: trend');
});

test('Method range provenance and TSV use the selected overlay, never the retained baseline', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByText('6/6 books ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Method & settings', exact: true }).click();
  let sheet = page.getByRole('dialog', { name: 'Method & settings sheet' });
  let method = sheet.locator('details.method-summary');
  await method.locator('summary').click();
  await method.getByRole('button', { name: 'copy result as TSV' }).click();
  const prepared = method.getByTestId('prepared-export');
  const baseline = await prepared.textContent();
  expect(baseline).toContain('\t1095\t');
  await sheet.getByRole('button', { name: 'Close Method & settings sheet' }).click();
  await expect(sheet).toHaveCount(0);

  const plot = page.getByRole('slider', { name: 'Reading position scrubber' });
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 80);
  await expect(page.getByRole('region', { name: 'Trends', exact: true })
    .getByText(/A Study in Scarlet · token \d+ of/)).toBeVisible();
  await plot.focus();
  await plot.press('s');
  await expect(page.getByText(/Selecting .*tokens \d+–\d+/)).toBeVisible();
  await plot.press('ArrowRight');
  await plot.press('ArrowRight');
  await plot.press('Enter');

  await expect(page.getByText(/Selected 3 tokens in/)).toBeVisible();
  await page.getByRole('button', { name: 'Method & settings', exact: true }).click();
  sheet = page.getByRole('dialog', { name: 'Method & settings sheet' });
  method = sheet.locator('details.method-summary');
  const selectedPrepared = method.getByTestId('prepared-export');
  await expect(method.locator('summary')).toContainText('complete');
  await method.locator('summary').click();
  await method.getByRole('button', { name: 'copy result as TSV' }).click();
  await expect(selectedPrepared).toContainText(/# Selection: .* tokens \d+–\d+/);
  const selected = await selectedPrepared.textContent();
  expect(selected).not.toBe(baseline);
  const dataRows = selected!
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('series\t'))
    .map((line) => line.split('\t'));
  expect(new Set(dataRows.map((row) => row[1]))).toEqual(new Set([
    '1 - A Study in Scarlet - Arthur Conan Doyle',
  ]));
  expect(Math.max(...dataRows.map((row) => Number(row[4])))).toBeLessThanOrEqual(3);
});

test('Findings Method exposes the bounded current-state register and governed TSV', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await awaitAllReady(page);
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('p');
  await gotoPlace(page, 'findings');
  await expect(page.getByRole('region', { name: 'Saved excerpts' }))
    .toContainText('1 saved · limit 8');
  await expect(page.getByText('research changes waiting to save')).toBeVisible();
  await expect(page.getByText('research state saved locally')).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole('button', { name: 'Method', exact: true }).click();
  const method = page
    .getByRole('dialog', { name: 'Method sheet' })
    .locator('details.method-summary');
  await expect(method.locator('summary')).toContainText('research log');
  await method.locator('summary').click();
  await expect(method).toContainText('current-state register');
  await expect(method).toContainText('saved excerpts');
  await expect(method).toContainText('1');
  await expect(method).toContainText('not an event history');

  await method.getByRole('button', { name: 'copy result as TSV' }).click();
  const prepared = method.getByTestId('prepared-export');
  await expect(prepared).toContainText('# Result: Findings research log');
  await expect(prepared).toContainText(
    'kind\tid\tname_or_note\tdocument\tchar_start\tchar_end\ttext_hash\ttoken\tcaptured_tracks\tstatus',
  );
  await expect(prepared).toContainText('pinned_evidence');
  await expect(prepared).not.toContainText('CHAPTER I. MR. SHERLOCK HOLMES');
});
