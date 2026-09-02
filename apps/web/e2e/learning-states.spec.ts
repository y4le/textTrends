import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  gotoPlace,
} from './helpers.ts';

test('names the next step in empty Inputs and empty Trends', async ({ page }) => {
  await page.goto('./?fresh=1&p=inputs');
  await expect(page.getByText('No active inputs. Nothing is being analyzed.', { exact: true }))
    .toBeVisible();
  await expect(page.getByText('Add a text, then track a term.', { exact: true })).toBeVisible();

  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'trends');
  const shown = page.locator('.term-bucket-toggle[aria-pressed="true"]');
  expect(await shown.count()).toBeGreaterThan(0);
  while ((await shown.count()) > 0) await shown.first().click();
  await expect(page.locator('.term-bucket-toggle')).not.toHaveCount(0);
  const empty = page.getByRole('region', { name: 'Start with a term' });
  await expect(empty).toContainText(
    'Trends follows the terms shown in your notebook across the active texts.',
  );
  await empty.getByRole('button', { name: 'Track a term' }).click();
  const entry = page.getByRole('textbox', { name: 'New term' });
  await expect(entry).toBeFocused();
  await empty.getByRole('button', { name: 'Track a term' }).click();
  await expect(entry).toBeFocused();
});

test('explains exact marks and density bands beside the reading strip legend', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'trends');
  const method = page.getByRole('button', { name: 'About reading strip evidence' });
  await expect(method).toBeVisible();
  await method.click();
  await expect(page.getByRole('tooltip')).toHaveText(
    'An exact mark identifies one reference and can open it. '
      + 'A density band summarizes how many references fall in a span; '
      + 'it can open only a position, not a chosen reference.',
  );
});
