/**
 * Commit 9a — multi-file import: every selected source TRANSFERS (byteLength 0
 * after post, never a clone) and every file finalizes in DECLARED SELECTION
 * order, not async completion order. Files are given unique byte lengths so the
 * transfer multiset is unambiguous.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, gotoPlace, trace } from './helpers.ts';

/** Three files with DISTINCT byte lengths (padded) and distinct headings. */
function fixtures() {
  const mk = (base: string, heading: string, pad: number) => {
    const buffer = Buffer.from(`# ${heading}\n\nthe wolf ran far.${' '.repeat(pad)}\n`, 'utf-8');
    return { name: `${base}.md`, mimeType: 'text/markdown', buffer, title: base, len: buffer.byteLength };
  };
  return [mk('alpha', 'One', 0), mk('beta', 'Two', 7), mk('gamma', 'Three', 21)];
}

test('multi-file import transfers every source and finalizes in selection order', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'inputs');

  const files = fixtures();
  const lengths = files.map((f) => f.len);
  expect(new Set(lengths).size).toBe(files.length); // distinct — multiset is unambiguous

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByLabel('Create project from files').setInputFiles(files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.buffer })));

  await expect(page.getByRole('heading', { name: 'library corpus', exact: true })).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, files.length);

  // Every source transferred: exactly N ingests since the mark, each detached
  // (0 after), and the before-length multiset equals the file lengths.
  await expect
    .poll(async () => {
      const t = await trace(page);
      // An exact count is an absence claim (no fourth ingest) — a bounded trace
      // that dropped events would invalidate it.
      if (t.dropped !== 0) return 'trace dropped events';
      const ingests = t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'ingest' && e.transferBytesAfter !== undefined);
      if (ingests.length < files.length) return `only ${ingests.length} ingests`;
      if (!ingests.every((e) => e.transferBytesAfter === 0)) return 'a source was not detached';
      const before = ingests.map((e) => e.transferBytesBefore).sort((a, b) => (a ?? 0) - (b ?? 0));
      return JSON.stringify(before) === JSON.stringify([...lengths].sort((a, b) => a - b)) ? 'all transferred' : `lengths ${JSON.stringify(before)}`;
    }, { timeout: 30_000, message: 'not every source transferred with the expected lengths' })
    .toBe('all transferred');

  // Declared SELECTION order (the order authority), not completion order.
  await expect(page.getByLabel('Document to preview').locator('option')).toHaveText(files.map((f) => f.title));
});
