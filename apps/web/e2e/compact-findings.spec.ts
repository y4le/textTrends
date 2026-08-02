import { expect, test, type Page } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  gotoPlace,
  trace,
} from './helpers.ts';

async function expectNoBodyOverflow(page: Page) {
  const geometry = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(geometry.document).toBeLessThanOrEqual(geometry.client);
  expect(geometry.body).toBeLessThanOrEqual(geometry.client);
}

async function saveOpeningRange(page: Page) {
  await gotoPlace(page, 'trends');
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  await scrubber.press('ArrowRight');
  await scrubber.press('Enter');
  await expect(page.getByText(/Selected 2 tokens in/)).toBeVisible();

  await gotoPlace(page, 'findings');
  await page.getByLabel('Saved range name').fill('Opening pair');
  await page.getByRole('button', { name: 'save range' }).click();
  await expect(
    page.getByRole('list', { name: 'Saved ranges' }).getByText('Opening pair'),
  ).toBeVisible();

  await gotoPlace(page, 'trends');
  await page.getByRole('button', { name: 'clear selection' }).click();
  await expect(page.getByRole('region', { name: 'Scope' }))
    .not.toContainText(/tokens 1–2/);
  await gotoPlace(page, 'findings');
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
]) {
  test(`compact Findings is one bounded research log at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await awaitAllReady(page);
    await gotoPlace(page, 'findings');

    const log = page.locator('.findings-log');
    await expect(log).toBeVisible();
    await expect(page.getByRole('region', { name: 'Saved excerpts' }))
      .toContainText('0 saved · limit 8');
    await expect(log.getByRole('heading', { level: 3 })).toHaveText([
      'Saved ranges',
      'Saved excerpts',
      'Sharing',
      'Incoming shared state',
      'Research and project record',
    ]);

    const controlBoxes = await log.locator('button, input, textarea').evaluateAll((nodes) =>
      nodes
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => {
          const box = node.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }));
    expect(controlBoxes.length).toBeGreaterThan(0);
    for (const box of controlBoxes) {
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const exactFontSizes = await log.locator('.exact-input').evaluateAll((nodes) =>
      nodes
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => Number.parseFloat(getComputedStyle(node).fontSize)));
    expect(exactFontSizes.length).toBeGreaterThan(0);
    for (const size of exactFontSizes) expect(size).toBeGreaterThanOrEqual(16);
    await expectNoBodyOverflow(page);
  });
}

test('compact share review is modal, draft-preserving, and query-silent across width changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'findings');

  await page.getByRole('button', { name: 'preview share link' }).click();
  const share = await page.getByLabel('Share link preview').inputValue();
  await page.getByLabel('Share link to import').fill(share);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  const open = page.getByRole('button', { name: 'review shared state' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Review shared state' });
  const draft = dialog.getByLabel('Share link to import');
  const replace = dialog.getByRole('button', { name: 'replace with this shared state' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue(share);
  expect(await dialog.locator('.share-review-actions').evaluate(
    (node) => getComputedStyle(node).position,
  )).toBe('sticky');
  await draft.press('Shift+Tab');
  await expect(replace).toBeFocused();
  await replace.press('Tab');
  await expect(draft).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await open.click();
  await expect(draft).toHaveValue(share);
  await dialog.getByRole('button', { name: 'cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(page.getByLabel('Share link to import')).toHaveValue(share);

  await open.click();
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(dialog).toHaveCount(0);
  const inline = page.getByRole('form', { name: 'Review shared state' });
  await expect(inline).toBeVisible();
  await expect(inline.getByLabel('Share link to import')).toHaveValue(share);
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await expect(draft).toHaveValue(share);
  const queries = (await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  );
  expect(queries).toEqual([]);
  await expectNoBodyOverflow(page);
});

test('saved-range preview reads evidence without adopting scope; Apply is explicit', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await saveOpeningRange(page);

  const scope = page.getByRole('region', { name: 'Scope' });
  const ranges = page.getByRole('list', { name: 'Saved ranges' });
  const row = ranges.locator('.findings-record-trigger');
  await row.click();
  const detail = page.getByRole('region', { name: 'Saved range detail: Opening pair' });
  await expect(detail).toContainText('not checked in this session', { ignoreCase: true });

  const previewMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await detail.getByRole('button', { name: 'preview passage' }).click();
  const evidence = page.getByRole('dialog', { name: 'Evidence sheet' });
  await expect(evidence).toBeVisible();
  await expect(evidence).toHaveAttribute('data-detent', 'tall');
  await expect(scope).not.toContainText(/tokens 1–2/);
  const previewQueries = (await trace(page)).events.filter(
    (event) =>
      event.seq > previewMark
      && event.direction === 'to-worker'
      && event.t === 'query',
  );
  expect(previewQueries.filter((event) => event.op === 'compile-anchor')).toHaveLength(1);
  expect(previewQueries.filter((event) => event.op === 'passage').length)
    .toBeLessThanOrEqual(1);
  expect(previewQueries.every(
    (event) => event.op === 'compile-anchor' || event.op === 'passage',
  )).toBe(true);

  await page.goBack();
  await expect(evidence).toHaveCount(0);
  await expect(row).toBeFocused();
  const applyMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await detail.getByRole('button', { name: 'use as linked range' }).click();
  await expect(scope).toContainText(/tokens 1–2/);
  await expect.poll(async () => (await trace(page)).events.filter(
    (event) =>
      event.seq > applyMark
      && event.direction === 'to-worker'
      && event.t === 'query'
      && event.op === 'compile-anchor',
  ).length).toBe(1);
});

test('removing the final pin restores focus to the capacity group', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('p');
  await gotoPlace(page, 'findings');
  const pins = page.getByRole('region', { name: 'Saved excerpts' });
  await pins.locator('.findings-record-trigger').click();
  await pins.getByRole('button', { name: 'remove' }).click();
  await expect(pins).toContainText('0 saved · limit 8');
  await expect(page.getByRole('heading', { name: 'Saved excerpts' })).toBeFocused();
});

test('Corpus points to the one project Save and status owner in Findings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'mobile-project.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('A small project with exact durable evidence.', 'utf8'),
  });
  await awaitReadyCount(page, 1);

  await expect(page.getByRole('button', { name: 'Save project' })).toHaveCount(0);
  const pointer = page.getByRole('button', { name: 'Save and status in Findings' });
  await expect(pointer).toBeVisible();
  await pointer.click();
  await expect(page).toHaveURL(/[?&]p=findings(?:&|$)/);
  const save = page.getByRole('button', { name: 'Save project' });
  await expect(save).toHaveCount(1);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('region', { name: 'Findings', exact: true })
    .getByText('Project revision 1 is saved.')).toBeVisible({ timeout: 30_000 });
});
