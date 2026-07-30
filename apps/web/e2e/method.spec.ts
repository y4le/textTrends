import { expect, test } from '@playwright/test';

test('Method exposes visible, copyable provenance and result text', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByText('6/6 books ready')).toBeVisible();
  const method = page.locator('details.method-summary');
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
  await expect(page.getByText('6/6 books ready')).toBeVisible();
  const method = page.locator('details.method-summary');
  await method.locator('summary').click();
  await method.getByRole('button', { name: 'copy result as TSV' }).click();
  const prepared = method.getByTestId('prepared-export');
  const baseline = await prepared.textContent();
  expect(baseline).toContain('\t1095\t');

  const plot = page.getByRole('slider', { name: 'Reading position scrubber' });
  await plot.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('s');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('region', { name: 'Scope' })).toContainText(/tokens 1–/);
  await expect(method.locator('summary')).toContainText('complete');
  await method.getByRole('button', { name: 'copy result as TSV' }).click();
  await expect(prepared).toContainText(/# Selection: .* tokens 1–/);
  const selected = await prepared.textContent();
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
