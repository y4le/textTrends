import { expect, test } from '@playwright/test';
import { LOCAL_LIBRARY_DB_NAME } from '../src/lib/local-library.ts';
import { awaitAllReady, gotoPlace, openQuickAdd, workspaceRecord } from './helpers.ts';

test('workspace save failures remain visible in Trends and Reader and can be retried', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'trends');
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    const host = window as unknown as { restoreWorkspaceWrites: () => void };
    host.restoreWorkspaceWrites = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'workspace') throw new DOMException('Storage quota reached', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  const input = await openQuickAdd(page);
  await input.fill('clue');
  await input.press('Enter');
  const warning = page.getByRole('alert', { name: 'Unsaved workspace' });
  await expect(warning).toContainText('Your changes are not saved.');
  await gotoPlace(page, 'inputs');
  await gotoPlace(page, 'trends');
  await page.getByRole('button', { name: /^read from here/ }).first().click();
  await expect(page.locator('#reader-region')).toBeVisible();
  await expect(warning).toBeVisible();
  await page.evaluate(() => (window as unknown as { restoreWorkspaceWrites: () => void }).restoreWorkspaceWrites());
  await warning.getByRole('button', { name: 'Retry saving' }).click();
  await expect.poll(() => page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const value = await new Promise<{ notebook: { groups: { aliases: string[] }[] } } | undefined>((resolve, reject) => {
        const request = db.transaction('workspace').objectStore('workspace').get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return value?.notebook.groups.some((group) => group.aliases.includes('clue')) ?? false;
    } finally { db.close(); }
  }, LOCAL_LIBRARY_DB_NAME)).toBe(true);
  await expect(warning).toHaveCount(0);
});

test('a rejected lazy page keeps navigation and offers a recovery route', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await page.route('**/ComparePlace-*.js', (route) => route.abort('failed'));
  await gotoPlace(page, 'compare');
  const fallback = page.getByRole('alert', { name: 'View unavailable' });
  await expect(fallback).toBeVisible();
  await expect(fallback.getByRole('button', { name: 'Reload app' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workbench sections' })).toBeVisible();
  await fallback.getByRole('button', { name: 'Return to Inputs' }).click();
  await expect(page.getByRole('region', { name: 'Active inputs' })).toBeVisible();
  await expect(fallback).toHaveCount(0);
  await expect(page.locator('#place-inputs-heading')).toBeFocused();
});


test('hiding the page flushes a workspace edit while the debounce clock is held', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.scope-organ > [role="status"]')).toContainText('No active inputs');
  await gotoPlace(page, 'trends');
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const input = await openQuickAdd(page);
  await input.fill('visibility-clue');
  await input.press('Enter');
  const hasTerm = async () => {
    const record = await workspaceRecord(page) as { notebook?: { groups?: { aliases: string[] }[] } } | undefined;
    return record?.notebook?.groups?.some((group) => group.aliases.includes('visibility-clue')) ?? false;
  };
  expect(await hasTerm()).toBe(false);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(hasTerm).toBe(true);
});
