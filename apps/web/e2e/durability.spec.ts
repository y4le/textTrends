/**
 * Commit 9b — durable storage becoming UNAVAILABLE (a user-data versionchange
 * from another context closes the worker's connection). A persist, a Retry
 * persist, and a project-save each fail with their OWN fresh
 * PERSISTENCE_UNAVAILABLE and a distinct visible state; the retry re-posts the
 * retained private File (a second source-persist with a real transfer — the
 * File-retention proof); and resident analysis is unaffected throughout.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, bumpUserDataVersion, gotoPlace, submitAndAwaitFreshResults, trace } from './helpers.ts';

const DOC_TEXT = `# Chapter One\n\n${'the wolf ran far over the hill. '.repeat(40)}`;
const DOC_BYTES = Buffer.byteLength(DOC_TEXT, 'utf-8');

/** Poll: a `t` op posted after `mark` whose job's terminal is a user-data-error
 *  with the given code. Returns the matched post event for further assertions. */
async function awaitUserDataError(page: import('@playwright/test').Page, mark: number, t: string, code: string) {
  let post: import('../src/lib/trace.ts').ProtocolTraceEvent | undefined;
  await expect
    .poll(async () => {
      const snap = await trace(page);
      if (snap.dropped !== 0) return 'trace dropped events';
      const posts = snap.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === t);
      if (posts.length === 0) return `no ${t} posted`;
      post = posts.at(-1);
      const err = snap.events.filter((e) => e.direction === 'from-worker' && e.t === 'user-data-error' && e.job === post!.job);
      if (err.length === 0) return `no terminal for ${t} job`;
      return err.every((e) => e.code === code) ? 'matched' : `code ${err[0]!.code}`;
    }, { timeout: 30_000, message: `${t} did not fail with ${code}` })
    .toBe('matched');
  return post!;
}

test('user-data unavailable: persist, retry (File-retained), and save each fail; analysis unaffected', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'catalog');

  await page.getByLabel('Create project from files').setInputFiles({ name: 'novel.md', mimeType: 'text/markdown', buffer: Buffer.from(DOC_TEXT, 'utf-8') });
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);

  // Close the durable store via a version bump from another context.
  await bumpUserDataVersion(page);

  // (1) Persist fails with its own PERSISTENCE_UNAVAILABLE + persist-failed state.
  const mark1 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'persist', exact: true }).click();
  await awaitUserDataError(page, mark1, 'source-persist', 'PERSISTENCE_UNAVAILABLE');
  await expect(page.getByText(/persist failed:/)).toBeVisible({ timeout: 30_000 });

  // (2) Retry persist re-posts the RETAINED File (a second source-persist with a
  // real transfer) and fails again — the browser-observable File-retention proof.
  const mark2 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'Retry persist' }).click();
  const retry = await awaitUserDataError(page, mark2, 'source-persist', 'PERSISTENCE_UNAVAILABLE');
  expect(retry.transferBytesBefore).toBe(DOC_BYTES); // the File was re-read
  expect(retry.transferBytesAfter).toBe(0); // and really transferred, not cloned

  // (3) Save fails with its OWN fresh PERSISTENCE_UNAVAILABLE + visible state.
  const mark3 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await gotoPlace(page, 'catalog');
  const save = page.getByRole('button', { name: 'Save project' });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await awaitUserDataError(page, mark3, 'project-save', 'PERSISTENCE_UNAVAILABLE');
  await expect(page.getByText(/Project save failed \(PERSISTENCE_UNAVAILABLE\)/)).toBeVisible({
    timeout: 30_000,
  });

  // Resident analysis (db2 artifacts) is unaffected by the durable store closing.
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');
});
