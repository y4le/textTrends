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
  await page.getByRole('button', { name: 'Compare settings' }).click();
  const form = page.getByRole('form', { name: 'Compare settings' });
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
    await expect(table.getByRole('columnheader')).toHaveCount(0);
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
    await expect(forest.locator('.compare-pyramid-value')).toBeHidden();
    await expect(sea.locator('.compare-pyramid-value')).toBeHidden();
    const leftOrder = await horizontalOrder([
      forest.locator('.compare-pyramid-term'),
      forest.locator('.compare-pyramid-plot'),
    ]);
    expect(leftOrder).toEqual([...leftOrder].sort((a, b) => a - b));
    const rightOrder = await horizontalOrder([
      sea.locator('.compare-pyramid-plot'),
      sea.locator('.compare-pyramid-term'),
    ]);
    expect(rightOrder).toEqual([...rightOrder].sort((a, b) => a - b));
    const carriageTerm = wordButton(page, 'carriage').locator('.compare-pyramid-term');
    await expect(carriageTerm).toBeVisible();
    await expect(carriageTerm).toHaveText('carriage');
    await expect.poll(() => carriageTerm.evaluate((term) => ({
      fullWidthVisible: term.scrollWidth <= term.clientWidth + 1,
      wrapsWhenNeeded: getComputedStyle(term).whiteSpace === 'normal',
    }))).toEqual({ fullWidthVisible: true, wrapsWhenNeeded: true });
    expect((await forest.boundingBox())?.height).toBeGreaterThanOrEqual(44);

    await expect(page.locator('.compare-pagers, .compare-pagination')).toHaveCount(0);
    await expect(page.locator('.compare-rank-progress')).toHaveCount(0);
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
  const reverse = page.getByRole('button', { name: 'Reverse both rankings' });
  await expect(reverse).toHaveText('Swap');
  await expect(reverse).toHaveAttribute('aria-label', /^Swap\b/);
  const reverseBox = await reverse.boundingBox();
  const leftBox = await left.boundingBox();
  expect(reverseBox?.x).toBeLessThan(leftBox?.x ?? 0);
  expect((await left.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect((await right.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByText('left side', { exact: true })).toHaveCount(0);
  await expect(page.getByText('right side', { exact: true })).toHaveCount(0);
  expect(leftInitial).not.toBe(rightInitial);
  expect(leftInitial).not.toBe('__rest__');
  expect(rightInitial).toBe('__rest__');

  const rightDocument = await right
    .locator('option:not([value^="__"]):not([disabled])')
    .first()
    .getAttribute('value');
  expect(rightDocument).not.toBeNull();
  await right.selectOption(rightDocument!);
  await expect(right).toHaveValue(rightDocument!);
  await expect(left.locator(`option[value="${rightDocument}"]`)).toHaveAttribute('disabled', '');
  await expect(right.locator(`option[value="${leftInitial}"]`)).toHaveAttribute('disabled', '');

  let mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await reverse.click();
  await expect.poll(async () => (await trace(page)).events.filter(
    (event) => event.seq > mark && event.direction === 'to-worker'
      && event.t === 'query' && event.op === 'keyness',
  ).length).toBe(2);

  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await left.selectOption('__rest__');
  await expect(left).toHaveValue('__rest__');
  await expect(right).toHaveValue(rightDocument!);
  await expect.poll(async () => (await trace(page)).events.filter(
    (event) => event.seq > mark && event.direction === 'to-worker'
      && event.t === 'query' && event.op === 'keyness',
  ).length).toBe(2);
  await expect(left.locator('option:checked')).toContainText(/all other texts/i);

  await left.selectOption(leftInitial);
  await expect(left).toHaveValue(leftInitial);
  await expect(right).toHaveValue(rightDocument!);
  await expect(page.getByRole('button', { name: 'Swap keyness sides' })).toHaveCount(0);
});

test('one full-width word detail replaces the other half and explains measurements', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareComparison(page);
  await applyOneDocumentMinimum(page);

  const forestRow = wordButton(page, 'forest');
  const rowLift = (await forestRow.locator('.compare-pyramid-value').textContent())?.trim();
  await forestRow.click();
  const forest = page.getByRole('region', { name: 'Compare detail: forest, side A' });
  await expect(forest).toBeVisible();
  await expect(forest.getByRole('heading', { name: 'forest' })).toBeVisible();
  // Nine measurements: counts, rates, log ratio, its 95% interval, G², class,
  // combined count. Range is absent because each side here IS one text, where
  // it could only ever read 0 or 1; dispersion is undefined for the same
  // reason.
  await expect(forest.locator('dt')).toHaveCount(9);
  await expect(forest.getByRole('button', { name: 'About log₂ ratio' })).toBeVisible();
  const detailLift = forest.locator('.compare-row-stats > div')
    .filter({ hasText: 'log₂ ratio' })
    .locator('dd');
  await expect(detailLift).toContainText(rowLift!);
  await expect(forest.getByRole('button', { name: 'About 95% interval' })).toBeVisible();
  await expect(forest.getByText('text range', { exact: false })).toHaveCount(0);
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

test('Compare settings discard on close, retain in-place drafts, and stage ranking reversal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareComparison(page);

  const open = page.getByRole('button', { name: 'Compare settings' });
  const historyBefore = await page.evaluate(() => history.length);
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const minimum = dialog.getByLabel('combined documents ≥');
  const commonWords = dialog.getByRole('slider', { name: 'remove common words' });
  const initialMinimum = await minimum.inputValue();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('shared sort field')).toBeFocused();
  const landing = await dialog.evaluate((element) => {
    const body = element.querySelector<HTMLElement>('.utility-pane-body');
    const heading = element.querySelector<HTMLElement>('#settings-place-heading');
    if (!body || !heading) return null;
    return {
      bodyTop: body.getBoundingClientRect().top,
      headingTop: heading.getBoundingClientRect().top,
    };
  });
  expect(landing).not.toBeNull();
  expect(Math.abs(landing!.bodyTop - landing!.headingTop)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  await expect(commonWords).toHaveAccessibleName('remove common words');
  await expect(commonWords).toHaveValue('0');
  await expect(commonWords).toHaveAttribute('aria-valuetext', /off/);
  expect((await commonWords.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const quietMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await minimum.fill('1');
  await commonWords.fill('100');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await open.click();
  await expect(minimum).toHaveValue(initialMinimum);
  await expect(commonWords).toHaveValue('0');
  expect((await trace(page)).events.filter(
    (event) => event.seq > quietMark && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);
  await minimum.fill('1');
  await commonWords.fill('100');

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('form', { name: 'Compare settings' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await expect(commonWords).toHaveValue('100');
  expect((await trace(page)).events.filter(
    (event) => event.seq > quietMark && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);

  await expect(dialog.getByLabel('left ranking order')).toHaveValue('-1');
  await expect(dialog.getByLabel('right ranking order')).toHaveValue('1');
  await expect(dialog.getByLabel('shared sort field'))
    .toHaveValue('logRatio');
  await dialog.getByLabel('shared sort field').selectOption('logRatioLow');
  await dialog.getByLabel('left ranking order').selectOption('1');
  await dialog.getByLabel('right ranking order').selectOption('-1');
  await expect(dialog.getByLabel('left ranking order')).toHaveValue('1');
  await expect(dialog.getByLabel('right ranking order')).toHaveValue('-1');

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

test('Compare disclosure contains divergence and the two-sided text profile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareComparison(page);
  await applyOneDocumentMinimum(page);

  const divergence = page.locator('[data-metric="divergence"]');
  await expect(divergence).toHaveCount(0);

  const trigger = page.getByRole('button', { name: 'Text profile' });
  await expect(trigger).toHaveText('Profile');
  const triggerSize = await trigger.boundingBox();
  expect(triggerSize?.width).toBe(44);
  expect(triggerSize?.height).toBe(46);
  const left = page.getByLabel('Left comparison input');
  const right = page.getByLabel('Right comparison input');
  const [leftBox, triggerBox, rightBox] = await Promise.all([
    left.boundingBox(),
    trigger.boundingBox(),
    right.boundingBox(),
  ]);
  expect((leftBox?.x ?? 0) + (leftBox?.width ?? 0))
    .toBeLessThanOrEqual(triggerBox?.x ?? 0);
  expect((triggerBox?.x ?? 0) + (triggerBox?.width ?? 0))
    .toBeLessThanOrEqual(rightBox?.x ?? 0);
  expect(await trigger.evaluate((button) =>
    Number.parseFloat(getComputedStyle(button).fontSize))).toBeGreaterThanOrEqual(11);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  const profile = page.getByRole('region', { name: 'Text profile' });
  await expect(divergence).toBeVisible();
  await expect(divergence.locator('.compare-divergence-value')).not.toHaveText('—');

  await expect(profile.locator('.compare-profile-grid')).toBeVisible();
  await expect(profile.getByRole('columnheader')).toHaveCount(0);
  for (const metric of ['tokens', 'sentences', 'mattr', 'ari']) {
    await expect(profile.locator(`[data-metric="${metric}"]`)).toBeVisible();
  }
  await expect(profile.locator('.compare-profile-bar')).toHaveCount(0);

  await expectNoBodyOverflow(page);
});

test('Compare hides interval whiskers by default and can reveal them without requerying', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await prepareComparison(page);
  await applyOneDocumentMinimum(page);

  let forest = wordButton(page, 'forest');
  await expect(forest.locator('.compare-pyramid-interval')).toHaveCount(0);
  await expect(forest).not.toHaveAttribute('aria-label', /95% interval/);

  await page.getByRole('button', { name: 'Compare settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByLabel('Show 95% confidence interval whiskers').check();
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await settings.getByRole('button', { name: 'apply' }).click();
  expect((await trace(page)).events.filter(
    (event) => event.seq > mark && event.direction === 'to-worker'
      && event.t === 'query' && event.op === 'keyness',
  )).toEqual([]);

  // The optional whisker rides the same axis as the bar it qualifies.
  forest = wordButton(page, 'forest');
  await expect(forest.locator('.compare-pyramid-interval')).toBeVisible();
  await expect(forest).toHaveAttribute('aria-label', /95% interval/);

  await forest.click();
  const detail = page.getByRole('region', { name: /Compare detail: forest/ });
  await expect(detail).toBeVisible();
  await expect(detail.getByText('95% interval')).toBeVisible();
  // Both sides are single documents here, so range would only ever read 0 or 1
  // and dispersion is undefined — neither may be published as a finding.
  await expect(detail.getByText(/^text range/)).toHaveCount(0);
  await expect(detail.getByText(/^dispersion/)).toHaveCount(0);
});
