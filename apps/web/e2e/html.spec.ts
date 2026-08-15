/**
 * HTML ingest (Phase 3) in the real browser. Uses DELIBERATELY non-well-formed
 * HTML — unclosed <p>/<li>, void <br>/<img> without self-closing, a <script>
 * that must never run or leak text — to prove the worker uses a real HTML5 tree
 * builder (parse5), not an XML parser: the body text is extracted and analyzed
 * while the script's contents are absent.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, clearDemoInputs, clearNotebook, gotoPlace, openQuickAdd } from './helpers.ts';

const MESSY_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Owl Field Notes</title>
  <script>var leak = "SCRIPTLEAKMARKER"; console.log(leak);</script>
  <style>.x { color: red }</style>
</head>
<body>
  <h1>Owl Field Notes</h1>
  <p>The barnowl hunts at dusk over the meadow.
  <p>It returns before dawn.
  <h2>Migration</h2>
  <ul>
    <li>Spring: the barnowl drifts north
    <li>Autumn: it drifts back
  </ul>
  <img src="owl.jpg" alt="a perched barnowl">
  <p>Field note ends here.<br>Recorded at length.
</body>
</html>`;

test('a non-well-formed HTML file imports, extracts body text, and analyzes it', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');

  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'owls.html',
    mimeType: 'text/html',
    buffer: Buffer.from(MESSY_HTML, 'utf-8'),
  });
  await expect(page.getByRole('region', { name: 'Inputs', exact: true })).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);

  // Body text is analyzable (parse5 recovered the unclosed <p> structure).
  await gotoPlace(page, 'trends');
  await clearNotebook(page);
  const input = await openQuickAdd(page);
  await input.fill('barnowl');
  await input.press('Enter');
  await page.getByRole('dialog', { name: 'Manage terms' }).getByRole('button', { name: 'Done', exact: true }).click();
  await gotoPlace(page, 'matches');
  const matches = page.getByRole('grid', { name: 'Matches' });
  await expect(matches).toBeVisible({ timeout: 30_000 });
  const rows = await matches.locator('[role="row"][aria-rowindex]').count();
  expect(rows).toBeGreaterThanOrEqual(2); // "barnowl" appears in body + migration list

  // The <script> content never became analyzable text (inert extraction). Wait
  // for the FINAL settled state (no occurrences), not the transient "finding
  // examples…" — a term absent from the extracted text yields zero rows.
  await gotoPlace(page, 'trends');
  await clearNotebook(page);
  const script = await openQuickAdd(page);
  await script.fill('SCRIPTLEAKMARKER');
  await script.press('Enter');
  await page.getByRole('dialog', { name: 'Manage terms' }).getByRole('button', { name: 'Done', exact: true }).click();
  await gotoPlace(page, 'matches');
  await expect(page.getByText('No occurrences of the enabled terms.')).toBeVisible({ timeout: 30_000 });
});
