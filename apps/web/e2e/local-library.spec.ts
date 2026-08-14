import { expect, test } from '@playwright/test';
import { LOCAL_LIBRARY_DB_NAME } from '../src/lib/local-library.ts';
import { awaitAllReady, awaitReadyCount, DOC_COUNT, gotoPlace } from './helpers.ts';

test('local files persist, drag into the active corpus, reorder, and delete independently', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');

  const localPanel = page.getByRole('region', { name: 'On this device' });
  const activePanel = page.getByRole('region', { name: 'Active files' });
  const saved = page.getByRole('list', { name: 'Files on this device' });
  await expect(saved.getByRole('listitem')).toHaveCount(DOC_COUNT);

  // Native OS-style drop saves files to the device library without replacing
  // the active inputs.
  await localPanel.evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['alpha alpha'], 'alpha.txt', { type: 'text/plain', lastModified: 1 }));
    transfer.items.add(new File(['beta beta'], 'beta.md', { type: 'text/markdown', lastModified: 2 }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(saved.getByRole('listitem')).toHaveCount(DOC_COUNT + 2);
  await expect(activePanel.getByRole('list', { name: 'Documents' }).getByRole('listitem')).toHaveCount(6);

  // A second acquisition of the same format + bytes reuses the saved record.
  await localPanel.evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['alpha alpha'], 'another-alpha.txt', { type: 'text/plain' }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(saved.getByRole('listitem')).toHaveCount(DOC_COUNT + 2);
  await expect(localPanel.getByRole('status')).toContainText('already saved');

  // A saved-file drag appends to the same ordinary corpus; a second is refused.
  await saved.getByRole('listitem').filter({ hasText: 'alpha.txt' }).dragTo(activePanel);
  await awaitReadyCount(page, DOC_COUNT + 1);
  await saved.getByRole('listitem').filter({ hasText: 'alpha.txt' }).dragTo(activePanel);
  await expect(activePanel.getByRole('list', { name: 'Documents' }).getByRole('listitem')).toHaveCount(DOC_COUNT + 1);
  await expect(localPanel.getByRole('status')).toContainText('already active');
  await saved.getByRole('listitem').filter({ hasText: 'beta.md' }).dragTo(activePanel);
  await awaitReadyCount(page, DOC_COUNT + 2);

  const active = activePanel.getByRole('list', { name: 'Documents' });
  await expect(active.getByRole('listitem').nth(DOC_COUNT)).toContainText('alpha');
  await expect(active.getByRole('listitem').nth(DOC_COUNT + 1)).toContainText('beta');

  // Dragging an active row onto another inserts it before that row.
  await active.getByRole('listitem').nth(DOC_COUNT + 1).dragTo(active.getByRole('listitem').nth(DOC_COUNT));
  await expect(active.getByRole('listitem').nth(DOC_COUNT)).toContainText('beta');
  await expect(active.getByRole('listitem').nth(DOC_COUNT + 1)).toContainText('alpha');

  // Removing from the corpus leaves the reusable device copy intact.
  await active.getByRole('button', { name: 'Remove beta from active corpus' }).click();
  await awaitReadyCount(page, DOC_COUNT + 1);
  await expect(saved.getByRole('listitem')).toHaveCount(DOC_COUNT + 2);
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
      return (workspace as { corpus?: { order?: readonly string[] } } | undefined)?.corpus?.order?.length ?? 0;
    } finally {
      database.close();
    }
  }, LOCAL_LIBRARY_DB_NAME)).toBe(DOC_COUNT + 1);

  // The library is durable across a new app session.
  await page.reload();
  await awaitReadyCount(page, DOC_COUNT + 1);
  await gotoPlace(page, 'inputs');
  const reopened = page.getByRole('list', { name: 'Files on this device' });
  await expect(reopened.getByRole('listitem')).toHaveCount(DOC_COUNT + 2);

  await reopened.getByRole('button', { name: 'Delete alpha.txt from this device' }).click();
  await expect(reopened.getByRole('listitem')).toHaveCount(DOC_COUNT + 1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete all' }).click();
  await expect(reopened.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByText('No saved files yet.')).toBeVisible();
});

test('removing the last input settles the corpus and gives analysis places a focused way back', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByText('No active inputs. Nothing is being analyzed.', { exact: true })).toBeVisible();

  const activePanel = page.getByRole('region', { name: 'Active files' });
  await activePanel.evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['one small text'], 'only.txt', { type: 'text/plain' }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await awaitReadyCount(page, 1);

  await activePanel.getByRole('button', { name: 'Remove only from active corpus' }).click();
  await expect(page.getByText('nothing is being analyzed', { exact: true })).toBeVisible();
  await expect(activePanel.getByText('No active inputs. Nothing is being analyzed.', { exact: true })).toBeVisible();

  await gotoPlace(page, 'trends');
  const emptyPlace = page.getByRole('region', { name: 'No active inputs' });
  await expect(emptyPlace).toContainText('Nothing is being analyzed.');
  await emptyPlace.getByRole('button', { name: 'Open Inputs' }).click();
  await expect(page.locator('#place-inputs-heading')).toBeFocused();
  await expect(page).toHaveURL(/[?&]p=inputs(?:&|#|$)/);
});
