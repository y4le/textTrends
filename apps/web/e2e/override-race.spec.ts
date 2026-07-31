/**
 * Commit 9c — override generation races, the phase's tightest main-thread proof.
 * The override hash is main-thread Web Crypto, so a Playwright-installed one-shot
 * gate holds the FIRST Apply's digest before its continuation can install, while
 * later digests run ungated. A newer Apply (or a discard) then SUPERSEDES the
 * held one; when the deliberately-late hash finally settles it must change
 * nothing. Evidence is the final (generation,snapshot) identity, a structure
 * result correlated to it, and the DOM — never a pre-action state.
 */

import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, digestGateConsumed, gotoPlace, installDigestGate, latestSnapshot, releaseDigestGate, submitAndAwaitFreshResults, trace } from './helpers.ts';

const BOOK_MD = '# Alpha\n\nthe wolf ran far over the hill.\n\n# Beta\n\na wolf slept by the door.\n';

async function importBook(page: Page): Promise<void> {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');
  await page.getByLabel('Create project from files').setInputFiles({ name: 'book.md', mimeType: 'text/markdown', buffer: Buffer.from(BOOK_MD, 'utf-8') });
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);
  await expect(page.getByRole('region', { name: 'Chapter structure' })
    .getByText('Alpha', { exact: true })).toBeVisible({ timeout: 30_000 });
}

/** Retitle the first chapter in the editor and Apply. */
async function retitleAndApply(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'edit chapters' }).click();
  await expect(page.getByLabel('Editable chapters')).toBeVisible({ timeout: 30_000 });
  await page.locator('input[aria-label^="Title for"]').first().fill(title);
  await page.getByRole('region', { name: 'Chapter structure' })
    .getByRole('button', { name: 'apply', exact: true }).click();
}

/**
 * Confirm A is still in flight when the superseding command runs. The marker
 * digest gate already GUARANTEES this deterministically — it holds A's OWN
 * override hash (identified by its title in the digest input), so A's install
 * continuation is blocked the instant its hash runs and no task-gap can let A
 * install. This is the corroborating observation: the reopened editor shows
 * `applying…` and NO generation was posted since A's Apply.
 */
async function assertAStillPending(page: Page, markA: number): Promise<void> {
  await expect(page.getByText('applying…')).toBeVisible({ timeout: 10_000 });
  const t = await trace(page);
  expect(t.dropped).toBe(0);
  expect(t.events.filter((e) => e.seq > markA && e.direction === 'to-worker' && e.t === 'begin-generation')).toEqual([]);
}

/** Await a new generation (posted after `mark`) whose final snapshot differs
 *  from `notSnapshot` and carries a correlated structure result. Returns it. */
async function awaitFreshOutline(page: Page, mark: number, notSnapshot: string | null | undefined): Promise<string> {
  let snap = '';
  await expect
    .poll(async () => {
      const t = await trace(page);
      if (t.dropped !== 0) return 'trace dropped events';
      const begin = t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'begin-generation');
      if (begin.length === 0) return 'no new generation';
      const gen = begin.at(-1)!.generation;
      const pub = t.events.filter((e) => e.direction === 'from-worker' && e.t === 'snapshot-published' && e.generation === gen);
      if (pub.length === 0) return 'no publication';
      const s = pub.at(-1)!.snapshot;
      if (s === notSnapshot) return 'snapshot unchanged';
      const res = t.events.filter((e) => e.direction === 'from-worker' && e.t === 'result' && e.op === 'structure' && e.snapshot === s);
      if (res.length === 0) return 'no structure result on the new snapshot';
      snap = s ?? '';
      return 'fresh';
    }, { timeout: 30_000, message: 'no fresh outline correlated to a new generation' })
    .toBe('fresh');
  return snap;
}

/** Release the held hash, drain it, run a query barrier, and assert NOTHING
 *  changed: no generation posted after the release mark, the identity is stable,
 *  and the DOM matches `expectVisible` / `expectAbsent`. */
async function assertLateHashChangesNothing(page: Page, stableSnapshot: string, expectVisible: string, expectAbsent?: string): Promise<void> {
  const releaseMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await releaseDigestGate(page);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf'); // task-queue barrier after the late settlement
  await gotoPlace(page, 'corpus');
  const t = await trace(page);
  expect(t.dropped).toBe(0);
  expect(t.events.filter((e) => e.seq > releaseMark && e.direction === 'to-worker' && e.t === 'begin-generation')).toEqual([]);
  expect(await latestSnapshot(page)).toBe(stableSnapshot);
  const chapters = page.getByRole('region', { name: 'Chapter structure' });
  await expect(chapters.getByText(expectVisible, { exact: true })).toBeVisible();
  if (expectAbsent) await expect(chapters.getByText(expectAbsent, { exact: true })).toHaveCount(0);
}

test('Apply A → Apply B: the newer correction supersedes the held one', async ({ page }) => {
  await importBook(page);
  const preSnapshot = await latestSnapshot(page);

  // Apply A, but hold its hash before it can install.
  await page.getByRole('button', { name: 'edit chapters' }).click();
  await expect(page.getByLabel('Editable chapters')).toBeVisible({ timeout: 30_000 });
  await page.locator('input[aria-label^="Title for"]').first().fill('Title-A');
  await installDigestGate(page, 'Title-A'); // hold ONLY A's own override hash
  const markA = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('region', { name: 'Chapter structure' })
    .getByRole('button', { name: 'apply', exact: true }).click();
  await expect.poll(() => digestGateConsumed(page), { timeout: 10_000, message: "A's hash was never held" }).toBe(true);

  // Author B while A is still hashing and Apply it (ungated) — it supersedes A.
  await page.getByRole('button', { name: 'edit chapters' }).click();
  await expect(page.getByLabel('Editable chapters')).toBeVisible({ timeout: 30_000 });
  await assertAStillPending(page, markA); // A is genuinely in-flight when B supersedes
  await page.locator('input[aria-label^="Title for"]').first().fill('Title-B');
  const markB = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('region', { name: 'Chapter structure' })
    .getByRole('button', { name: 'apply', exact: true }).click();

  const snapB = await awaitFreshOutline(page, markB, preSnapshot);
  await expect(page.getByRole('region', { name: 'Chapter structure' })
    .getByText('Title-B', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('your correction').first()).toBeVisible();
  await expect(page.getByText('Title-A', { exact: true })).toHaveCount(0);

  // Release A's now-superseded hash: it must change nothing.
  await assertLateHashChangesNothing(page, snapB, 'Title-B', 'Title-A');
});

test('Apply A → discard: a zero-change override supersedes the held one to the baseline', async ({ page }) => {
  await importBook(page);

  // Establish an ACTIVE correction (ungated), and await its snapshot.
  const preSnapshot = await latestSnapshot(page);
  const mark0 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await retitleAndApply(page, 'Corrected');
  await expect(page.getByText('your chapter correction is applied.')).toBeVisible({ timeout: 30_000 });
  await awaitFreshOutline(page, mark0, preSnapshot);
  const activeSnapshot = await latestSnapshot(page);
  await expect(page.getByRole('region', { name: 'Chapter structure' })
    .getByText('Corrected', { exact: true })).toBeVisible();

  // Apply A (a further correction) but hold its hash.
  await page.getByRole('button', { name: 'edit chapters' }).click();
  await expect(page.getByLabel('Editable chapters')).toBeVisible({ timeout: 30_000 });
  await page.locator('input[aria-label^="Title for"]').first().fill('Corrected-A2');
  await installDigestGate(page, 'Corrected-A2'); // hold ONLY A's own override hash
  const markA = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('region', { name: 'Chapter structure' })
    .getByRole('button', { name: 'apply', exact: true }).click();
  await expect.poll(() => digestGateConsumed(page), { timeout: 10_000, message: "A's hash was never held" }).toBe(true);

  // Reopen and RESTORE the detected baseline (revert to the original heading),
  // then Apply the zero-change override — the session's synchronous `none` path,
  // superseding A.
  await page.getByRole('button', { name: 'edit chapters' }).click();
  await expect(page.getByLabel('Editable chapters')).toBeVisible({ timeout: 30_000 });
  await assertAStillPending(page, markA); // A is genuinely in-flight when the discard supersedes
  await page.locator('input[aria-label^="Title for"]').first().fill('Alpha'); // the detected title
  const markDiscard = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('region', { name: 'Chapter structure' })
    .getByRole('button', { name: 'apply', exact: true }).click();

  const baselineSnapshot = await awaitFreshOutline(page, markDiscard, activeSnapshot);
  // The outline is the detected baseline: the original heading, no active
  // correction, and no "your correction" provenance.
  await expect(page.getByRole('region', { name: 'Chapter structure' })
    .getByText('Alpha', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('your chapter correction is applied.')).toHaveCount(0);
  await expect(page.getByText('your correction')).toHaveCount(0);
  await expect(page.getByText('Corrected', { exact: true })).toHaveCount(0);

  // Release A's held hash: it must change nothing (still the baseline).
  await assertLateHashChangesNothing(page, baselineSnapshot, 'Alpha', 'Corrected');
});
