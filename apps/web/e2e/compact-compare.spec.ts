import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  clearDemoInputs,
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
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles([
    { name: 'alpha.md', mimeType: 'text/markdown', buffer: Buffer.from(ALPHA, 'utf-8') },
    { name: 'beta.md', mimeType: 'text/markdown', buffer: Buffer.from(BETA, 'utf-8') },
  ]);
  await awaitReadyCount(page, 2);
  await gotoPlace(page, 'compare');
}

const pyramid = (page: Page) =>
  page.getByRole('table', { name: 'Compare population pyramid' });

const wordButton = (page: Page, word: string) =>
  pyramid(page).getByRole('button', { name: new RegExp(`^${word},`) });

async function applyOneDocumentMinimum(page: Page) {
  await page.getByRole('button', { name: 'sort and filter' }).click();
  const form = page.getByRole('form', { name: 'Compare sort and filter' });
  await form.getByLabel('combined documents ≥').fill('1');
  await form.getByRole('button', { name: 'apply' }).click();
  await expect(wordButton(page, 'forest')).toBeVisible();
  await expect(wordButton(page, 'sea')).toBeVisible();
}

async function horizontalOrder(items: readonly Locator[]) {
  return Promise.all(items.map(async (item) => (await item.boundingBox())?.x ?? -1));
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
]) {
  test(`compact Compare preserves the population pyramid at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await prepareComparison(page);
    await applyOneDocumentMinimum(page);

    const table = pyramid(page);
    await expect(table).toHaveAttribute('aria-colcount', '2');
    await expect(table.getByRole('columnheader')).toHaveCount(2);
    await expect(table.getByRole('rowgroup', { name: 'Paired distinctive term ranks' }))
      .toBeVisible();
    const port = page.getByRole('region', { name: 'Compare population pyramid' });
    await expect(port).toHaveAttribute('tabindex', '0');

    const forest = wordButton(page, 'forest');
    const sea = wordButton(page, 'sea');
    const forestHalf = forest.locator('xpath=..');
    const seaHalf = sea.locator('xpath=..');
    await expect(forestHalf).toHaveAttribute('data-side', 'a');
    await expect(seaHalf).toHaveAttribute('data-side', 'b');
    await expect(forest.locator('.compare-pyramid-bar')).toBeVisible();
    await expect(sea.locator('.compare-pyramid-bar')).toBeVisible();
    const leftOrder = await horizontalOrder([
      forest.locator('.compare-pyramid-value'),
      forest.locator('.compare-pyramid-term'),
      forest.locator('.compare-pyramid-plot'),
    ]);
    expect(leftOrder).toEqual([...leftOrder].sort((a, b) => a - b));
    const rightOrder = await horizontalOrder([
      sea.locator('.compare-pyramid-plot'),
      sea.locator('.compare-pyramid-term'),
      sea.locator('.compare-pyramid-value'),
    ]);
    expect(rightOrder).toEqual([...rightOrder].sort((a, b) => a - b));
    expect((await forest.boundingBox())?.height).toBeGreaterThanOrEqual(44);

    for (const name of ['Side A pagination', 'Side B pagination']) {
      await expect(page.getByRole('group', { name })).toContainText(/distinctive terms?/);
    }
    await expectNoBodyOverflow(page);
  });
}

test('side selectors support a rest comparison and prevent duplicate texts', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await prepareComparison(page);
  const left = page.getByLabel('Left comparison input');
  const right = page.getByLabel('Right comparison input');
  const leftInitial = await left.inputValue();
  const rightInitial = await right.inputValue();
  expect(leftInitial).not.toBe(rightInitial);
  await expect(left.locator(`option[value="${rightInitial}"]`)).toHaveAttribute('disabled', '');
  await expect(right.locator(`option[value="${leftInitial}"]`)).toHaveAttribute('disabled', '');

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await left.selectOption('__rest__');
  await expect(left).toHaveValue('__rest__');
  await expect(right).toHaveValue(rightInitial);
  await expect.poll(async () => (await trace(page)).events.filter(
    (event) => event.seq > mark && event.direction === 'to-worker'
      && event.t === 'query' && event.op === 'keyness',
  ).length).toBe(2);
  await expect(pyramid(page).getByRole('columnheader').first())
    .toContainText(/all books except/i);

  await left.selectOption(leftInitial);
  await expect(left).toHaveValue(leftInitial);
  await expect(right).toHaveValue(rightInitial);
  await page.getByRole('button', { name: 'Swap keyness sides' }).click();
  await expect(left).toHaveValue(rightInitial);
  await expect(right).toHaveValue(leftInitial);
});

test('one full-width word detail replaces the other half and explains measurements', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareComparison(page);
  await applyOneDocumentMinimum(page);

  await wordButton(page, 'forest').click();
  const forest = page.getByRole('region', { name: 'Compare detail: forest, side A' });
  await expect(forest).toBeVisible();
  await expect(forest.getByRole('heading', { name: 'forest' })).toBeVisible();
  await expect(forest.locator('dt')).toHaveCount(10);
  await expect(forest.getByRole('button', { name: 'About log₂ ratio' })).toBeVisible();
  const detailCell = forest.locator('xpath=ancestor::td');
  await expect(detailCell).toHaveAttribute('colspan', '2');

  await wordButton(page, 'sea').click();
  await expect(forest).toHaveCount(0);
  const sea = page.getByRole('region', { name: 'Compare detail: sea, side B' });
  await expect(sea).toBeVisible();
  await sea.getByRole('button', { name: 'Close comparison detail for sea' }).click();
  await expect(sea).toHaveCount(0);
  await expectNoBodyOverflow(page);
});

test('Compare settings preserve a draft through width changes and apply one shared budget', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareComparison(page);

  const open = page.getByRole('button', { name: 'sort and filter' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Compare sort and filter' });
  const minimum = page.getByLabel('combined documents ≥');
  await expect(dialog).toBeVisible();
  const quietMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await minimum.fill('1');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await open.click();
  await expect(minimum).toHaveValue('1');

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Compare sort and filter' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  expect((await trace(page)).events.filter(
    (event) => event.seq > quietMark && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);

  const applyMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await dialog.getByRole('button', { name: 'apply' }).click();
  await expect(wordButton(page, 'forest')).toBeVisible();
  const queries = (await trace(page)).events.filter(
    (event) => event.seq > applyMark && event.direction === 'to-worker'
      && event.t === 'query',
  );
  expect(queries.filter((event) => event.op === 'keyness')).toHaveLength(2);
  expect(queries.filter((event) => event.op === 'inventory')).toHaveLength(0);
});
