/**
 * Commit 7c import smoke (the minimal real-browser proof the plan reserves for
 * 7c): create a user project from a picked file, prove the source bytes TRANSFER
 * (never clone) into the worker, CAS-save it, then — with only the evictable
 * analysis-artifact store cleared but the durable project record preserved —
 * reload, load the saved project, observe the external source reported missing,
 * and reattach the identical file (a second real transfer). The extended
 * restart/corruption/failure matrix stays in commit 9.
 *
 * The scenario is deliberately EXTERNAL (not persisted): a persisted source
 * would warm-reopen from durable bytes and never exercise reattachment. Clearing
 * db2 forces the warm probe to miss so the external source is genuinely absent.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, clearArtifactStores, events, gotoPlace, trace } from './helpers.ts';

const DOC_NAME = 'smoke-doc.txt';
const DOC_TITLE = 'smoke-doc';
const DOC_TEXT = 'The quick brown fox jumps over the lazy dog. '.repeat(120);
const DOC_BYTES = Buffer.byteLength(DOC_TEXT, 'utf-8');

function fileInput(text: string) {
  return { name: DOC_NAME, mimeType: 'text/plain', buffer: Buffer.from(text, 'utf-8') };
}

/** The ingest transfer events posted for a given doc since `sinceSeq`, proving
 *  real detachment (byteLength 0 after the post). */
async function assertTransferred(page: import('@playwright/test').Page, sinceSeq: number, expectBytes: number): Promise<void> {
  await expect
    .poll(async () => {
      const t = await trace(page);
      const ingests = events(t, { direction: 'to-worker', t: 'ingest' })
        .filter((e) => e.seq > sinceSeq && e.transferBytesAfter !== undefined);
      // The user doc's ingest is the only external one after the mark.
      const external = ingests.filter((e) => e.transferBytesBefore === expectBytes);
      if (external.length === 0) return 'no ingest yet';
      return external.every((e) => e.transferBytesAfter === 0) ? 'transferred' : 'not detached';
    }, { timeout: 30_000, message: 'the imported source never transferred' })
    .toBe('transferred');
}

test('import → transfer → save → reload → load → reattach', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page); // built-in Sherlock is the read-only default
  await gotoPlace(page, 'corpus');

  await expect(page.getByText('built-in corpus (read-only)')).toBeVisible();

  // ── Create a user project from a picked file. ──
  const markImport = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByLabel('Create project from files').setInputFiles(fileInput(DOC_TEXT));

  // The bytes transfer into the worker (real detachment), and the project
  // becomes the user's with the finalized document.
  await assertTransferred(page, markImport, DOC_BYTES);
  await expect(page.getByText('your project')).toBeVisible();
  await expect(page.getByText(`attached · ${DOC_NAME}`)).toBeVisible({ timeout: 30_000 });

  // ── CAS-save it (revision 1). ──
  await gotoPlace(page, 'findings');
  const save = page.getByRole('button', { name: 'Save project' });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect(page.getByRole('region', { name: 'Findings', exact: true })
    .getByText('Project revision 1 is saved.')).toBeVisible({ timeout: 30_000 });

  // ── Evict analysis artifacts (keep the durable project), then reload. ──
  await clearArtifactStores(page);
  await page.reload();
  await awaitAllReady(page); // the built-in cold-reboots into the empty db2
  await gotoPlace(page, 'corpus');

  // ── Load the saved project: the external source is now genuinely missing. ──
  await page.getByRole('button', { name: 'Load saved project' }).click();
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('source missing')).toBeVisible({ timeout: 30_000 });

  // ── Reattach the identical file: a second real transfer restores the doc. ──
  const markReattach = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByLabel(`Reattach source for ${DOC_TITLE}`).setInputFiles(fileInput(DOC_TEXT));
  await assertTransferred(page, markReattach, DOC_BYTES);
  await expect(page.getByText(`attached · ${DOC_NAME}`)).toBeVisible({ timeout: 30_000 });
});
