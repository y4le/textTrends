/**
 * Commit 9a — decoder policy in the real browser (§12.4). A UTF-16LE BOM is
 * authoritative (distinct detected encoding); an invalid-UTF-8 file falls back
 * to the TOTAL Windows-1252 decoder (0 inserted replacements, a persistent
 * inferred badge, and C1 controls surfaced as extraction evidence). The badge
 * and per-session evidence come from the finalized doc + source-ready, proving
 * the whole decode→extract→structure path ran on the correctly-decoded text.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount } from './helpers.ts';

test('a UTF-16LE BOM is detected and decoded (distinct encoding badge)', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);

  // FF FE + UTF-16LE code units. The heading is recognized on the DECODED text.
  const text = '# Chapter A\n\nthe wolf ran far over the hill.\n';
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  await page.getByLabel('Create project from files').setInputFiles({ name: 'utf16.md', mimeType: 'text/markdown', buffer: bytes });

  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);
  // Extraction ran on the decoded text: the heading became a chapter.
  await expect(page.getByRole('region', { name: 'Chapter structure' })
    .getByText('Chapter A', { exact: true })).toBeVisible({ timeout: 30_000 });
  // The durable descriptor reports the BOM-detected encoding, not utf-8.
  await expect(page.getByText(/encoding: utf-16le/)).toBeVisible();
});

test('an invalid-UTF-8 file falls back to Windows-1252 with 0 replacements and a C1 control', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);

  // 0x92 (1252 ') and 0x81 (1252 → U+0081, a C1 control) are BOTH lone
  // continuation bytes → the file is not valid UTF-8 → 1252 fallback. 1252 is
  // total, so NO replacement chars are inserted; the C1 byte is suspicious.
  const bytes = Buffer.concat([
    Buffer.from('# Chapter 1\n\nThe caf', 'ascii'),
    Buffer.from([0x92]),
    Buffer.from(' was warm.', 'ascii'),
    Buffer.from([0x81]),
    Buffer.from(' The end.\n', 'ascii'),
  ]);
  await page.getByLabel('Create project from files').setInputFiles({ name: 'legacy.txt', mimeType: 'text/plain', buffer: bytes });

  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);
  // The inferred-encoding badge, exact wording.
  await expect(page.getByText('Windows-1252 (inferred — no BOM/UTF-8)')).toBeVisible({ timeout: 30_000 });
  // A total decoder inserts ZERO replacements; the C1 byte is a suspicious control.
  await expect(page.getByText(/0 replaced, [1-9]\d* control chars/)).toBeVisible();
});
