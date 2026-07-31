import { expect, test, type Page } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  gotoPlace,
  trace,
} from './helpers.ts';

const prose = (terms: readonly string[], repetitions: number) =>
  Array.from({ length: repetitions }, () => `${terms.join(' ')}.`).join(' ');

const ALPHA = [
  '# Forest',
  prose(['forest', 'wolf', 'pine', 'common'], 30),
  '# Road',
  prose(['forest', 'carriage', 'trail', 'common'], 20),
].join('\n\n');

const BETA = [
  '# Sea',
  prose(['sea', 'wave', 'salt', 'common'], 30),
  '# Harbor',
  prose(['sea', 'sail', 'harbor', 'common'], 20),
].join('\n\n');

async function expectNoBodyOverflow(page: Page) {
  const geometry = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(geometry.document).toBeLessThanOrEqual(geometry.client);
  expect(geometry.body).toBeLessThanOrEqual(geometry.client);
}

async function prepareComparison(page: Page) {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');
  await page.getByLabel('Create project from files').setInputFiles([
    { name: 'alpha.md', mimeType: 'text/markdown', buffer: Buffer.from(ALPHA, 'utf-8') },
    { name: 'beta.md', mimeType: 'text/markdown', buffer: Buffer.from(BETA, 'utf-8') },
  ]);
  await awaitReadyCount(page, 2);
  await gotoPlace(page, 'compare');
}

async function applyOneDocumentMinimum(page: Page) {
  await page.getByRole('button', { name: 'sort and filter' }).click();
  const form = page.getByRole('form', { name: 'Compare sort and filter' });
  await form.getByLabel('combined documents ≥').fill('1');
  await form.getByRole('button', { name: 'apply' }).click();
  await expect(
    page
      .getByRole('table', { name: 'Compare signed axis' })
      .getByRole('rowgroup', { name: /^Side A ·/ })
      .getByRole('row', { name: /^forest / }),
  ).toBeVisible();
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
]) {
  test(`compact Compare preserves the signed table at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await prepareComparison(page);
    await applyOneDocumentMinimum(page);

    const table = page.getByRole('table', { name: 'Compare signed axis' });
    await expect(table).toHaveAttribute('aria-colcount', '3');
    await expect(table.getByRole('columnheader')).toHaveCount(3);
    const sideA = table.getByRole('rowgroup', { name: /^Side A ·/ });
    await expect(sideA).toBeVisible();
    await expect(sideA).toHaveAttribute('aria-label', /projected terms?$/);
    await expect(table.getByRole('rowgroup', { name: /^Side B ·/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Scrollable Compare signed axis' }))
      .toHaveCount(0);

    const row = table
      .getByRole('rowgroup', { name: /^Side A ·/ })
      .getByRole('row', { name: /^forest / });
    await expect(row.getByRole('rowheader')).toContainText('forest');
    await expect(row.locator('.compare-effect-value')).toHaveText(/^\+/);
    await expect(row.locator('.compare-side')).toHaveText(/^A/);
    await expect(row.locator('.compare-axis-plot')).toHaveCount(0);
    const disclosure = row.getByRole('button', { name: /forest/ });
    const disclosureBox = await disclosure.boundingBox();
    expect(disclosureBox?.height).toBeGreaterThanOrEqual(44);

    for (const name of ['Side A pagination', 'Side B pagination']) {
      const pager = page.getByRole('group', { name });
      await expect(pager).toBeVisible();
      await expect(pager).toContainText(/projected terms?/);
    }
    await expectNoBodyOverflow(page);
  });
}

test('Compare settings preserve a draft through width changes and Apply has one exact shared budget', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareComparison(page);

  const open = page.getByRole('button', { name: 'sort and filter' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Compare sort and filter' });
  const minimum = page.getByLabel('combined documents ≥');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  const first = dialog.getByLabel('combined count ≥');
  const apply = dialog.getByRole('button', { name: 'apply' });
  await expect(first).toBeFocused();
  await first.press('Shift+Tab');
  await expect(apply).toBeFocused();
  await apply.press('Tab');
  await expect(first).toBeFocused();
  expect(await dialog.locator('.compare-settings-actions').evaluate(
    (node) => getComputedStyle(node).position,
  )).toBe('sticky');
  const quietMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await minimum.fill('1');
  expect(await minimum.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)))
    .toBeGreaterThanOrEqual(16);
  for (const name of ['cancel', 'apply']) {
    const box = await dialog.getByRole('button', { name }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await open.click();
  await expect(minimum).toHaveValue('1');
  await dialog.getByRole('button', { name: 'cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await open.click();
  await expect(minimum).toHaveValue('2');
  await minimum.fill('1');

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Compare sort and filter' })).toBeVisible();
  await expect(minimum).toHaveValue('1');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await expect(minimum).toHaveValue('1');
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > quietMark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);

  const applyMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await dialog.getByRole('button', { name: 'apply' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(
    page
      .getByRole('table', { name: 'Compare signed axis' })
      .getByRole('rowgroup', { name: /^Side A ·/ })
      .getByRole('row', { name: /^forest / }),
  ).toBeVisible();
  const queries = (await trace(page)).events.filter(
    (event) =>
      event.seq > applyMark
      && event.direction === 'to-worker'
      && event.t === 'query',
  );
  expect(queries.filter((event) => event.op === 'keyness')).toHaveLength(2);
  expect(queries.filter((event) => event.op === 'inventory')).toHaveLength(0);

  const directionMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const sideBLabel = await page
    .getByRole('table', { name: 'Compare signed axis' })
    .getByRole('rowgroup', { name: /^Side B ·/ })
    .getAttribute('aria-label');
  await page.getByRole('button', { name: /reverse side A/ }).click();
  await expect.poll(async () => (await trace(page)).events.filter(
    (event) =>
      event.seq > directionMark
      && event.direction === 'to-worker'
      && event.t === 'query'
      && event.op === 'keyness',
  ).length).toBe(1);
  await expect(
    page
      .getByRole('table', { name: 'Compare signed axis' })
      .getByRole('rowgroup', { name: sideBLabel ?? '' }),
  ).toBeVisible();
});

test('regular Compare restores the named focusable zero-centred axis port', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await prepareComparison(page);
  await applyOneDocumentMinimum(page);

  const port = page.getByRole('region', { name: 'Scrollable Compare signed axis' });
  await expect(port).toBeVisible();
  await expect(port).toHaveAttribute('tabindex', '0');
  const plots = page.locator('.compare-axis-plot');
  await expect(plots.first()).toBeVisible();
  await expect(page.locator('.compare-axis-zero').first()).toBeVisible();
  const caption = page
    .getByRole('table', { name: 'Compare signed axis' })
    .locator('caption');
  await expect(caption).toContainText('page-local log₂-ratio scale');
  await expect(caption).toContainText('exactly zero');
  await expectNoBodyOverflow(page);
});

test('compact side evidence is a tall governed sheet with truthful focus return', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareComparison(page);
  await applyOneDocumentMinimum(page);

  const forest = page
    .getByRole('table', { name: 'Compare signed axis' })
    .getByRole('rowgroup', { name: /^Side A ·/ })
    .getByRole('row', { name: /^forest / })
    .getByRole('button', { name: /forest/ });
  await forest.click();
  const detail = page.getByRole('region', { name: 'Compare detail: forest, side A' });
  await detail.getByRole('button', { name: 'show evidence' }).click();

  const sheet = page.getByRole('dialog', { name: 'Evidence' });
  await expect(sheet).toBeVisible();
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  const occurrences = sheet.locator('.comparison-occurrences');
  await expect(occurrences).toBeVisible();
  await expect(occurrences).toHaveAttribute(
    'aria-label',
    'Occurrences of “forest” restricted to side A: alpha',
  );
  await expect(occurrences.getByRole('table', { name: 'Comparison occurrence evidence' }))
    .toBeVisible();
  const dismissBox = await occurrences.getByRole('button', { name: 'dismiss' }).boundingBox();
  expect(dismissBox?.height).toBeGreaterThanOrEqual(44);
  const inspect = occurrences.getByRole('button', { name: 'inspect' }).first();
  const read = occurrences.getByRole('button', { name: 'Read' }).first();
  await expect(inspect).toBeVisible();
  await expect(read).toBeVisible();
  expect((await inspect.boundingBox())?.height).toBeLessThan(44);
  expect((await read.boundingBox())?.height).toBeLessThan(44);
  const closeBox = await sheet
    .getByRole('button', { name: 'Close Evidence sheet' })
    .boundingBox();
  expect(closeBox?.height).toBeGreaterThanOrEqual(44);
  await expectNoBodyOverflow(page);

  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await expect(detail).toBeVisible();
  await expect(forest).toBeFocused();
});
