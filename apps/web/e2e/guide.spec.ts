import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  GUIDE_PROGRESS_STORAGE_KEY,
  type GuideProgressV1,
} from '../src/lib/guide/storage.ts';
import {
  awaitAllReady,
  awaitReadyCount,
  clearDemoInputs,
  clearNotebook,
  gotoPlace,
  submitAndAwaitFreshResults,
  trace,
  workerQueriesAfter,
  workspaceRecord,
} from './helpers.ts';

async function openHelp(page: Page) {
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'Help' });
  await expect(help).toBeVisible();
  return help;
}

async function startTour(page: Page) {
  const help = await openHelp(page);
  const start = help.getByRole('button', { name: /Start the guided tour/ });
  await expect(start).toBeEnabled();
  await start.click();
  const card = page.getByRole('dialog', { name: 'A reading instrument' });
  await expect(card).toBeVisible();
  await expect(page.locator('#root')).not.toHaveAttribute('inert');
  await expect(card.getByRole('heading', { name: 'A reading instrument' })).toBeFocused();
  return card;
}

async function advanceToMark(page: Page) {
  await startTour(page);
  await page.locator('.guide-card').getByRole('button', { name: 'Begin' }).click();
  await expect(page.getByRole('dialog', { name: 'The terms you track' })).toBeVisible();
  await expect(page.locator('#root')).toHaveAttribute('data-guide-anchor-active', 'terms-rail');
  await page.locator('.guide-card').getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('dialog', { name: 'One order, followed everywhere' })).toBeVisible();
  await expect(page).toHaveURL(/[?&]p=trends(?:&|#|$)/);
  await expect(page.locator('#root')).toHaveAttribute('data-guide-anchor-active', 'trend-plate');
  await page.locator('.guide-card').getByRole('button', { name: 'Next' }).click();
  const mark = page.locator('.guide-card');
  await expect(mark).toContainText(/Every mark is a position|These marks are counts/);
  await expect(page.locator('#root')).toHaveAttribute('data-guide-anchor-active', 'dispersion-strip');
  return mark;
}

async function expectCardInsideViewport(page: Page, card: Locator) {
  const box = await card.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
  for (const action of await card.getByRole('button').all()) {
    const actionBox = await action.boundingBox();
    expect(actionBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
}

async function guideProgress(page: Page): Promise<GuideProgressV1 | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw) as GuideProgressV1;
  }, GUIDE_PROGRESS_STORAGE_KEY);
}

test('offers an eligible reader one versioned invitation without auto-starting', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'webkit-compact', 'the compact invitation is covered below');
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const invitation = page.getByRole('complementary', { name: 'Guided tour invitation' });
  await expect(invitation).toBeVisible();
  await expect(page.locator('.guide-card')).toHaveCount(0);
  expect(await guideProgress(page)).toBeNull();

  await invitation.getByRole('button', { name: 'Not now' }).click();
  await expect(invitation).toHaveCount(0);
  await expect(page.locator('#global-help-open')).toBeFocused();
  expect(await guideProgress(page)).toEqual({
    v: 1,
    tourSeenVersion: null,
    dismissedInvitationVersion: 1,
  });

  await page.reload();
  await awaitAllReady(page);
  await expect(invitation).toHaveCount(0);

  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({
    v: 1,
    tourSeenVersion: null,
    dismissedInvitationVersion: 0,
  })), GUIDE_PROGRESS_STORAGE_KEY);
  await page.reload();
  await awaitAllReady(page);
  await expect(invitation).toBeVisible();
});

test('starting from the invitation dismisses it without claiming completion', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'webkit-compact', 'covered in Chromium');
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  const invitation = page.getByRole('complementary', { name: 'Guided tour invitation' });
  await invitation.getByRole('button', { name: 'Start', exact: true }).click();
  const card = page.getByRole('dialog', { name: 'A reading instrument' });
  await expect(card).toBeVisible();
  await expect(invitation).toHaveCount(0);
  expect(await guideProgress(page)).toEqual({
    v: 1,
    tourSeenVersion: null,
    dismissedInvitationVersion: 1,
  });

  await card.getByRole('button', { name: 'Exit guided tour' }).click();
  await page.reload();
  await awaitAllReady(page);
  await expect(invitation).toHaveCount(0);
  const help = await openHelp(page);
  await expect(help.getByRole('button', { name: /Start the guided tour/ })).toBeVisible();
  await expect(help.getByRole('button', { name: /Replay the guided tour/ })).toHaveCount(0);
});

test('walks from a mark to its source and restores the captured workbench place', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'webkit-compact', 'the compact project has its bounded path below');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'compare');
  const beforeWorkspace = await workspaceRecord(page);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  const markCard = await advanceToMark(page);
  const open = markCard.locator('[data-guide-action="primary"]');
  await expect(open).toBeEnabled({ timeout: 30_000 });
  await open.click();

  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await expect(page.locator('#guide-live-region')).toHaveText('Opened the source in Reader.');
  const source = page.getByRole('dialog', { name: 'The text is the evidence' });
  await expect(source).toBeVisible();
  await expect(page.locator('#root')).toHaveAttribute('data-guide-anchor-active', 'reader-prose');
  await source.getByRole('button', { name: 'Next' }).click();

  const returning = page.getByRole('dialog', { name: 'The place comes with you' });
  await expect(returning.getByRole('button', { name: 'Go back' })).toBeVisible();
  await returning.getByRole('button', { name: 'Go back' }).click();
  await expect(reader).toHaveCount(0);
  await expect(page.locator('#guide-live-region')).toHaveText(
    'Returned to the chart at the reading position.',
  );
  await expect(returning).toContainText('You are back on the chart, at the passage you just read.');
  await expect(returning.getByRole('heading', { name: 'The place comes with you' })).toBeFocused();
  await returning.getByRole('button', { name: 'Finish' }).click();

  const finish = page.getByRole('dialog', { name: 'Start with a word. End with the text.' });
  await expect(finish).toBeVisible();
  expect(await guideProgress(page)).toEqual({
    v: 1,
    tourSeenVersion: 1,
    dismissedInvitationVersion: null,
  });
  const finishNotes = finish.getByRole('region', { name: 'Guides for this view' });
  await expect(finishNotes.getByRole('button')).toHaveCount(4);
  await finish.getByRole('button', { name: 'Back to where I was' }).click();
  await expect(finish).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]p=compare(?:&|#|$)/);
  await expect(page.locator('#global-help-open')).toBeFocused();
  expect(await workspaceRecord(page)).toEqual(beforeWorkspace);

  const queries = workerQueriesAfter((await trace(page)).events, mark);
  expect(new Set(queries.map((event) => event.op))).toEqual(new Set(['reader-page']));
  await expect(page.locator('#root')).not.toHaveAttribute('data-guide-anchor-active');
  await expect(page.locator('.guide-card')).toHaveCount(0);

  const help = await openHelp(page);
  await expect(help.getByRole('button', { name: /Replay the guided tour/ })).toBeVisible();
});

test('does not claim completion when the source leg is abridged', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'webkit-compact', 'covered in Chromium');
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await startTour(page);
  await page.locator('.guide-card').getByRole('button', { name: 'Begin' }).click();
  await expect(page.getByRole('dialog', { name: 'The terms you track' })).toBeVisible();
  const shownTerms = page.locator('[data-term-toggle][aria-pressed="true"]');
  let shownCount = await shownTerms.count();
  while (shownCount > 0) {
    // Exercise live target churn while the fixed card may cover the rail.
    await shownTerms.first().click({ force: true });
    shownCount -= 1;
    await expect(shownTerms).toHaveCount(shownCount);
  }
  await page.locator('.guide-card').getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('dialog', { name: 'One order, followed everywhere' })).toBeVisible();
  await page.locator('.guide-card').getByRole('button', { name: 'Next' }).click();

  const mark = page.locator('.guide-card');
  await expect(mark.getByRole('button', { name: 'Continue without a mark' })).toBeVisible();
  await mark.getByRole('button', { name: 'Continue without a mark' }).click();
  const finish = page.getByRole('dialog', { name: 'Start with a word. End with the text.' });
  await expect(finish).toContainText('stopped before the source');
  expect(await guideProgress(page)).toBeNull();
  await page.locator('[data-term-toggle][aria-pressed="false"]').first().click({ force: true });
  await finish.getByRole('button', { name: 'Stay here' }).click();
  await expect(page.getByRole('complementary', { name: 'Guided tour invitation' })).toBeVisible();
});

test('keeps modal Help authoritative over an active tour and abandons it on reload', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'webkit-compact', 'covered in Chromium');
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await startTour(page);
  await page.locator('.guide-card').getByRole('button', { name: 'Begin' }).click();
  const card = page.locator('.guide-card');
  await page.locator('#global-help-open').click();
  const help = page.getByRole('dialog', { name: 'Help' });
  await expect(help).toBeVisible();
  await expect(page.locator('#root')).toHaveAttribute('inert');
  await expect(card).toBeVisible();
  await expect(help.getByRole('heading', { name: 'Help' })).toBeFocused();
  await help.getByRole('button', { name: 'close' }).click();
  await expect(page.locator('#root')).not.toHaveAttribute('inert');
  await expect(page.locator('#global-help-open')).toBeFocused();

  await page.reload();
  await awaitAllReady(page);
  await expect(page.locator('.guide-card')).toHaveCount(0);
  await expect(page.locator('#root')).not.toHaveAttribute('data-guide-anchor-active');
});

test('offers direct prerequisite remedies without starting a hidden guide', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'webkit-compact', 'covered in Chromium');
  await page.goto('./?p=inputs');
  const help = await openHelp(page);
  const start = help.getByRole('button', { name: /Start the guided tour/ });
  await expect(start).toBeDisabled();
  await expect(start).toHaveAttribute('aria-describedby', 'help-guide-disabled-reason');
  await expect(help.getByText('Add a ready text before starting the guided tour.')).toBeVisible();
  await help.getByRole('button', { name: 'Add a text' }).click();
  await expect(help).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]p=inputs(?:&|#|$)/);
  await expect(page.getByRole('region', { name: 'Inputs', exact: true })).toBeFocused();
  await expect(page.locator('.guide-card')).toHaveCount(0);
});

test('opens term quick entry from the missing-term prerequisite remedy', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'webkit-compact', 'covered in Chromium');
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await clearNotebook(page);
  const help = await openHelp(page);
  const start = help.getByRole('button', { name: /Start the guided tour/ });
  await expect(start).toBeDisabled();
  await expect(help.getByText('Track at least one term before starting the guided tour.')).toBeVisible();
  await help.getByRole('button', { name: 'Track a term' }).click();
  await expect(help).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]p=trends(?:&|#|$)/);
  await expect(page.getByRole('textbox', { name: 'New term' })).toBeFocused();
  await expect(page.locator('.guide-card')).toHaveCount(0);
});

test('does not start behind Help when inert settlement exhausts', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'webkit-compact', 'covered in Chromium');
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  const help = await openHelp(page);
  await page.evaluate(() => {
    const root = document.getElementById('root');
    if (!root) throw new Error('missing root');
    Object.defineProperty(root, 'inert', {
      configurable: true,
      get: () => true,
      set: () => undefined,
    });
  });
  await help.getByRole('button', { name: /Start the guided tour/ }).click();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => (
      requestAnimationFrame(() => resolve())
    ))));
  }));
  await expect(page.locator('.guide-card')).toHaveCount(0);
  await page.evaluate(() => {
    const root = document.getElementById('root');
    if (root) Reflect.deleteProperty(root, 'inert');
  });
});

test('accepts a precise native occurrence and reveals Return on the Reader Back control', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'webkit-compact', 'covered in Chromium');
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'native-guide.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('zero wolf one two three four five wolf six', 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');
  await advanceToMark(page);

  const canvas = page.getByRole('slider', { name: /reading position/i })
    .locator('canvas[data-barcode-band="series"]');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({ position: { x: box!.width * (7.5 / 9), y: 3 } });
  const source = page.getByRole('dialog', { name: 'The text is the evidence' });
  await expect(source).toBeVisible();
  await page.getByRole('main', { name: /Reader:/ })
    .getByRole('button', { name: 'back', exact: true }).click();
  const returned = page.getByRole('dialog', { name: 'The place comes with you' });
  await expect(returned).toContainText('You are back on the chart, at the passage you just read.');
  await expect(returned.getByRole('button', { name: 'Finish' })).toBeVisible();
});

test('treats an unrelated workbench navigation as foreign without undoing it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'webkit-compact', 'covered in Chromium');
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await advanceToMark(page);
  await gotoPlace(page, 'matches');
  await expect(page.locator('.guide-card')).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]p=matches(?:&|#|$)/);
  await expect(page.locator('#root')).not.toHaveAttribute('data-guide-anchor-active');
});

test('lists only relevant Help notes and reads one without staging product work', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'webkit-compact', 'covered in Chromium');
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  const help = await openHelp(page);
  await expect(help.getByRole('button', { name: /Terms and the notebook/ })).toBeVisible();
  await expect(help.getByRole('button', { name: /Reading a trend/ })).toBeVisible();
  await expect(help.getByRole('button', { name: /The reading strip/ })).toBeVisible();
  await expect(help.getByRole('button', { name: /Compare a passage/ })).toHaveCount(0);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await help.getByRole('button', { name: /Reading a trend/ }).click();
  let card = page.locator('.guide-card');
  await expect(card.getByRole('heading', { name: 'Three views, one reading order' })).toBeFocused();
  await expect(page.locator('#root')).toHaveAttribute('data-guide-anchor-active', 'trend-plate');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toContainText('Height answers a chosen question');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#root')).toHaveAttribute('data-guide-anchor-active', 'dispersion-strip');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toContainText('The cursor is a shared place');
  await card.getByRole('button', { name: 'Done' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('#global-help-open')).toBeFocused();
  expect(workerQueriesAfter((await trace(page)).events, mark)).toEqual([]);

  const reopened = await openHelp(page);
  await reopened.getByRole('button', { name: /Reading a trend/ }).click();
  card = page.locator('.guide-card');
  await expect(card).toContainText('Three views, one reading order');
  await card.getByRole('button', { name: 'Exit guide' }).click();

  await gotoPlace(page, 'compare');
  const compareHelp = await openHelp(page);
  await expect(compareHelp.getByRole('button', { name: /Terms and the notebook/ })).toBeVisible();
  await expect(compareHelp.getByRole('button', { name: /Compare a passage/ })).toBeVisible();
  await expect(compareHelp.getByRole('button', { name: /Reading a trend/ })).toHaveCount(0);
  await expect(compareHelp.getByRole('button', { name: /The reading strip/ })).toHaveCount(0);
});

test('opens deep notes only from the useful Compare and Matches states', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'webkit-compact', 'covered in Chromium');
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'deep-guides.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('alpha beta gamma alpha', 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'compare');
  const compareLink = page.getByRole('button', { name: 'Guide: Compare a passage' });
  await expect(compareLink).toBeVisible();
  await compareLink.click();
  let card = page.locator('.guide-card');
  await expect(card).toContainText('Choose a passage or two texts');
  await expect(page.locator('#root')).toHaveAttribute('data-guide-anchor-active', 'compare-sides');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#root')).toHaveAttribute('data-guide-anchor-active', 'reading-footer');
  await card.getByRole('button', { name: 'Exit guide' }).click();
  await expect(compareLink).toBeFocused();

  await clearNotebook(page);
  await gotoPlace(page, 'matches');
  const termsLink = page.getByRole('button', { name: 'Guide: Terms and the notebook' });
  await expect(page.getByText('No terms shown in analysis.')).toBeVisible();
  await expect(termsLink).toBeVisible();
  await termsLink.click();
  card = page.locator('.guide-card');
  await expect(card).toContainText('A notebook, not a search box');
  await expect(page.locator('#root')).toHaveAttribute('data-guide-anchor-active', 'terms-rail');
  await card.getByRole('button', { name: 'Exit guide' }).click();

  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'term-that-never-occurs');
  await gotoPlace(page, 'matches');
  await expect(page.getByText('No occurrences of the enabled terms.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Guide: Terms and the notebook' })).toHaveCount(0);
});

test('keeps the action and exit reachable in compact portrait and landscape', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'webkit-compact', 'compact WebKit contract');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  const invitation = page.getByRole('complementary', { name: 'Guided tour invitation' });
  await expect(invitation).toBeVisible();
  await expectCardInsideViewport(page, invitation);
  await startTour(page);
  let card = page.locator('.guide-card');
  await expectCardInsideViewport(page, card);
  await card.getByRole('button', { name: 'Begin' }).click();
  await expect(card).toContainText('The terms you track');
  await expectCardInsideViewport(page, card);
  const terms = page.getByRole('complementary', { name: 'Terms' });
  await expect(terms).toBeVisible();
  const [cardBox, termsBox] = await Promise.all([card.boundingBox(), terms.boundingBox()]);
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(termsBox!.y + 1);
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);

  await page.setViewportSize({ width: 568, height: 320 });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  card = page.locator('.guide-card');
  await expectCardInsideViewport(page, card);
  await expect(card.getByRole('button', { name: 'Exit guided tour' })).toBeVisible();
});
