import { expect, test } from '@playwright/test';
import { LOCAL_LIBRARY_DB_NAME } from '../src/lib/local-library.ts';
import { ASOIF, LOTR, SHERLOCK } from '../src/lib/project.ts';
import { workspaceState } from '../test/support/workspace-fixtures.ts';
import { awaitReadyCount, openQuickAdd, trackCorpusRequests } from './helpers.ts';

test('demos load as additive local texts and merge useful starter terms', async ({ page }) => {
  const requests = trackCorpusRequests(page);
  await page.goto('./');
  await expect(page.getByText('No active inputs. Nothing is being analyzed.', { exact: true })).toBeVisible();
  const term = await openQuickAdd(page);
  await term.fill('Reader term');
  await term.press('Enter');
  await page.getByRole('dialog', { name: 'Manage terms' }).getByRole('button', { name: 'Done' }).click();

  const beforeAsoif = requests.length;
  await page.getByRole('button', { name: 'Load A Song of Ice and Fire demo' }).click();
  await awaitReadyCount(page, ASOIF.length);
  await expect(page.getByRole('region', { name: 'Corpus status' })).toContainText('Library corpus');
  await expect(page.getByRole('button', { name: 'A Game of Thrones', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit term: Reader term' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit term: Jon' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit term: Tyrion' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit term: Daenerys' })).toBeVisible();
  const asoifFiles = requests
    .slice(beforeAsoif)
    .filter((url) => new URL(url).pathname.includes('/corpora/asoif/'))
    .map((url) => decodeURIComponent(new URL(url).pathname.split('/').at(-1)!))
    .sort();
  expect(asoifFiles).toEqual(ASOIF.map(({ doc }) => `${doc}.txt`).sort());

  const beforeLotr = requests.length;
  await page.getByRole('button', { name: 'Load The Lord of the Rings demo' }).click();
  await awaitReadyCount(page, ASOIF.length + LOTR.length);
  await expect(page.getByRole('button', { name: 'The Fellowship of the Ring', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit term: Frodo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit term: Gandalf' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit term: Sauron' })).toBeVisible();
  const lotrFiles = requests
    .slice(beforeLotr)
    .filter((url) => new URL(url).pathname.includes('/corpora/lotr/'))
    .map((url) => decodeURIComponent(new URL(url).pathname.split('/').at(-1)!))
    .sort();
  expect(lotrFiles).toEqual(LOTR.map(({ doc }) => `${doc}.txt`).sort());

  const active = page.getByRole('region', { name: 'Active inputs' });
  await expect(active.getByRole('list', { name: 'Active input order' }).getByRole('listitem'))
    .toHaveCount(ASOIF.length + LOTR.length);
  const local = page.getByRole('region', { name: 'Local library' });
  await expect(local.getByRole('list', { name: 'Saved texts' }).getByRole('listitem'))
    .toHaveCount(ASOIF.length + LOTR.length);

  await page.getByRole('link', { name: 'Compare', exact: true }).click();
  await expect(page.getByLabel('Left comparison input').locator('option:checked'))
    .toHaveText('The Fellowship of the Ring');
  await expect(page.getByLabel('Right comparison input').locator('option:checked'))
    .toContainText('All other texts');
});

test('demo acquisition owns the library lane from fetch through activation', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/corpora/sherlock/**', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('./');
  const term = await openQuickAdd(page);
  await term.fill('Reader term');
  await term.press('Enter');
  await page.getByRole('dialog', { name: 'Manage terms' }).getByRole('button', { name: 'Done' }).click();
  const local = page.getByRole('region', { name: 'Local library' });
  await local.evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['saved only'], 'saved.txt', { type: 'text/plain' }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(local.getByRole('listitem')).toHaveCount(1);

  await page.getByRole('button', { name: 'Load Sherlock Holmes demo' }).click();
  await expect(page.getByText('Loading Sherlock Holmes demo…', { exact: true })).toBeVisible();
  const active = page.getByRole('region', { name: 'Active inputs' });
  const clear = active.getByRole('button', { name: 'Clear all terms' });
  await expect(clear).toHaveAttribute('aria-disabled', 'true');
  // A stale queued activation can reach the handler after the lease changes;
  // exercise that defensive guard without overriding the user's inert control.
  await clear.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(active.getByRole('status')).toContainText('Another input is being saved');
  await expect(page.getByRole('button', { name: 'Edit term: Reader term' })).toBeVisible();
  await expect(local.getByRole('button', { name: 'Delete all' })).toBeDisabled();
  await expect(page.getByLabel('Add files')).toBeDisabled();
  await local.evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['raced'], 'raced.txt', { type: 'text/plain' }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(local.getByRole('status')).toContainText('Another input is being saved');
  await expect(local.getByRole('listitem')).toHaveCount(1);
  release();

  await awaitReadyCount(page, SHERLOCK.length);
  await expect(local.getByRole('listitem')).toHaveCount(SHERLOCK.length + 1);
});

test('legacy demo migration preserves research state and retries transient failure', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByText('No active inputs. Nothing is being analyzed.', { exact: true })).toBeVisible();
  const legacy = workspaceState({
    notebook: {
      schema: 'texttrends/query-notebook/3',
      groups: [{
        id: 'irene',
        aliases: ['Irene'],
        exactMatch: false,
        countOverlaps: false,
        style: { color: 'blue', line: 'solid' },
      }],
    },
    active: ['irene'],
    kwicEnabled: ['irene'],
  });
  await page.evaluate(async ({ databaseName, workspace }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const request = database.transaction('workspace', 'readwrite').objectStore('workspace').put(workspace, 'current');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, { databaseName: LOCAL_LIBRARY_DB_NAME, workspace: legacy });

  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  await page.route('**/corpora/sherlock/**', async (route) => {
    await failureGate;
    await route.fulfill({ status: 503 });
  });
  await page.reload();
  // Migration runs after attachment: preserved research state and the Inputs
  // surface remain usable while the legacy download is still outstanding.
  await expect(page.getByRole('button', { name: 'Edit term: Irene' })).toBeVisible();
  await expect(page.getByText(/Migrating the saved Sherlock Holmes demo/i)).toBeVisible();
  await expect(page.getByLabel('Add files')).toBeDisabled();
  releaseFailure();
  await expect(page.getByText(/could not be migrated/i)).toBeVisible();
  expect(await page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const workspace = await new Promise<unknown>((resolve, reject) => {
        const request = database.transaction('workspace', 'readonly').objectStore('workspace').get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return (workspace as { corpus?: { kind?: string } } | undefined)?.corpus?.kind;
    } finally {
      database.close();
    }
  }, LOCAL_LIBRARY_DB_NAME)).toBe('builtin');

  await page.unroute('**/corpora/sherlock/**');
  await page.reload();
  await awaitReadyCount(page, SHERLOCK.length);
  await expect(page.getByRole('button', { name: 'Edit term: Irene' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit term: Holmes' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const workspace = await new Promise<unknown>((resolve, reject) => {
        const request = database.transaction('workspace', 'readonly').objectStore('workspace').get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return (workspace as { corpus?: { kind?: string } } | undefined)?.corpus?.kind;
    } finally {
      database.close();
    }
  }, LOCAL_LIBRARY_DB_NAME)).toBe('library');
});
