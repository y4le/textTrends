import { expect, test } from '@playwright/test';
import { LOCAL_LIBRARY_DB_NAME } from '../src/lib/local-library.ts';
import { awaitAllReady, gotoPlace, openQuickAdd } from './helpers.ts';

test('a failed Settings module leaves navigation and authored work usable', async ({ page }) => {
  await page.route('**/assets/SettingsPane-*.js', (route) => route.abort());
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const failure = page.getByRole('alert', { name: 'Settings unavailable' });
  await expect(failure).toBeVisible();
  await expect(failure.getByRole('button', { name: 'Retry Settings' })).toBeVisible();
  await failure.getByRole('button', { name: 'Close panel' }).click();
  await gotoPlace(page, 'matches');
  await expect(page.getByRole('region', { name: 'Matches', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit term: Holmes' })).toBeVisible();
});

test('a failed dock module does not remove the Inputs surface', async ({ page }) => {
  await page.route('**/assets/QuerySurface-*.js', (route) => route.abort());
  await page.goto('./');
  await expect(page.getByRole('alert', { name: 'Terms unavailable' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Active inputs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try the Sherlock Holmes sample' })).toBeVisible();
});

test('retry recovers a failed region render without reloading the workspace', async ({ page }) => {
  await page.route('**/assets/SettingsPane-*.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'export function SettingsPane(){ if(!globalThis.__regionRecovered)throw new Error("test render failure"); return "Recovered settings"; }',
  }));
  await page.goto('./');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const failure = page.getByRole('alert', { name: 'Settings unavailable' });
  await expect(failure).toBeVisible();
  await page.evaluate(() => Object.assign(globalThis, { __regionRecovered: true }));
  await failure.getByRole('button', { name: 'Retry Settings' }).click();
  await expect(page.locator('body')).toContainText('Recovered settings');
  await expect(page.getByRole('region', { name: 'Active inputs' })).toBeVisible();
});

test('a failed Reader module provides a return to the surviving workbench', async ({ page }) => {
  await page.route('**/assets/ReaderDrawer-*.js', (route) => route.abort());
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'matches');
  await page.getByRole('grid', { name: 'Matches' }).getByRole('button', { name: 'Holmes', exact: true }).first().click();
  const failure = page.getByRole('alert', { name: 'Reader unavailable' });
  await expect(failure).toBeVisible();
  await failure.getByRole('button', { name: 'Return to workbench' }).click();
  await expect(page.getByRole('grid', { name: 'Matches' })).toBeVisible();
});

test('a failed guide registry is announced without an unhandled rejection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/assets/registry-*.js', (route) => route.abort());
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await page.getByRole('complementary', { name: 'Guided tour invitation' }).getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('#guide-live-region')).toContainText('The guide could not load');
  await expect(page.getByRole('navigation', { name: 'Workbench sections' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a failed guide card can be dismissed without losing the workspace', async ({ page }) => {
  await page.route('**/assets/GuideCard-*.js', (route) => route.abort());
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await page.getByRole('complementary', { name: 'Guided tour invitation' }).getByRole('button', { name: 'Start', exact: true }).click();
  const failure = page.getByRole('alert', { name: 'Guide unavailable' });
  await expect(failure).toBeVisible();
  await failure.getByRole('button', { name: 'Exit guide' }).click();
  await expect(page.getByRole('navigation', { name: 'Workbench sections' })).toBeVisible();
  await expect(failure).toHaveCount(0);
});

// Fail the loader before the browser evaluates its module: unlike a permanent
// browser module-map rejection, this reproduces a recoverable preload failure.
test('a successful lazy retry remains usable after closing and reopening', async ({ page }) => {
  let gated = false;
  await page.addInitScript(() => Object.assign(globalThis, { __failSettingsLoad: true }));
  await page.route('**/assets/index-*.js', async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const body = original.replace(/import\((["'`])(\.\/SettingsPane-[^"'`]+\.js)\1\)/g, (expression) => {
      gated = true;
      return `(globalThis.__failSettingsLoad?Promise.reject(new Error("test preload failure")):${expression})`;
    });
    await route.fulfill({ response, body });
  });
  await page.goto('./');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  expect(gated).toBe(true);
  const failure = page.getByRole('alert', { name: 'Settings unavailable' });
  await expect(failure).toBeVisible();
  await page.evaluate(() => Object.assign(globalThis, { __failSettingsLoad: false }));
  await failure.getByRole('button', { name: 'Retry Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'close', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings).toBeVisible();
  await expect(failure).toHaveCount(0);
});

test('a failed save before recovery reload exposes an explicit unsaved reload', async ({ page }) => {
  await page.addInitScript((databaseName) => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      if (this.name === databaseName && args[1] === 'readwrite'
        && (globalThis as unknown as { blockWorkspaceWrites?: boolean }).blockWorkspaceWrites) {
        throw new DOMException('test storage unavailable', 'QuotaExceededError');
      }
      return transaction.apply(this, args);
    };
  }, LOCAL_LIBRARY_DB_NAME);
  await page.route('**/assets/SettingsPane-*.js', (route) => route.abort());
  await page.goto('./');
  await page.evaluate(() => Object.assign(globalThis, { blockWorkspaceWrites: true }));
  const input = await openQuickAdd(page);
  await input.fill('Unsaved term');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const failure = page.getByRole('alert', { name: 'Settings unavailable' });
  await failure.getByRole('button', { name: 'Reload app', exact: true }).click();
  await expect(failure).toContainText('Could not save before reload');
  const reload = failure.getByRole('button', { name: 'Reload without saving', exact: true });
  await expect(reload).toBeEnabled();
  const loaded = page.waitForEvent('load');
  await reload.click();
  await loaded;
  await expect(page.getByRole('region', { name: 'Active inputs' })).toBeVisible();
});
