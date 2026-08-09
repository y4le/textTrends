/**
 * Commit 9b — a REAL compare-and-swap conflict. Save revision 1, then advance
 * ONLY the stored manifest's revision to 2 directly in IndexedDB (as another tab
 * would), make a local structure correction, and save from the older base. The
 * worker reports REVISION_CONFLICT (currentRevision 2), the UI shows the
 * conflict, the local correction stays visible and dirty, and the durable record
 * still holds revision 2 with its pre-existing payload — never overwritten.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, gotoPlace, readUserProject, setUserProjectRevision, trace } from './helpers.ts';

const DOC_TEXT = '# Alpha\n\nthe wolf ran far over the hill.\n\n# Beta\n\na wolf slept by the door.\n';

test('a stale CAS base is refused with REVISION_CONFLICT and never overwrites the durable record', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'catalog');

  await page.getByLabel('Create project from files').setInputFiles({ name: 'novel.md', mimeType: 'text/markdown', buffer: Buffer.from(DOC_TEXT, 'utf-8') });
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);

  // Save revision 1.
  await gotoPlace(page, 'catalog');
  const save = page.getByRole('button', { name: 'Save project' });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect(page.getByText('Project revision 1 is saved.')).toBeVisible({ timeout: 30_000 });

  const saved = await readUserProject(page);
  expect(saved?.revision).toBe(1);
  const docsBefore = JSON.stringify(saved?.docs);

  // Another tab advanced the durable revision to 2 (only the revision changes).
  await setUserProjectRevision(page, saved!.id, 2);

  // A local structure correction dirties the project at the stale base 1.
  await gotoPlace(page, 'catalog');
  await page.getByRole('button', { name: 'edit chapters' }).click();
  await expect(page.getByLabel('Editable chapters')).toBeVisible({ timeout: 30_000 });
  const firstTitle = page.locator('input[aria-label^="Title for"]').first();
  await firstTitle.fill('Renamed Alpha');
  await page.getByRole('region', { name: 'Chapter structure' })
    .getByRole('button', { name: 'apply', exact: true }).click();
  await expect(page.getByText('your chapter correction is applied.')).toBeVisible({ timeout: 30_000 });

  // Save from base 1: the worker's CAS sees stored revision 2 → REVISION_CONFLICT.
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await gotoPlace(page, 'catalog');
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect
    .poll(async () => {
      const t = await trace(page);
      if (t.dropped !== 0) return 'trace dropped events';
      const post = t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'project-save');
      if (post.length === 0) return 'no save posted';
      const err = t.events.filter((e) => e.direction === 'from-worker' && e.t === 'user-data-error' && e.job === post.at(-1)!.job);
      if (err.length === 0) return 'no terminal for the save job';
      return err.every((e) => e.code === 'REVISION_CONFLICT') ? 'conflict' : `code ${err[0]!.code}`;
    }, { timeout: 30_000, message: 'the stale save did not conflict' })
    .toBe('conflict');

  // The UI names the conflicting revision; the local correction survives.
  await expect(page.getByText('Project conflict: the saved project moved to revision 2.').first()).toBeVisible();
  await gotoPlace(page, 'catalog');
  await expect(page.getByRole('region', { name: 'Chapter structure' })
    .getByText('Renamed Alpha', { exact: true })).toBeVisible();

  // The durable record is untouched: still revision 2 with its original payload.
  const after = await readUserProject(page);
  expect(after?.revision).toBe(2);
  expect(JSON.stringify(after?.docs)).toBe(docsBefore);
});
