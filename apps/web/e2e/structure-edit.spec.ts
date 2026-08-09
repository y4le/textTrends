/**
 * Commit 8c chapter-correction smoke (a down-payment on commit 9's structure
 * matrix): import a Markdown file with two headings, open the chapter editor,
 * retitle a chapter, Apply, and prove the correction round-trips through the
 * REAL worker — a new generation composes a structure whose first chapter now
 * carries the user's title with `your correction` provenance, and the panel
 * reports the correction active.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace } from './helpers.ts';

const BOOK_MD = '# Alpha\n\nthe wolf ran far over the hill.\n\n# Beta\n\na wolf slept by the door.\n';

function mdFile() {
  return { name: 'book.md', mimeType: 'text/markdown', buffer: Buffer.from(BOOK_MD, 'utf-8') };
}

test('import md → edit a chapter title → apply → correction round-trips', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page); // built-in Sherlock is the read-only default
  await gotoPlace(page, 'catalog');

  // ── Create a user project from a Markdown file with two chapters. ──
  await page.getByLabel('Create project from files').setInputFiles(mdFile());
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });

  // The chapter panel shows the two detected headings.
  const chapters = page.getByRole('region', { name: 'Chapter structure' });
  await expect(chapters.getByText('Alpha', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(chapters.getByText('Beta', { exact: true })).toBeVisible();

  // ── Open the editor and retitle the first chapter. ──
  await page.getByRole('button', { name: 'edit chapters' }).click();
  await expect(page.getByLabel('Editable chapters')).toBeVisible({ timeout: 30_000 });
  const firstTitle = page.locator('input[aria-label^="Title for"]').first();
  await expect(firstTitle).toHaveValue('Alpha');
  await firstTitle.fill('Renamed Alpha');

  // ── Apply: the fenced async command hashes, installs the override, reopens. ──
  await chapters.getByRole('button', { name: 'apply', exact: true }).click();

  // A new generation composes the corrected structure: the panel reports the
  // correction active and the outline shows the user's title + provenance.
  await expect(page.getByText('your chapter correction is applied.')).toBeVisible({ timeout: 30_000 });
  await expect(chapters.getByText('Renamed Alpha', { exact: true })).toBeVisible();
  await expect(page.getByText('your correction').first()).toBeVisible();
  // The untouched chapter survives.
  await expect(chapters.getByText('Beta', { exact: true })).toBeVisible();
});

test('the editor can add a fresh chapter row', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'catalog');
  await page.getByLabel('Create project from files').setInputFiles(mdFile());
  await expect(page.getByRole('region', { name: 'Chapter structure' })
    .getByText('Alpha', { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'edit chapters' }).click();
  await expect(page.getByLabel('Editable chapters')).toBeVisible({ timeout: 30_000 });
  const titlesBefore = await page.locator('input[aria-label^="Title for"]').count();

  // Add mints a fresh user-keyed placeholder row (allocator wired end to end).
  await page.getByRole('button', { name: 'add chapter' }).click();
  await expect(page.locator('input[aria-label^="Title for"]')).toHaveCount(titlesBefore + 1);
  await expect(page.locator('input[aria-label^="Title for"]').last()).toHaveValue('New chapter');
});
