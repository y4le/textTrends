/**
 * Slice-1 commit E acceptance (recorded ruling §4E): the query notebook in
 * the real browser over a tiny deterministic imported corpus. Proves:
 * - a multi-alias term (token + phrase + prefix, authored in one comma field)
 *   drives trends and concordance as OR
 *   alternatives, with the complete phrase span in the concordance node;
 * - visibility removes the track globally, including from Concordance, while
 *   zero-hit remains a real, visible ready state;
 * - a case-SENSITIVE member distinguishes what the folded default merges;
 * - the panel controls carry stable group-qualified accessible names and
 *   native checked/pressed state.
 * No live network; everything ships from the dev server.
 */

import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, gotoPlace, openQuickAdd, submitAndAwaitFreshResults, trace } from './helpers.ts';

// Token positions: wolf@1, wolves@4, "dire wolf"@7-8, Wolf@12 (capitalized).
const CORPUS = 'the wolf ran. the wolves howled. a dire wolf slept. then Wolf spoke.\n';

async function importCorpus(page: Page): Promise<void> {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'inputs');
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
  const trs = page.getByRole('grid', { name: 'Concordance' }).locator('[role="row"][aria-rowindex]');
  const n = await trs.count();
  const out: { term: string; node: string }[] = [];
  for (let i = 0; i < n; i++) {
    const row = trs.nth(i);
    const tds = row.locator('[role="gridcell"]');
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

/** Wait for a fresh (post-mark) Concordance window to deliver its result. */
async function awaitFreshKwic(page: Page, mark: number): Promise<void> {
  await expect
    .poll(async () => {
      const t = await trace(page);
      const q = t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'query' && e.op === 'concordance-window');
      if (q.length === 0) return 'no fresh concordance query';
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

test('the full-screen manager adds aliases, picks style, reorders with feedback, and keeps visibility and removal on the right', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.emulateMedia({ colorScheme: 'dark' });
  await importCorpus(page);
  await submitAndAwaitFreshResults(page, 'wolf, absentterm, dire');
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Manage terms' });
  const list = manager.getByRole('list', { name: 'Terms' });
  const managerActions = manager.locator('.term-manager-actions');
  const done = managerActions.getByRole('button', { name: 'Done', exact: true });
  const add = managerActions.getByRole('button', { name: '+ Add term', exact: true });
  await expect(manager.locator('.term-manager-header').getByRole('button', { name: 'Done' }))
    .toHaveCount(0);
  await expect(managerActions.getByRole('button')).toHaveText(['Done', '+ Add term']);
  await expect(done).toHaveClass(/term-manager-add/);
  await expect(add).toHaveClass(/term-manager-add/);
  const [doneBox, addBox] = await Promise.all([done.boundingBox(), add.boundingBox()]);
  expect(doneBox && addBox ? doneBox.x : 0).toBeLessThan(addBox?.x ?? 0);
  await expect(manager.getByRole('button', { name: /^Reorder / })).toHaveCount(3);
  await expect(manager.getByRole('button', { name: /exact case|accents/i })).toHaveCount(0);
  await expect(manager.getByRole('button', { name: /^Solo:/ })).toHaveCount(0);
  await expect(manager.getByRole('checkbox', { name: /^Shown in analysis:/ })).toHaveCount(3);

  const direHandle = manager.getByRole('button', { name: 'Reorder dire' });
  await expect(direHandle).not.toHaveAttribute('draggable', 'true');
  await direHandle.focus();
  await direHandle.press('Space');
  await expect(direHandle).toHaveAttribute('aria-pressed', 'true');
  await direHandle.press('ArrowUp');
  await direHandle.press('Space');
  await expect(direHandle).toHaveAttribute('aria-pressed', 'false');
  await expect(list.locator('.term-manager-title')).toHaveText(['wolf', 'dire', 'absentterm']);
  await expect(direHandle).toBeFocused();
  const mouseHandle = manager.getByRole('button', { name: 'Reorder wolf' });
  const mouseTarget = manager.getByRole('button', { name: 'Edit term: absentterm' });
  const [mouseStart, mouseEnd] = await Promise.all([
    mouseHandle.boundingBox(),
    mouseTarget.boundingBox(),
  ]);
  if (!mouseStart || !mouseEnd) throw new Error('mouse reorder geometry is unavailable');
  await page.mouse.move(mouseStart.x + mouseStart.width / 2, mouseStart.y + mouseStart.height / 2);
  await page.mouse.down();
  await page.mouse.move(mouseEnd.x + 8, mouseEnd.y + 4, { steps: 4 });
  await expect(mouseTarget.locator('xpath=ancestor::li[1]'))
    .toHaveAttribute('data-drop-position', 'before');
  await page.mouse.up();
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
  await expect(touchTarget.locator('xpath=ancestor::li[1]'))
    .toHaveAttribute('data-drop-position', 'before');
  await touchHandle.dispatchEvent('pointerup', {
    ...pointer,
    buttons: 0,
    clientX: touchEnd.x + 8,
    clientY: touchEnd.y + 4,
  });
  await expect(list.locator('.term-manager-title')).toHaveText(['absentterm', 'dire', 'wolf']);

  // Merely opening and saving the editor must preserve a legacy color's
  // theme-aware identity. The native input reflects the resolved token in
  // each theme without turning that value into a fixed custom hex.
  const wolf = manager.getByRole('button', { name: 'Edit term: wolf' });
  const wolfGroupId = await wolf.locator('xpath=ancestor::li[1]')
    .getAttribute('data-term-manager-id');
  if (!wolfGroupId) throw new Error('legacy term id is unavailable');
  await wolf.click();
  const wolfColor = manager.getByLabel('Color for wolf');
  await expect(wolfColor).toHaveAttribute('type', 'color');
  await expect(wolfColor).toHaveValue('#3b98d4');
  await expect(manager.getByText('Blue', { exact: true })).toBeVisible();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(wolfColor).toHaveValue('#0072b2');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(wolfColor).toHaveValue('#3b98d4');
  await manager.getByRole('button', { name: 'Save term' }).click();
  await expect(page.locator(`[data-series-path="${wolfGroupId}"]`).first())
    .toHaveAttribute('stroke', 'var(--series-1)');

  await manager.getByRole('button', { name: '+ Add term', exact: true }).click();
  const aliases = manager.getByRole('textbox', { name: 'Term and aliases for new term' });
  await expect(aliases).toBeFocused();
  await aliases.fill('dire');
  await aliases.press('Enter');
  await expect(manager.locator('.term-manager-notice')).toHaveText('dire is already in Terms.');
  await expect(aliases).toBeVisible();
  await aliases.fill('NYC, NY, New York, New Yo*');
  await manager.getByRole('checkbox', { name: 'Exact match' }).check();
  const customColor = manager.getByLabel('Color for new term');
  await expect(customColor).toHaveAttribute('type', 'color');
  const customColorBox = await customColor.boundingBox();
  expect(customColorBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(customColorBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await customColor.fill('#6a5acd');
  await expect(manager.getByText('#6a5acd', { exact: true })).toBeVisible();
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
  await expect(manager.getByLabel('Color for NYC')).toHaveValue('#6a5acd');
  await expect(manager.getByText('#6a5acd', { exact: true })).toBeVisible();
  await expect(manager.getByRole('radio', { name: /Blue|Amber|Teal|Vermillion|Magenta/ }))
    .toHaveCount(0);
  await expect(manager.getByRole('radio', { name: 'Dotted' })).toBeChecked();

  const item = nyc.locator('xpath=ancestor::li[1]');
  const customGroupId = await item.getAttribute('data-term-manager-id');
  if (!customGroupId) throw new Error('custom term id is unavailable');
  const visibility = item.getByRole('checkbox', { name: 'Shown in analysis: NYC' });
  await expect(visibility).toBeChecked();
  const [summaryBox, visibilityBox, removeBox, colors] = await Promise.all([
    nyc.boundingBox(),
    item.locator('.term-manager-visible').boundingBox(),
    item.getByRole('button', { name: 'Remove NYC' }).boundingBox(),
    item.getByRole('button', { name: 'Remove NYC' }).evaluate((node) => ({
      actual: getComputedStyle(node).color,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent-text').trim(),
    })),
  ]);
  expect(summaryBox && visibilityBox ? visibilityBox.x : 0).toBeGreaterThan(summaryBox?.x ?? 0);
  expect(visibilityBox && removeBox ? removeBox.x : 0).toBeGreaterThan(visibilityBox?.x ?? 0);
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
  await expect(page.locator(`[data-series-path="${customGroupId}"]`).first())
    .toHaveAttribute('stroke', '#6a5acd');

  // The authored custom value survives closing the manager and stays fixed
  // when the presentation theme changes. Workspace round-trip persistence is
  // covered by the core serialization test.
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(manager).toBeVisible();
  await manager.getByRole('button', { name: 'Edit term: NYC' }).click();
  const persistedCustomColor = manager.getByLabel('Color for NYC');
  await expect(persistedCustomColor).toHaveValue('#6a5acd');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(persistedCustomColor).toHaveValue('#6a5acd');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(persistedCustomColor).toHaveValue('#6a5acd');
  await manager.getByRole('button', { name: 'Save term' }).click();
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

test('visibility is global across Concordance and zero-hit is a visible ready state', async ({ page }) => {
  await importCorpus(page);
  await submitAndAwaitFreshResults(page, 'wolf, dire, absentterm');
  const terms = page.getByRole('group', { name: 'Query terms' });

  // Zero-hit: a valid query displaying the number 0 (ready, not missing).
  await expect(terms.getByRole('button', { name: 'absentterm 0', exact: true })).toBeVisible();

  // The footer and manager expose the same global visibility state.
  const showDire = terms.getByRole('button', { name: 'Shown in analysis: dire' });
  await expect(showDire).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Manage terms' });
  const notebook = manager.getByRole('region', { name: 'Query notebook' });
  const shownDire = notebook.getByRole('checkbox', { name: 'Shown in analysis: dire' });
  await expect(shownDire).toBeChecked();
  await expect(notebook.getByRole('button', { name: /^Solo:/ })).toHaveCount(0);

  const managerHideMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await shownDire.uncheck();
  await expect(showDire).toHaveAttribute('aria-pressed', 'false');
  const managerHiddenBurst = await awaitFreshAnswered(page, managerHideMark);
  expect(managerHiddenBurst.filter((q) => q.op === 'trend').length).toBe(2);

  const managerShowMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await shownDire.check();
  await expect(showDire).toHaveAttribute('aria-pressed', 'true');
  const managerShownBurst = await awaitFreshAnswered(page, managerShowMark);
  expect(managerShownBurst.filter((q) => q.op === 'trend').length).toBe(3);
  await manager.getByRole('button', { name: 'Done', exact: true }).click();

  // The shared terms rail remains the sole term control in Concordance.
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('complementary', { name: 'Terms' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Concordance terms' })).toHaveCount(0);
  const direChip = showDire.locator('..').locator('.term-bucket-focus');
  await expect(direChip).toBeVisible();
  const muteMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await showDire.click();
  await expect(showDire).toHaveAttribute('aria-pressed', 'false');
  await expect(direChip).toBeDisabled();
  const mutedBurst = await awaitFreshAnswered(page, muteMark);
  expect(mutedBurst.filter((q) => q.op === 'trend').length).toBe(2);
  await expect.poll(async () => new Set((await rowNodes(page)).map((r) => r.term)))
    .toEqual(new Set(['wolf']));

  // Restoring global visibility restores the term in Concordance too.
  const unmuteMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await showDire.click();
  await expect(showDire).toHaveAttribute('aria-pressed', 'true');
  await expect(direChip).toBeEnabled();
  const unmutedBurst = await awaitFreshAnswered(page, unmuteMark);
  expect(unmutedBurst.filter((q) => q.op === 'trend').length).toBe(3);
  await expect.poll(async () => new Set((await rowNodes(page)).map((r) => r.term)))
    .toEqual(new Set(['wolf', 'dire']));

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
