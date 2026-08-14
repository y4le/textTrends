import { expect, test } from '@playwright/test';
import { LOCAL_LIBRARY_DB_NAME } from '../src/lib/local-library.ts';
import { awaitAllReady, awaitReadyCount, DOC_COUNT, gotoPlace } from './helpers.ts';

test('local files persist, join active inputs, reorder accessibly, and delete independently', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');

  const cards = page.locator('.input-card-grid > .input-card');
  await expect(cards).toHaveCount(4);
  await expect(cards.locator(':scope > h4, :scope > .input-card-heading-row > h4')).toHaveText([
    'Active inputs',
    'Local library',
    'Load from Standard Ebooks',
    'Load demo',
  ]);
  const addFiles = page.getByLabel('Add files');
  await addFiles.focus();
  await expect(addFiles).toBeFocused();
  await expect(addFiles.locator('..')).toHaveCSS('outline-style', 'solid');

  const localPanel = page.getByRole('region', { name: 'Local library' });
  const activePanel = page.getByRole('region', { name: 'Active inputs' });
  const saved = page.getByRole('list', { name: 'Saved texts' });
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
  await expect(activePanel.getByRole('list', { name: 'Active input order' }).getByRole('listitem')).toHaveCount(6);

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
  await expect(activePanel.getByRole('list', { name: 'Active input order' }).getByRole('listitem')).toHaveCount(DOC_COUNT + 1);
  await expect(localPanel.getByRole('status')).toContainText('already active');
  await saved.getByRole('listitem').filter({ hasText: 'beta.md' }).dragTo(activePanel);
  await awaitReadyCount(page, DOC_COUNT + 2);

  const active = activePanel.getByRole('list', { name: 'Active input order' });
  await expect(active.getByRole('listitem').nth(DOC_COUNT)).toContainText('alpha');
  await expect(active.getByRole('listitem').nth(DOC_COUNT + 1)).toContainText('beta');

  // Dragging an active row onto another inserts it before that row.
  await active.getByRole('listitem').nth(DOC_COUNT + 1).dragTo(active.getByRole('listitem').nth(DOC_COUNT));
  await expect(active.getByRole('listitem').nth(DOC_COUNT)).toContainText('beta');
  await expect(active.getByRole('listitem').nth(DOC_COUNT + 1)).toContainText('alpha');

  // The same ordering action is fully keyboard-operable and announced.
  const moveAlphaUp = active.getByRole('button', { name: 'Move alpha up' });
  await moveAlphaUp.press('Enter');
  await expect(moveAlphaUp).toBeFocused();
  await expect(active.getByRole('listitem').nth(DOC_COUNT)).toContainText('alpha');
  await expect(active.getByRole('listitem').nth(DOC_COUNT + 1)).toContainText('beta');
  await expect(activePanel.getByRole('status')).toHaveText(`alpha moved to position ${DOC_COUNT + 1} of ${DOC_COUNT + 2}.`);
  for (let position = DOC_COUNT; position > 0; position -= 1) await moveAlphaUp.click();
  await expect(active.getByRole('listitem').first()).toContainText('alpha');
  await expect(moveAlphaUp).toBeFocused();
  await expect(moveAlphaUp).toHaveAttribute('aria-disabled', 'true');
  await moveAlphaUp.press('Enter');
  await expect(moveAlphaUp).toBeFocused();
  await expect(activePanel.getByRole('status')).toHaveText('alpha is already first.');
  await expect(active.getByRole('button', { name: 'Move beta down' })).toHaveAttribute('aria-disabled', 'true');

  // Removing from the corpus leaves the reusable device copy intact.
  await active.getByRole('button', { name: 'Remove beta from active inputs' }).click();
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
  const reopened = page.getByRole('list', { name: 'Saved texts' });
  await expect(reopened.getByRole('listitem')).toHaveCount(DOC_COUNT + 2);

  await reopened.getByRole('button', { name: 'Delete alpha.txt from local library' }).click();
  await expect(reopened.getByRole('listitem')).toHaveCount(DOC_COUNT + 1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete all' }).click();
  await expect(reopened.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByText('No saved texts yet.')).toBeVisible();
});

test('removing the last input settles the corpus and gives analysis places a focused way back', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByText('No active inputs. Nothing is being analyzed.', { exact: true })).toBeVisible();

  const activePanel = page.getByRole('region', { name: 'Active inputs' });
  await activePanel.evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['one small text'], 'only.txt', { type: 'text/plain' }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await awaitReadyCount(page, 1);

  await activePanel.getByRole('button', { name: 'Remove only from active inputs' }).click();
  await expect(page.getByText('nothing is being analyzed', { exact: true })).toBeVisible();
  await expect(activePanel.getByText('No active inputs. Nothing is being analyzed.', { exact: true })).toBeVisible();

  await gotoPlace(page, 'trends');
  const emptyPlace = page.getByRole('region', { name: 'No active inputs' });
  await expect(emptyPlace).toContainText('Nothing is being analyzed.');
  await emptyPlace.getByRole('button', { name: 'Open Inputs' }).click();
  await expect(page.locator('#place-inputs-heading')).toBeFocused();
  await expect(page).toHaveURL(/[?&]p=inputs(?:&|#|$)/);
});
