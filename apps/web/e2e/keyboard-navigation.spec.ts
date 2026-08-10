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
  await awaitAllReady(page);

  await chord(page.locator('body'), 'g', 'c');
  const catalogHeading = page.getByRole('heading', { name: 'Catalog', exact: true });
  await expect(catalogHeading).toBeVisible();
  await expect(catalogHeading).toBeFocused();

  await chord(catalogHeading, 'g', 'q');
  const termButtons = page.locator('[data-term-focus]:not(:disabled)');
  await expect(termButtons.nth(0)).toBeFocused();
  await expect(termButtons.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await termButtons.nth(0).press('l');
  await expect(termButtons.nth(1)).toBeFocused();
  await expect(termButtons.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await termButtons.nth(1).press('g');
  await page.keyboard.press('l');
  await page.keyboard.press('t');
  await expect(catalogHeading).toBeVisible();
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
  await expect(firstBook).toHaveAttribute('aria-current', 'true');
  await chord(firstBook, ']', 'b');
  const secondBook = page.getByRole('button', { name: 'The Sign of the Four', exact: true });
  await expect(secondBook).toBeFocused();
  await expect(secondBook).toHaveAttribute('aria-current', 'true');
  await chord(secondBook, '[', 'b');
  await expect(firstBook).toBeFocused();

  await chord(firstBook, 'g', 't');
  const trendsHeading = page.getByRole('heading', { name: 'Trends', exact: true });
  await expect(trendsHeading).toBeFocused();
  const trendsLink = page.getByRole('link', { name: 'Trends', exact: true });
  const concordanceLink = page.getByRole('link', { name: 'Concordance', exact: true });
  await trendsLink.focus();
  await trendsLink.press('ArrowRight');
  await expect(concordanceLink).toBeFocused();
  await expect(trendsHeading).toBeVisible();

  const scrubber = page.getByRole('slider', { name: 'Reading position scrubber' });
  await scrubber.focus();
  await scrubber.press('v');
  await expect(page.getByRole('button', { name: 'by book', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');

  await chord(scrubber, 'g', 'k');
  await expect(page.getByRole('heading', { name: 'Concordance', exact: true })).toBeFocused();
  await chord(page.locator('body'), 'g', 'v');
  await expect(page.getByRole('heading', { name: 'Vocabulary', exact: true })).toBeFocused();
  await chord(page.locator('body'), 'g', 'd');
  await expect(page.getByRole('heading', { name: 'Compare', exact: true })).toBeFocused();
  await chord(page.locator('body'), 'g', 'f');
  await expect(page.getByRole('slider', { name: 'Corpus footer position' })).toBeFocused();

  await gotoPlace(page, 'catalog');
  await page.getByRole('button', { name: /Standard Ebooks library/ }).click();
  const filter = page.getByRole('searchbox', { name: 'Filter the Standard Ebooks library' });
  await filter.fill('');
  await filter.pressSequentially('gc]t');
  await expect(filter).toHaveValue('gc]t');
  await expect(page.getByRole('heading', { name: 'Catalog', exact: true })).toBeVisible();
});
