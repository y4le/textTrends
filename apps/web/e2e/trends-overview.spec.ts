import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  gotoPlace,
  submitAndAwaitFreshResults,
} from './helpers.ts';

test('one term shows Reading Destinations whose passage can open Reader', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'holmes');

  const overview = page.locator('[data-trend-organ="overview"]');
  await expect(overview).toBeVisible();
  await expect(page.getByRole('region', { name: 'Trends overview' })).toBeVisible();
  await expect(overview.locator('.trend-organ-pending')).toHaveText('');
  await expect(overview.getByRole('heading', { name: 'reading destinations', exact: true })).toBeVisible();
  await expect(overview.locator('[data-trend-overview-section="company"]')).toHaveCount(0);
  const cards = overview.locator('.destination-card');
  await expect(cards.first()).toBeVisible();
  await expect(cards.first().locator('.destination-mark').first()).toBeVisible();
  await expect(cards.first().getByRole('button', { name: 'compare passage' })).toHaveCount(0);

  await overview.locator('.destination-card').first()
    .getByRole('button', { name: /^read from here/ }).click();
  await expect(page.getByRole('main', { name: /Reader:/ })).toBeVisible({ timeout: 30_000 });
});

test('multiple terms add Company and pair focus refreshes only Reading Destinations', async ({ page }) => {
  await page.setViewportSize({ width: 710, height: 844 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'holmes, watson');

  const overview = page.locator('[data-trend-organ="overview"]');
  const company = overview.locator('[data-trend-overview-section="company"]');
  const destinations = overview.locator('[data-trend-overview-section="destinations"]');
  await expect(overview.locator('.trend-organ-header')).toHaveCount(0);
  await expect(overview).not.toContainText('company & reading destinations');
  await expect(company).toBeVisible();
  await expect(destinations).toBeVisible();
  const pair = company.locator('.company-pair').first();
  await expect(pair).toBeVisible();
  await expect(pair).toHaveAccessibleName(/Reading Destinations focus:/i);
  await pair.click();
  await expect(pair).toHaveAttribute('aria-pressed', 'true');
  await expect(destinations.getByText(/requiring (?:holmes \+ watson|watson \+ holmes)/i)).toBeVisible();
  await expect(destinations.locator('.destination-card').first()).toBeVisible({ timeout: 30_000 });
  await destinations.getByRole('button', { name: 'show all terms' }).click();
  await expect(pair).toHaveAttribute('aria-pressed', 'false');
  await expect(pair).toBeFocused();
  await expect(destinations.getByText(/ranked passages · occurrence evidence/i)).toBeVisible();
  const width = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    columns: getComputedStyle(document.querySelector('.trend-overview-grid')!).gridTemplateColumns,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);
  expect(width.columns.trim().split(/\s+/)).toHaveLength(1);
});

test('multiple terms without a shared text omit Company without leaving a blank overview', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'holmes, qzxneveroccurs');

  const overview = page.locator('[data-trend-organ="overview"]');
  await expect(overview.locator('.trend-organ-header')).toHaveCount(0);
  await expect(overview).not.toContainText('whole-corpus orientation');
  await expect(overview.locator('[data-trend-overview-section="company"]')).toHaveCount(0);
  await expect(overview.locator('.destination-card').first()).toBeVisible();
  await expect(overview.locator('.destination-mark').first()).toContainText(/holmes/i);
  await expect(overview.locator('.trend-overview-grid')).toHaveAttribute('data-single', 'true');

  await submitAndAwaitFreshResults(page, 'qzxneveroccurs, qzyneveroccurs');
  await expect(overview.locator('[data-trend-overview-section="company"]')).toHaveCount(0);
  await expect(overview.getByText('No passage contains an occurrence of the tracked terms.')).toBeVisible();
});
