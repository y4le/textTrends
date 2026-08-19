import { expect, test } from '@playwright/test';
import {
  MATCHES_COLUMN_STORAGE_KEY,
} from '../src/lib/matches-column-storage.ts';
import {
  VOCABULARY_COLUMN_STORAGE_KEY,
} from '../src/lib/vocabulary-column-storage.ts';
import { awaitReadyCount, openQuickAdd } from './helpers.ts';

test('cache clear preserves research state while full reset removes app-owned browser data', async ({ page }) => {
  await page.goto('./');
  const active = page.getByRole('region', { name: 'Active inputs' });
  await active.evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['debug reset fixture'], 'debug-reset.txt', { type: 'text/plain' }));
    target.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  });
  await awaitReadyCount(page, 1);
  const term = await openQuickAdd(page);
  await term.fill('Reset term');
  await term.press('Enter');
  await page.getByRole('dialog', { name: 'Manage terms' }).getByRole('button', { name: 'Done' }).click();
  // Clear immediately, while the debounced workspace save is still dirty. The
  // recovery action itself owns the durability barrier before teardown.
  await page.evaluate(({ matchesKey, vocabularyKey }) => {
    sessionStorage.setItem(matchesKey, '{}');
    sessionStorage.setItem(vocabularyKey, '{}');
    sessionStorage.setItem('unrelated-owner-key', 'keep');
  }, {
    matchesKey: MATCHES_COLUMN_STORAGE_KEY,
    vocabularyKey: VOCABULARY_COLUMN_STORAGE_KEY,
  });

  await page.keyboard.press('Shift+D');
  let debug = page.getByRole('dialog', { name: 'Debug' });
  page.once('dialog', (dialog) => dialog.accept());
  const cacheReloaded = page.waitForEvent('load');
  await debug.getByRole('button', { name: 'Clear cache' }).click();
  await cacheReloaded;
  await awaitReadyCount(page, 1);
  await expect(page.getByRole('button', { name: 'Edit term: Reset term' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Local library' })
    .getByRole('list', { name: 'Saved texts' }).getByRole('listitem')).toHaveCount(1);
  await expect.poll(() => page.evaluate(({ matchesKey, vocabularyKey }) => [
    sessionStorage.getItem(matchesKey),
    sessionStorage.getItem(vocabularyKey),
    sessionStorage.getItem('unrelated-owner-key'),
  ], {
    matchesKey: MATCHES_COLUMN_STORAGE_KEY,
    vocabularyKey: VOCABULARY_COLUMN_STORAGE_KEY,
  })).toEqual(['{}', '{}', 'keep']);

  await page.keyboard.press('Shift+D');
  debug = page.getByRole('dialog', { name: 'Debug' });
  let confirmations = 0;
  const acceptReset = async (dialog: import('@playwright/test').Dialog) => {
    confirmations++;
    await dialog.accept();
  };
  page.on('dialog', acceptReset);
  const resetReloaded = page.waitForEvent('load');
  await debug.getByRole('button', { name: 'Full reset' }).click();
  await resetReloaded;
  page.off('dialog', acceptReset);

  expect(confirmations).toBe(2);
  await expect(page.getByText('No active inputs. Nothing is being analyzed.', { exact: true })).toBeVisible();
  await expect(page.getByText('No saved texts yet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit term: Reset term' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(({ matchesKey, vocabularyKey }) => [
    sessionStorage.getItem(matchesKey),
    sessionStorage.getItem(vocabularyKey),
    sessionStorage.getItem('unrelated-owner-key'),
  ], {
    matchesKey: MATCHES_COLUMN_STORAGE_KEY,
    vocabularyKey: VOCABULARY_COLUMN_STORAGE_KEY,
  })).toEqual([null, null, 'keep']);
});
