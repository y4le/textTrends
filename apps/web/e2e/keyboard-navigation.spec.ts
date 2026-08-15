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
  const termButtons = page.locator('[data-term-focus]:not(:disabled)');
  await expect(termButtons.nth(0)).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeTerms);
  const focusedTermBox = await termButtons.nth(0).boundingBox();
  expect(focusedTermBox?.y).toBeGreaterThanOrEqual(0);
  expect(focusedTermBox ? focusedTermBox.y + focusedTermBox.height : Number.POSITIVE_INFINITY)
    .toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
  await expect(termButtons.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await termButtons.nth(0).press('l');
  await expect(termButtons.nth(1)).toBeFocused();
  await expect(termButtons.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await termButtons.nth(1).press('g');
  await page.keyboard.press('l');
  await page.keyboard.press('t');
  await expect(inputsSurface).toBeVisible();
  await expect(termButtons.nth(2)).toBeFocused();
  await termButtons.nth(2).press('h');
  await expect(termButtons.nth(1)).toBeFocused();
  await termButtons.nth(1).press('ArrowLeft');
  await expect(termButtons.nth(0)).toBeFocused();

  await chord(termButtons.nth(0), ']', 't');
  await expect(termButtons.nth(1)).toBeFocused();
  await chord(termButtons.nth(1), '[', 't');
  await expect(termButtons.nth(0)).toBeFocused();

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
  await expect(page.getByRole('button', { name: 'separate', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');

  await chord(scrubber, 'g', 'm');
  await expect(page.getByRole('region', { name: 'Matches', exact: true })).toBeFocused();
  await chord(page.locator('body'), 'g', 'v');
  await expect(page.getByRole('region', { name: 'Vocabulary', exact: true })).toBeFocused();
  await chord(page.locator('body'), 'g', 'd');
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
  await compareRows.first().focus();
  await compareRows.first().press('ArrowDown');
  await expect(compareRows.nth(1)).toBeFocused();
  await expect(compareRows.first().locator('xpath=..')).toHaveAttribute('data-side', 'a');
  await expect(compareRows.nth(1).locator('xpath=..')).toHaveAttribute('data-side', 'b');
  await compareRows.nth(1).press('k');
  await expect(compareRows.first()).toBeFocused();
  await compareRows.first().press('Enter');
  await expect(compareRows.first()).toHaveAttribute('aria-expanded', 'true');
  await compareRows.first().press('Escape');
  await expect(compareRows.first()).toHaveAttribute('aria-expanded', 'false');
  await expect(compareRows.first()).toBeFocused();
  await compareRows.first().press('Escape');
  await expect(comparePort).toBeFocused();
});
