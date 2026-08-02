import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, gotoPlace, openQuickAdd } from './helpers.ts';

async function openResearch(page: Page): Promise<void> {
  await gotoPlace(page, 'findings');
  await expect(page.getByRole('heading', { name: 'Research and project record' }))
    .toBeVisible();
}

async function addTerm(page: Page, term: string): Promise<void> {
  await gotoPlace(page, 'trends');
  const input = await openQuickAdd(page);
  await input.fill(term);
  await input.press('Enter');
  await expect(page.getByRole('button', { name: new RegExp(`^${term} \\d+$`) })).toBeVisible();
}

async function awaitResearchSaved(page: Page): Promise<void> {
  await openResearch(page);
  await expect(page.getByText('research state saved locally')).toBeVisible({
    timeout: 30_000,
  });
}

test('research state survives reload and a source-free link previews before replace', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await addTerm(page, 'Watson');
  await awaitResearchSaved(page);

  await page.reload();
  await awaitAllReady(page);
  await gotoPlace(page, 'trends');
  await expect(page.getByRole('button', { name: /^Watson \d+$/ })).toBeVisible({
    timeout: 30_000,
  });
  await openResearch(page);

  await gotoPlace(page, 'trends');
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  await scrubber.press('ArrowRight');
  await scrubber.press('ArrowRight');
  await scrubber.press('Enter');
  await expect(page.getByText(/Selected 3 tokens in/)).toBeVisible();
  await openResearch(page);
  await page.getByLabel('Saved range name').fill('Opening');
  await page.getByRole('button', { name: 'save range' }).click();
  await expect(page.getByRole('list', { name: 'Saved ranges' }).getByText('Opening')).toBeVisible();
  await gotoPlace(page, 'trends');
  const liveScrubber = page.getByRole('slider', { name: /reading position/i });
  await liveScrubber.press('p');
  await openResearch(page);
  await expect(page.getByRole('region', { name: 'Saved excerpts' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('research changes waiting to save')).toBeVisible();
  await expect(page.getByText('research state saved locally')).toBeVisible({
    timeout: 30_000,
  });

  await page.reload();
  await awaitAllReady(page);
  await openResearch(page);
  await expect(page.getByRole('list', { name: 'Saved ranges' }).getByText('Opening')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('region', { name: 'Saved excerpts' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'preview share link' }).click();
  const share = await page.getByLabel('Share link preview').inputValue();
  expect(share).toContain('#s=');
  expect(share.length).toBeLessThanOrEqual(8_192);
  expect(share).not.toContain('To Sherlock Holmes she is always the woman');

  await gotoPlace(page, 'trends');
  await page.getByRole('button', { name: 'Remove Watson' }).click();
  await expect(page.getByRole('button', { name: /^Watson \d+$/ })).toHaveCount(0);
  await awaitResearchSaved(page);

  // A source-free URL boots into Findings and only prefills review. It does
  // not import or open Evidence until the user explicitly reviews/replaces.
  await page.goto(share);
  await awaitAllReady(page);
  await expect(page).toHaveURL(/[?&]p=findings[^#]*#s=/);
  await expect(page.getByRole('region', { name: 'Findings', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Evidence' })).toHaveCount(0);
  await gotoPlace(page, 'trends');
  await expect(page.getByRole('button', { name: /^Watson \d+$/ })).toHaveCount(0);
  await openResearch(page);
  await expect(page.getByLabel('Share link to import')).toHaveValue(share);
  await page.getByRole('button', { name: 'review shared state' }).click();
  const review = page.getByRole('form', { name: 'Review shared state' });
  await expect(review.getByText('3', { exact: true }).first()).toBeVisible();
  await expect(review).toContainText('notebook groups');
  await expect(review).toContainText('referenced documents');
  await expect(review).toContainText('Replacing keeps your saved excerpts');
  await page.getByRole('button', { name: 'replace with this shared state' }).click();
  await gotoPlace(page, 'trends');
  await expect(page.getByRole('button', { name: /^Watson \d+$/ })).toBeVisible();
});

test('two tabs surface a research conflict and require explicit overwrite', async ({ context, page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await awaitResearchSaved(page);

  const other = await context.newPage();
  await other.goto('./');
  await awaitAllReady(other);
  await awaitResearchSaved(other);

  await addTerm(page, 'Adler');
  await openResearch(page);
  await expect(page.getByText('research changes waiting to save')).toBeVisible();
  await expect(page.getByText('research state saved locally')).toBeVisible({
    timeout: 30_000,
  });

  await addTerm(other, 'Watson');
  await openResearch(other);
  await expect(other.getByText('Research state was edited in another tab.')).toBeVisible({
    timeout: 30_000,
  });
  await other.getByRole('button', { name: 'overwrite with this tab' }).click();
  await expect(other.getByText('research state saved locally')).toBeVisible({
    timeout: 30_000,
  });
});
