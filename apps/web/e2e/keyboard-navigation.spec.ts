import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace } from './helpers.ts';

async function chord(
  target: import('@playwright/test').Locator,
  first: string,
  second: string,
) {
  await target.press(first);
  await target.press(second);
}

test('Vim sequences and conventional arrows navigate visible workbench targets', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  await chord(page.locator('body'), 'g', 'i');
  const inputsSurface = page.getByRole('region', { name: 'Inputs', exact: true });
  await expect(inputsSurface).toBeVisible();
  await expect(inputsSurface).toBeFocused();

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const scrollBeforeTerms = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('g');
  await page.keyboard.press('q');
  const termItems = page.locator('[data-term-focus]:not(:disabled)');
  const termToggles = page.locator('[data-term-toggle]:not(:disabled)');
  await expect(termItems.nth(0)).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeTerms);
  const termItemBox = await termItems.nth(0).boundingBox();
  expect(termItemBox?.y).toBeGreaterThanOrEqual(0);
  expect(termItemBox ? termItemBox.y + termItemBox.height : Number.POSITIVE_INFINITY)
    .toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
  await expect(termToggles.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await termItems.nth(0).press('Space');
  await expect(termToggles.nth(0)).toHaveAttribute('aria-pressed', 'false');
  await termItems.nth(0).press('Space');
  await expect(termToggles.nth(0)).toHaveAttribute('aria-pressed', 'true');

  const firstBook = page.getByRole('button', { name: 'A Study in Scarlet', exact: true });
  await firstBook.focus();

  await chord(firstBook, 'g', 't');
  const trendsSurface = page.getByRole('region', { name: 'Trends', exact: true });
  await expect(trendsSurface).toBeFocused();
  const trendsLink = page.getByRole('link', { name: 'Trends', exact: true });
  const matchesLink = page.getByRole('link', { name: 'Matches', exact: true });
  await trendsLink.focus();
  await trendsLink.press('ArrowRight');
  await expect(matchesLink).toBeFocused();
  await expect(trendsSurface).toBeVisible();

  const scrubber = page.getByRole('slider', { name: 'Reading position scrubber' });
  await scrubber.focus();
  await scrubber.press('v');
  await expect(page.getByRole('button', { name: 'To scale — separate rows, same token scale', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');

  await chord(scrubber, 'g', 'm');
  await expect(page.getByRole('region', { name: 'Matches', exact: true })).toBeFocused();
  await chord(page.locator('body'), 'g', 'v');
  await expect(page.getByRole('region', { name: 'Scrollable Vocabulary frequency list' }))
    .toBeFocused();
  await chord(page.locator('body'), 'g', 'c');
  await expect(page.getByRole('region', { name: 'Compare', exact: true })).toBeFocused();
  await chord(page.locator('body'), 'g', 'f');
  await expect(page.getByRole('slider', { name: 'Corpus footer position' })).toBeFocused();

  await gotoPlace(page, 'inputs');
  const filter = page.getByRole('searchbox', { name: 'Filter the Standard Ebooks library' });
  await filter.fill('');
  await filter.pressSequentially('gt]b');
  await expect(filter).toHaveValue('gt]b');
  await expect(page.getByRole('region', { name: 'Inputs', exact: true })).toBeVisible();
});

test('the term rail supports keyboard management, inline creation, and touch actions', async ({
  page,
}) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  await chord(page.locator('body'), 'g', 'q');
  const terms = page.getByRole('complementary', { name: 'Terms' });
  const items = terms.locator('[data-term-focus]:not(:disabled)');
  await expect(items).toHaveCount(3);
  await expect(items.first()).toBeFocused();

  await items.first().press('l');
  await expect(items.nth(1)).toBeFocused();
  await items.nth(1).press('ArrowRight');
  await expect(items.nth(2)).toBeFocused();
  await items.nth(2).press('h');
  await expect(items.nth(1)).toBeFocused();
  await items.nth(1).press('ArrowLeft');
  await expect(items.first()).toBeFocused();

  await items.first().press('Enter');
  let menu = page.getByRole('menu', { name: /Manage / });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Select only this item',
    'Delete this item',
    'Manage this item',
  ]);
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await menu.getByRole('menuitem').first().press('ArrowDown');
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  await menu.getByRole('menuitem').nth(1).press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(items.first()).toBeFocused();

  await items.first().press('Enter');
  menu = page.getByRole('menu', { name: /Manage / });
  await menu.getByRole('menuitem', { name: 'Select only this item', exact: true }).click();
  await expect(terms.locator('.term-bucket-summary[data-projected="true"]')).toHaveCount(1);
  await expect(items.first()).toBeFocused();
  await items.first().press('Enter');
  await page.getByRole('menuitem', { name: 'Show all selected items', exact: true }).click();
  await expect(terms.locator('.term-bucket-summary[data-projected="true"]')).toHaveCount(3);

  await items.first().press('a');
  const inline = terms.getByRole('form', { name: 'Add a term inline' });
  const input = inline.getByRole('textbox', { name: 'New term' });
  await expect(input).toBeFocused();
  await input.fill('new keyboard term');
  await input.press('Enter');
  await expect(items).toHaveCount(4);
  await expect(terms.getByRole('button', { name: 'new keyboard term, shown in analysis' }))
    .toBeFocused();
  await page.keyboard.press('x');
  await expect(items).toHaveCount(3);
  await expect(items.nth(2)).toBeFocused();

  await items.nth(2).press('Escape');
  await expect(terms.getByRole('group', { name: 'Query terms' })).toBeFocused();
  await chord(page.locator('body'), 'g', 'q');
  await expect(items.first()).toBeFocused();

  const firstBucket = terms.locator('.term-bucket').first();
  const box = await firstBucket.boundingBox();
  if (!box) throw new Error('term bucket has no layout box');
  const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await firstBucket.dispatchEvent('pointerdown', {
    ...point,
    pointerId: 81,
    pointerType: 'touch',
    button: 0,
    buttons: 1,
    isPrimary: true,
  });
  await page.waitForTimeout(550);
  await firstBucket.dispatchEvent('pointerup', {
    ...point,
    pointerId: 81,
    pointerType: 'touch',
    button: 0,
    buttons: 0,
    isPrimary: true,
  });
  menu = page.getByRole('menu', { name: /Manage / });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Manage this item', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Manage terms' })).toBeVisible();
});

test('result tables retain their intended keyboard behavior', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  await gotoPlace(page, 'inputs');
  const catalogPort = page.getByRole('region', { name: 'Scrollable text details table' });
  const books = page.locator('[data-catalog-book] .catalog-book-title > button');
  await expect(books).toHaveCount(6);
  await expect(page.locator('[data-catalog-book] .catalog-book-title > button[tabindex="0"]'))
    .toHaveCount(1);
  await books.first().focus();
  await books.first().press('j');
  await expect(books.nth(1)).toBeFocused();
  await books.nth(1).press('ArrowUp');
  await expect(books.first()).toBeFocused();
  await books.first().press('End');
  await expect(books.last()).toBeFocused();
  await books.last().press('Home');
  await expect(books.first()).toBeFocused();
  await books.first().press('Enter');
  await expect(books.first()).toHaveAttribute('aria-expanded', 'true');
  await books.first().press('Escape');
  await expect(books.first()).toHaveAttribute('aria-expanded', 'false');
  await expect(books.first()).toBeFocused();
  await books.first().press('Escape');
  await expect(catalogPort).toBeFocused();

  await gotoPlace(page, 'matches');
  const matchesPort = page.getByRole('grid', { name: 'Matches' });
  const occurrences = matchesPort.locator('[role="row"][aria-rowindex] .kwic-node > button');
  await expect(occurrences.first()).toBeVisible();
  expect(await occurrences.evaluateAll((buttons) =>
    buttons.every((button) => button.getAttribute('tabindex') === '-1'))).toBe(true);
  await matchesPort.focus();
  const activeBefore = await matchesPort.getAttribute('aria-activedescendant');
  await matchesPort.press('ArrowDown');
  await expect.poll(() => matchesPort.getAttribute('aria-activedescendant'))
    .not.toBe(activeBefore);
  await matchesPort.press('Enter');
  await expect(page.getByRole('main', { name: /Reader:/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(matchesPort).toBeFocused();

  await gotoPlace(page, 'vocabulary');
  const vocabularyPort = page.locator('.frequency-table-port');
  const vocabularyRows = page.locator('[data-frequency-row] .frequency-term > button');
  await expect(vocabularyRows.first()).toBeVisible();
  await expect(page.locator('[data-frequency-row] .frequency-term > button[tabindex="0"]'))
    .toHaveCount(1);
  await vocabularyRows.first().focus();
  await vocabularyRows.first().press('PageDown');
  await expect(vocabularyRows.first()).not.toBeFocused();
  await page.keyboard.press('Home');
  await expect(vocabularyRows.first()).toBeFocused();
  await vocabularyRows.first().press('Enter');
  await expect(vocabularyRows.first()).toHaveAttribute('aria-expanded', 'true');
  await vocabularyRows.first().press('Escape');
  await expect(vocabularyRows.first()).toHaveAttribute('aria-expanded', 'false');
  await expect(vocabularyRows.first()).toBeFocused();
  await vocabularyRows.first().press('Escape');
  await expect(vocabularyPort).toBeFocused();

  await gotoPlace(page, 'compare');
  const comparePort = page.locator('.compare-table-port');
  const compareRows = page.locator('.compare-pyramid-button');
  await expect(compareRows.first()).toBeVisible();
  await expect(page.locator('.compare-pyramid-button[tabindex="0"]'))
    .toHaveCount(1);
  await page.locator('#place-compare-heading').focus();
  await page.locator('#place-compare-heading').press('j');
  await expect(compareRows.first()).toBeFocused();
  await compareRows.first().press('l');
  await expect(compareRows.nth(1)).toBeFocused();
  await compareRows.nth(1).press('k');
  await expect(compareRows.nth(1)).toBeFocused();
  await expect(
    page.locator('.compare-axis-section [role="status"]')
      .filter({ hasText: 'Compare side B: first row' }),
  ).toHaveCount(1);
  await compareRows.nth(1).press('h');
  await expect(compareRows.first()).toBeFocused();
  await compareRows.first().press('ArrowDown');
  await expect(compareRows.nth(2)).toBeFocused();
  await expect(compareRows.first().locator('xpath=..')).toHaveAttribute('data-side', 'a');
  await expect(compareRows.nth(2).locator('xpath=..')).toHaveAttribute('data-side', 'a');
  await compareRows.nth(2).press('l');
  await expect(compareRows.nth(3)).toBeFocused();
  await expect(compareRows.nth(3).locator('xpath=..')).toHaveAttribute('data-side', 'b');
  await compareRows.nth(3).press('h');
  await expect(compareRows.nth(2)).toBeFocused();
  await compareRows.nth(2).press('k');
  await expect(compareRows.first()).toBeFocused();
  await compareRows.first().press('Enter');
  await expect(compareRows.first()).toHaveAttribute('aria-expanded', 'true');
  await compareRows.first().press('Escape');
  await expect(compareRows.first()).toHaveAttribute('aria-expanded', 'false');
  await expect(compareRows.first()).toBeFocused();
  await compareRows.first().press('Escape');
  await expect(comparePort).toBeFocused();

  // A row must not steal the global g-prefix: all documented g … place
  // chords remain available from the Compare surface.
  await compareRows.first().focus();
  await chord(compareRows.first(), 'g', 't');
  await expect(page.getByRole('region', { name: 'Trends', exact: true })).toBeFocused();
});
