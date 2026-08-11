/**
 * Slice-1 commit E acceptance (recorded ruling §4E): the query notebook in
 * the real browser over a tiny deterministic imported corpus. Proves:
 * - a multi-alias term (token + phrase + prefix, authored in one comma field)
 *   drives trends and concordance as OR
 *   alternatives, with the complete phrase span in the concordance node;
 * - mute removes the track globally while the CONCORDANCE chips stay an
 *   orthogonal filter; solo restores state exactly; zero-hit is a real,
 *   visible ready state;
 * - a case-SENSITIVE member distinguishes what the folded default merges;
 * - the panel controls carry stable group-qualified accessible names and
 *   aria-pressed state (the assertions deferred from commit C).
 * No live network; everything ships from the dev server.
 */

import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, gotoPlace, openQuickAdd, submitAndAwaitFreshResults, trace } from './helpers.ts';

// Token positions: wolf@1, wolves@4, "dire wolf"@7-8, Wolf@12 (capitalized).
const CORPUS = 'the wolf ran. the wolves howled. a dire wolf slept. then Wolf spoke.\n';

async function importCorpus(page: Page): Promise<void> {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'catalog');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'wolves.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(CORPUS, 'utf-8'),
  });
  await expect(page.getByRole('heading', { name: 'library corpus', exact: true })).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
}

async function rowNodes(page: Page): Promise<{ term: string; node: string }[]> {
  const trs = page.getByRole('table', { name: 'Concordance' }).locator('tbody tr');
  const n = await trs.count();
  const out: { term: string; node: string }[] = [];
  for (let i = 0; i < n; i++) {
    const row = trs.nth(i);
    const tds = row.locator('td');
    out.push({
      term: (await row.getAttribute('data-series-label')) ?? '',
      node: (await tds.nth(1).innerText()).trim(),
    });
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

test('one comma-authored term compiles token, phrase, and prefix aliases as OR alternatives', async ({ page }) => {
  await importCorpus(page);
  await submitAndAwaitFreshResults(page, 'wolf');

  await page.getByRole('button', { name: 'Edit term: wolf' }).click();
  const manager = page.getByRole('dialog', { name: 'Manage terms' });
  const editor = manager.getByRole('form', { name: 'Edit term: wolf' });
  await editor.getByRole('textbox', { name: 'Term and aliases for wolf' })
    .fill('wolf, wolv*, dire wolf');
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await editor.getByRole('button', { name: 'Save term' }).click();
  await awaitFreshKwic(page, mark);
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
  await gotoPlace(page, 'concordance');

  // All OR alternatives appear under the ONE group's track — including the
  // COMPLETE phrase span as the concordance node text.
  await expect.poll(async () => (await rowNodes(page)).map((r) => r.node).sort()).toEqual(
    ['Wolf', 'dire wolf', 'wolf', 'wolves'].sort(), // folded default: Wolf merges; phrase covers dire+wolf
  );
  expect(new Set((await rowNodes(page)).map((r) => r.term))).toEqual(new Set(['wolf'])); // one track

  // The notebook count qualifies as a READY total for the merged group.
  await gotoPlace(page, 'trends');
  await expect(page.getByRole('group', { name: 'Query terms' })
    .getByRole('button', { name: 'wolf 4', exact: true })).toBeVisible();

});

test('the exact-match toggle distinguishes what the folded default merges', async ({ page }) => {
  await importCorpus(page);
  await submitAndAwaitFreshResults(page, 'nothingyet');
  await page.getByRole('button', { name: 'Edit term: nothingyet' }).click();
  const manager = page.getByRole('dialog', { name: 'Manage terms' });
  const editor = manager.getByRole('form', { name: 'Edit term: nothingyet' });
  await editor.getByRole('textbox', { name: 'Term and aliases for nothingyet' }).fill('Wolf');
  await editor.getByRole('checkbox', { name: 'Exact match' }).check();
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await editor.getByRole('button', { name: 'Save term' }).click();
  await awaitFreshKwic(page, mark);
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
  // Only the capitalized occurrence matches — the folded default would find 3+.
  await gotoPlace(page, 'concordance');
  await expect.poll(async () => (await rowNodes(page)).map((r) => r.node)).toEqual(['Wolf']);
});

test('the full-screen manager adds aliases, picks style, reorders by handle, and keeps removal on the right', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await importCorpus(page);
  await submitAndAwaitFreshResults(page, 'wolf, absentterm, dire');
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Manage terms' });
  const list = manager.getByRole('list', { name: 'Terms' });
  await expect(manager.getByRole('button', { name: /^Reorder / })).toHaveCount(3);
  await expect(manager.getByRole('button', { name: /exact case|accents/i })).toHaveCount(0);

  const direHandle = manager.getByRole('button', { name: 'Reorder dire' });
  await expect(direHandle).toHaveAttribute('draggable', 'true');
  await direHandle.focus();
  await direHandle.press('Space');
  await expect(direHandle).toHaveAttribute('aria-pressed', 'true');
  await direHandle.press('ArrowUp');
  await direHandle.press('Space');
  await expect(direHandle).toHaveAttribute('aria-pressed', 'false');
  await expect(list.locator('.term-manager-title')).toHaveText(['wolf', 'dire', 'absentterm']);
  await expect(direHandle).toBeFocused();
  await manager.getByRole('button', { name: 'Reorder wolf' })
    .dragTo(manager.getByRole('button', { name: 'Edit term: absentterm' }), {
      targetPosition: { x: 8, y: 4 },
    });
  await expect(list.locator('.term-manager-title')).toHaveText(['dire', 'wolf', 'absentterm']);

  const touchHandle = manager.getByRole('button', { name: 'Reorder absentterm' });
  const touchTarget = manager.getByRole('button', { name: 'Edit term: dire' });
  const [touchStart, touchEnd] = await Promise.all([touchHandle.boundingBox(), touchTarget.boundingBox()]);
  if (!touchStart || !touchEnd) throw new Error('touch reorder geometry is unavailable');
  const pointer = {
    pointerId: 17,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: 1,
  };
  await touchHandle.dispatchEvent('pointerdown', {
    ...pointer,
    clientX: touchStart.x + touchStart.width / 2,
    clientY: touchStart.y + touchStart.height / 2,
  });
  await touchHandle.dispatchEvent('pointermove', {
    ...pointer,
    clientX: touchEnd.x + 8,
    clientY: touchEnd.y + 4,
  });
  await touchHandle.dispatchEvent('pointerup', {
    ...pointer,
    buttons: 0,
    clientX: touchEnd.x + 8,
    clientY: touchEnd.y + 4,
  });
  await expect(list.locator('.term-manager-title')).toHaveText(['absentterm', 'dire', 'wolf']);

  await manager.getByRole('button', { name: '+ Add term', exact: true }).click();
  const aliases = manager.getByRole('textbox', { name: 'Term and aliases for new term' });
  await expect(aliases).toBeFocused();
  await aliases.fill('dire');
  await aliases.press('Enter');
  await expect(manager.locator('.term-manager-notice')).toHaveText('dire is already in Terms.');
  await expect(aliases).toBeVisible();
  await aliases.fill('NYC, NY, New York, New Yo*');
  await manager.getByRole('checkbox', { name: 'Exact match' }).check();
  await manager.getByText('Blue', { exact: true }).click();
  await manager.getByText('Solid', { exact: true }).click();
  await manager.getByRole('button', { name: 'Add term', exact: true }).click();
  await expect(manager.locator('.term-manager-error'))
    .toHaveText('wolf already uses that color and line type');
  await expect(aliases).toBeVisible();
  await manager.getByText('Gold', { exact: true }).click();
  await manager.getByText('Dotted', { exact: true }).click();
  await manager.getByRole('button', { name: 'Add term', exact: true }).click();

  const nyc = manager.getByRole('button', { name: 'Edit term: NYC' });
  await expect(nyc).toBeVisible();
  await expect(nyc).toBeFocused();
  await expect(manager.getByText('+3 aliases', { exact: true })).toBeVisible();
  await nyc.click();
  const nycAliases = manager.getByRole('textbox', { name: 'Term and aliases for NYC' });
  await expect(nycAliases).toHaveValue('NYC, NY, New York, New Yo*');
  const nativeDropWasUnclaimed = await nycAliases.evaluate((input) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'ordinary text, not a term id');
    return input.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  });
  expect(nativeDropWasUnclaimed).toBe(true);
  await expect(nycAliases).toHaveValue('NYC, NY, New York, New Yo*');
  await expect(manager.locator('.term-manager-error')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  await expect(manager.getByRole('checkbox', { name: 'Exact match' })).toBeChecked();
  await expect(manager.getByRole('radio', { name: 'Gold' })).toBeChecked();
  await expect(manager.getByRole('radio', { name: 'Dotted' })).toBeChecked();

  const item = nyc.locator('xpath=ancestor::li[1]');
  const [summaryBox, removeBox, colors] = await Promise.all([
    nyc.boundingBox(),
    item.getByRole('button', { name: 'Remove NYC' }).boundingBox(),
    item.getByRole('button', { name: 'Remove NYC' }).evaluate((node) => ({
      actual: getComputedStyle(node).color,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent-text').trim(),
    })),
  ]);
  expect(summaryBox && removeBox ? removeBox.x : 0).toBeGreaterThan(summaryBox?.x ?? 0);
  expect(colors.actual).toBe(await page.evaluate((accent) => {
    const probe = document.createElement('span');
    probe.style.color = accent;
    document.body.append(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    return computed;
  }, colors.accent));
  await manager.getByRole('button', { name: 'Save term' }).click();
  await expect(nyc).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(manager).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(manager).toBeVisible();
  await item.getByRole('button', { name: 'Remove NYC' }).click();
  const undo = manager.locator('.term-manager-undo');
  await expect(undo).toContainText('Removed NYC.');
  const undoButton = undo.getByRole('button', { name: 'Undo' });
  await expect(undoButton).toBeFocused();
  await undoButton.click();
  await expect(manager.getByRole('button', { name: 'Edit term: NYC' })).toBeVisible();
  await expect(manager.getByRole('button', { name: 'Edit term: NYC' })).toBeFocused();
  await item.getByRole('button', { name: 'Remove NYC' }).click();
  const dismissButton = undo.getByRole('button', { name: 'Dismiss' });
  await expect(dismissButton).toBeVisible();
  await dismissButton.click();
  await expect(manager.getByRole('button', { name: '+ Add term', exact: true })).toBeFocused();
});

test('mute is global, the concordance filter stays orthogonal, solo restores exactly, and zero-hit is a visible ready state', async ({ page }) => {
  await importCorpus(page);
  await submitAndAwaitFreshResults(page, 'wolf, dire, absentterm');
  const terms = page.getByRole('group', { name: 'Query terms' });

  // Zero-hit: a valid query displaying the number 0 (ready, not missing).
  await expect(terms.getByRole('button', { name: 'absentterm 0', exact: true })).toBeVisible();

  // Accessible names + pressed state (deferred from commit C).
  const showDire = terms.getByRole('button', { name: 'Shown in analysis: dire' });
  await expect(showDire).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  let manager = page.getByRole('dialog', { name: 'Manage terms' });
  let notebook = manager.getByRole('region', { name: 'Query notebook' });
  await expect(notebook.getByRole('button', { name: 'Solo: wolf' }))
    .toHaveAttribute('aria-pressed', 'false');
  await manager.getByRole('button', { name: 'Done', exact: true }).click();

  // Concordance chip OFF for dire — the chart focus chips are untouched.
  const mark0 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await gotoPlace(page, 'concordance');
  await page.getByRole('group', { name: 'Concordance terms' }).getByRole('button', { name: /dire/ }).click();
  await awaitFreshKwic(page, mark0);
  await expect.poll(async () => new Set((await rowNodes(page)).map((r) => r.term))).toEqual(new Set(['wolf']));
  // dire still SHOWN IN ANALYSIS (mute is a different control).
  await gotoPlace(page, 'trends');
  await expect(showDire).toHaveAttribute('aria-pressed', 'true');

  // Mute dire GLOBALLY and observe the muted interval itself: its term bucket
  // becomes unavailable for focus and the fresh reissued burst carries exactly the
  // two remaining tracks (wolf + absentterm) — a mute that only flipped the
  // button would fail both.
  const direChip = showDire.locator('..').locator('.term-bucket-focus');
  await expect(direChip).toBeVisible();
  const muteMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await showDire.click();
  await expect(showDire).toHaveAttribute('aria-pressed', 'false');
  await expect(direChip).toBeDisabled();
  const mutedBurst = await awaitFreshAnswered(page, muteMark);
  expect(mutedBurst.filter((q) => q.op === 'trend').length).toBe(2);
  // Unmute: the track RETURNS (fresh burst of three) and its concordance
  // toggle survived the round-trip OFF.
  const unmuteMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await showDire.click();
  await expect(showDire).toHaveAttribute('aria-pressed', 'true');
  await expect(direChip).toBeEnabled();
  const unmutedBurst = await awaitFreshAnswered(page, unmuteMark);
  expect(unmutedBurst.filter((q) => q.op === 'trend').length).toBe(3);
  await gotoPlace(page, 'concordance');
  await expect.poll(async () => new Set((await rowNodes(page)).map((r) => r.term))).toEqual(new Set(['wolf']));
  await gotoPlace(page, 'trends');

  // Solo wolf (correlated): ONE fresh trend; the other chart chips vanish.
  const soloMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  manager = page.getByRole('dialog', { name: 'Manage terms' });
  notebook = manager.getByRole('region', { name: 'Query notebook' });
  let soloWolf = notebook.getByRole('button', { name: 'Solo: wolf' });
  await soloWolf.click();
  await expect(soloWolf).toHaveAttribute('aria-pressed', 'true');
  await expect(notebook.getByText('not run').first()).toBeVisible();
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(direChip).toBeDisabled();
  const soloBurst = await awaitFreshAnswered(page, soloMark);
  expect(soloBurst.filter((q) => q.op === 'trend').length).toBe(1);
  expect(soloBurst.some((q) => q.op === 'kwic')).toBe(true); // fresh KWIC required
  // Clearing solo restores the EXACT prior projection: three fresh trends,
  // the dire chip back, KWIC still wolf-only (dire's toggle stayed OFF).
  const restoreMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  manager = page.getByRole('dialog', { name: 'Manage terms' });
  notebook = manager.getByRole('region', { name: 'Query notebook' });
  soloWolf = notebook.getByRole('button', { name: 'Solo: wolf' });
  await soloWolf.click();
  await expect(soloWolf).toHaveAttribute('aria-pressed', 'false');
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
  const restoredBurst = await awaitFreshAnswered(page, restoreMark);
  expect(restoredBurst.filter((q) => q.op === 'trend').length).toBe(3);
  // The row assertions below must rest on FRESH concordance evidence, never
  // the pre-solo table (review-E round 2).
  expect(restoredBurst.some((q) => q.op === 'kwic')).toBe(true);
  await expect(direChip).toBeEnabled();
  await gotoPlace(page, 'concordance');
  await expect.poll(async () => new Set((await rowNodes(page)).map((r) => r.term))).toEqual(new Set(['wolf']));
  const direKwicChip = page.getByRole('group', { name: 'Concordance terms' }).getByRole('button', { name: /dire/ });
  await expect(direKwicChip).toHaveAttribute('aria-pressed', 'false');

  // Keyboard: the new-term field and notebook controls are reachable and
  // operable without a pointer (smoke — full traversal is not the contract).
  await gotoPlace(page, 'trends');
  const quickAdd = await openQuickAdd(page);
  await quickAdd.focus();
  await page.keyboard.type('keyterm');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Manage terms' })
    .getByRole('button', { name: 'Done', exact: true }).click();
  await expect(terms.getByRole('button', { name: /^keyterm \d+$/ })).toBeVisible();
});
