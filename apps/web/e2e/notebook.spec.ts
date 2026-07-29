/**
 * Slice-1 commit E acceptance (recorded ruling §4E): the query notebook in
 * the real browser over a tiny deterministic imported corpus. Proves:
 * - a MULTI-MEMBER group (alias + phrase + prefix, authored through the
 *   editor's draft/Apply flow) drives trends, KWIC, and the passage lane as
 *   OR alternatives, with the complete phrase span in the concordance node;
 * - mute removes the track globally while the CONCORDANCE chips stay an
 *   orthogonal filter; solo restores state exactly; zero-hit is a real,
 *   visible ready state;
 * - a case-SENSITIVE member distinguishes what the folded default merges;
 * - the panel controls carry stable group-qualified accessible names and
 *   aria-pressed state (the assertions deferred from commit C).
 * No live network; everything ships from the dev server.
 */

import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, submitAndAwaitFreshResults, trace } from './helpers.ts';

// Token positions: wolf@1, wolves@4, "dire wolf"@7-8, Wolf@12 (capitalized).
const CORPUS = 'the wolf ran. the wolves howled. a dire wolf slept. then Wolf spoke.\n';

async function importCorpus(page: Page): Promise<void> {
  await page.goto('./');
  await awaitAllReady(page);
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'wolves.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(CORPUS, 'utf-8'),
  });
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);
}

async function rowNodes(page: Page): Promise<{ term: string; node: string }[]> {
  const trs = page.getByRole('table', { name: 'Concordance' }).locator('tbody tr');
  const n = await trs.count();
  const out: { term: string; node: string }[] = [];
  for (let i = 0; i < n; i++) {
    const tds = trs.nth(i).locator('td');
    out.push({ term: (await tds.nth(0).innerText()).trim(), node: (await tds.nth(3).innerText()).trim() });
  }
  return out;
}

/** Wait until EVERY query posted after `mark` answered; returns the fresh
 *  to-worker query events (fresh-evidence discipline: no assertion may pass
 *  on pre-action results). */
async function awaitFreshAnswered(page: Page, mark: number): Promise<{ op: string | undefined; job: number }[]> {
  let fresh: { op: string | undefined; job: number }[] = [];
  await expect
    .poll(async () => {
      const t = await trace(page);
      const q = t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'query');
      if (q.length === 0) return 'no fresh query';
      const jobs = new Set(q.map((e) => e.job));
      const res = t.events.filter((e) => e.seq > mark && e.direction === 'from-worker' && e.t === 'result' && jobs.has(e.job));
      if (res.length !== jobs.size) return `${res.length}/${jobs.size} answered`;
      fresh = q.map((e) => ({ op: e.op, job: e.job as number }));
      return 'all answered';
    }, { timeout: 30_000 })
    .toBe('all answered');
  return fresh;
}

/** Wait for a fresh (post-mark) kwic query to deliver its result. */
async function awaitFreshKwic(page: Page, mark: number): Promise<void> {
  await expect
    .poll(async () => {
      const t = await trace(page);
      const q = t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'query' && e.op === 'kwic');
      if (q.length === 0) return 'no fresh kwic query';
      const res = t.events.filter((e) => e.seq > mark && e.direction === 'from-worker' && e.t === 'result' && q.some((p) => p.job === e.job));
      return res.length > 0 ? 'answered' : 'no result';
    }, { timeout: 30_000 })
    .toBe('answered');
}

test('a multi-member group (alias + phrase + prefix) authored in the editor drives every lane as OR alternatives', async ({ page }) => {
  await importCorpus(page);
  await submitAndAwaitFreshResults(page, 'wolf');

  // Author members through the DRAFT editor: prefix wolv* and phrase "dire wolf".
  await page.getByRole('button', { name: 'Edit members: wolf' }).click();
  const editor = page.getByRole('group', { name: 'Edit members: wolf' });
  const addInput = editor.getByLabel(/Add member to wolf/);
  await addInput.fill('wolv*');
  await editor.getByRole('button', { name: 'add', exact: true }).click();
  const chipInput = editor.getByLabel(/Add phrase word to wolf/);
  await chipInput.fill('dire');
  await editor.getByRole('button', { name: 'add word' }).click();
  await chipInput.fill('wolf');
  await editor.getByRole('button', { name: 'add word' }).click();
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await editor.getByRole('button', { name: 'Add phrase to wolf' }).click();
  await editor.getByRole('button', { name: 'Apply changes to wolf' }).click();
  await awaitFreshKwic(page, mark);

  // All OR alternatives appear under the ONE group's track — including the
  // COMPLETE phrase span as the concordance node text.
  await expect.poll(async () => (await rowNodes(page)).map((r) => r.node).sort()).toEqual(
    ['Wolf', 'dire wolf', 'wolf', 'wolves'].sort(), // folded default: Wolf merges; phrase covers dire+wolf
  );
  expect(new Set((await rowNodes(page)).map((r) => r.term))).toEqual(new Set(['wolf'])); // one track

  // The notebook count qualifies as a READY total for the merged group.
  await expect(page.getByRole('region', { name: 'Query notebook' }).getByText(/^4$/)).toBeVisible();

  // The PASSAGE lane runs under the same authored group: scrub the axis,
  // wait for the job-correlated passage result, and assert the FULL phrase
  // span renders as ONE merged occurrence mark ('dire wolf', not a fragment).
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  const pMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scrubber.press('End');
  await expect
    .poll(async () => {
      const t = await trace(page);
      const q = t.events.filter((e) => e.seq > pMark && e.direction === 'to-worker' && e.t === 'query' && e.op === 'passage');
      if (q.length === 0) return 'no fresh passage query';
      const res = t.events.filter((e) => e.seq > pMark && e.direction === 'from-worker' && e.t === 'result' && q.some((p) => p.job === e.job));
      return res.length > 0 ? 'answered' : 'no result';
    }, { timeout: 30_000 })
    .toBe('answered');
  await expect(page.locator('span[style*="border-bottom"]').filter({ hasText: /^dire wolf$/ })).toBeVisible();
});

test('a case-SENSITIVE member distinguishes what the folded default merges', async ({ page }) => {
  await importCorpus(page);
  await submitAndAwaitFreshResults(page, 'nothingyet');
  // Author exactly one member: token 'Wolf' with exact case.
  await page.getByRole('button', { name: 'Edit members: nothingyet' }).click();
  const editor = page.getByRole('group', { name: 'Edit members: nothingyet' });
  await editor.getByRole('button', { name: 'Remove member nothingyet' }).click();
  const caseToggle = editor.getByRole('button', { name: 'Exact case: new member' });
  await expect(caseToggle).toHaveAttribute('aria-pressed', 'false');
  await caseToggle.click();
  await expect(caseToggle).toHaveAttribute('aria-pressed', 'true');
  await editor.getByLabel(/Add member to nothingyet/).fill('Wolf');
  await editor.getByRole('button', { name: 'add', exact: true }).click();
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await editor.getByRole('button', { name: 'Apply changes to nothingyet' }).click();
  await awaitFreshKwic(page, mark);
  // Only the capitalized occurrence matches — the folded default would find 3+.
  await expect.poll(async () => (await rowNodes(page)).map((r) => r.node)).toEqual(['Wolf']);
});

test('mute is global, the concordance filter stays orthogonal, solo restores exactly, and zero-hit is a visible ready state', async ({ page }) => {
  await importCorpus(page);
  await submitAndAwaitFreshResults(page, 'wolf, dire, absentterm');
  const notebook = page.getByRole('region', { name: 'Query notebook' });

  // Zero-hit: a valid query displaying the number 0 (ready, not missing).
  await expect(notebook.getByText(/^0$/)).toBeVisible();

  // Accessible names + pressed state (deferred from commit C).
  const showDire = notebook.getByRole('button', { name: 'Shown in analysis: dire' });
  await expect(showDire).toHaveAttribute('aria-pressed', 'true');
  const soloWolf = notebook.getByRole('button', { name: 'Solo: wolf' });
  await expect(soloWolf).toHaveAttribute('aria-pressed', 'false');

  // Concordance chip OFF for dire — the chart focus chips are untouched.
  const mark0 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('group', { name: 'Concordance terms' }).getByRole('button', { name: /dire/ }).click();
  await awaitFreshKwic(page, mark0);
  await expect.poll(async () => new Set((await rowNodes(page)).map((r) => r.term))).toEqual(new Set(['wolf']));
  // dire still SHOWN IN ANALYSIS (mute is a different control).
  await expect(showDire).toHaveAttribute('aria-pressed', 'true');

  // Load a passage BEFORE muting so the muted interval is observed on live
  // passage evidence too: scrub to the end — the tiny corpus fits one block,
  // so dire@9 and the wolf occurrences all carry marks.
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  const scrubMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await scrubber.press('End');
  await awaitFreshAnswered(page, scrubMark);
  const markSpan = (text: string) =>
    page.locator('span[style*="border-bottom"]').filter({ hasText: new RegExp(`^${text}$`) });
  await expect(markSpan('dire').first()).toBeVisible();

  // Mute dire GLOBALLY and observe the muted interval itself: the chart
  // focus chip disappears and the fresh reissued burst carries exactly the
  // two remaining tracks (wolf + absentterm) — a mute that only flipped the
  // button would fail both.
  // The CHART focus chip (title-scoped: the concordance chip can share the
  // bare accessible name 'dire' once its checkmark is off).
  const direChip = page.locator('button[title*=\'emphasize \u201cdire\u201d\']');
  await expect(direChip).toBeVisible();
  const muteMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await showDire.click();
  await expect(showDire).toHaveAttribute('aria-pressed', 'false');
  await expect(direChip).toBeHidden(); // gone from the chart, not just the toggle
  const mutedBurst = await awaitFreshAnswered(page, muteMark);
  expect(mutedBurst.filter((q) => q.op === 'trend').length).toBe(2);
  // The RESIDENT passage was invalidated and refetched WITHOUT the muted
  // track: dire's mark is gone, wolf's remains (review-E round 2).
  expect(mutedBurst.some((q) => q.op === 'passage')).toBe(true);
  await expect(markSpan('dire')).toBeHidden();
  await expect(markSpan('wolf').first()).toBeVisible();
  // Unmute: the track RETURNS (fresh burst of three) and its concordance
  // toggle survived the round-trip OFF.
  const unmuteMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await showDire.click();
  await expect(showDire).toHaveAttribute('aria-pressed', 'true');
  await expect(direChip).toBeVisible();
  const unmutedBurst = await awaitFreshAnswered(page, unmuteMark);
  expect(unmutedBurst.filter((q) => q.op === 'trend').length).toBe(3);
  await expect(markSpan('dire').first()).toBeVisible(); // the passage mark RETURNS
  await expect.poll(async () => new Set((await rowNodes(page)).map((r) => r.term))).toEqual(new Set(['wolf']));

  // Solo wolf (correlated): ONE fresh trend; the other chart chips vanish.
  const soloMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await soloWolf.click();
  await expect(soloWolf).toHaveAttribute('aria-pressed', 'true');
  await expect(notebook.getByText('not run').first()).toBeVisible();
  await expect(direChip).toBeHidden();
  const soloBurst = await awaitFreshAnswered(page, soloMark);
  expect(soloBurst.filter((q) => q.op === 'trend').length).toBe(1);
  expect(soloBurst.some((q) => q.op === 'kwic')).toBe(true); // fresh KWIC required
  // Clearing solo restores the EXACT prior projection: three fresh trends,
  // the dire chip back, KWIC still wolf-only (dire's toggle stayed OFF).
  const restoreMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await soloWolf.click();
  await expect(soloWolf).toHaveAttribute('aria-pressed', 'false');
  const restoredBurst = await awaitFreshAnswered(page, restoreMark);
  expect(restoredBurst.filter((q) => q.op === 'trend').length).toBe(3);
  // The row assertions below must rest on FRESH concordance evidence, never
  // the pre-solo table (review-E round 2).
  expect(restoredBurst.some((q) => q.op === 'kwic')).toBe(true);
  await expect(direChip).toBeVisible();
  await expect.poll(async () => new Set((await rowNodes(page)).map((r) => r.term))).toEqual(new Set(['wolf']));
  const direKwicChip = page.getByRole('group', { name: 'Concordance terms' }).getByRole('button', { name: /dire/ });
  await expect(direKwicChip).toHaveAttribute('aria-pressed', 'false');

  // Keyboard: the quick-add field and notebook controls are reachable and
  // operable without a pointer (smoke — full traversal is not the contract).
  await page.getByLabel(/add terms to the notebook/i).focus();
  await page.keyboard.type('keyterm');
  await page.keyboard.press('Enter');
  await expect(notebook.getByLabel('Group name: keyterm')).toBeVisible();
});
