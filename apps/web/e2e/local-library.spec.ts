import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, gotoPlace } from './helpers.ts';

test('local files persist, drag into the active corpus, reorder, and delete independently', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');

  const localPanel = page.getByRole('region', { name: 'On this device' });
  const activePanel = page.getByRole('region', { name: 'Active files' });
  await expect(localPanel.getByText('No saved files yet.')).toBeVisible();

  // Native OS-style drop saves files to the device library without replacing
  // the active demo corpus.
  await localPanel.evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['alpha alpha'], 'alpha.txt', { type: 'text/plain', lastModified: 1 }));
    transfer.items.add(new File(['beta beta'], 'beta.md', { type: 'text/markdown', lastModified: 2 }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  const saved = page.getByRole('list', { name: 'Files on this device' });
  await expect(saved.getByRole('listitem')).toHaveCount(2);
  await expect(activePanel.getByRole('list', { name: 'Documents' }).getByRole('listitem')).toHaveCount(6);

  // A saved-file drag activates a fresh user corpus; a second drag appends.
  await saved.getByRole('listitem').filter({ hasText: 'alpha.txt' }).dragTo(activePanel);
  await awaitReadyCount(page, 1);
  await saved.getByRole('listitem').filter({ hasText: 'beta.md' }).dragTo(activePanel);
  await awaitReadyCount(page, 2);

  const active = activePanel.getByRole('list', { name: 'Documents' });
  await expect(active.getByRole('listitem').nth(0)).toContainText('alpha');
  await expect(active.getByRole('listitem').nth(1)).toContainText('beta');

  // Dragging an active row onto another inserts it before that row.
  await active.getByRole('listitem').nth(1).dragTo(active.getByRole('listitem').nth(0));
  await expect(active.getByRole('listitem').nth(0)).toContainText('beta');
  await expect(active.getByRole('listitem').nth(1)).toContainText('alpha');

  // Removing from the corpus leaves the reusable device copy intact.
  await active.getByRole('button', { name: 'Remove beta from active corpus' }).click();
  await awaitReadyCount(page, 1);
  await expect(saved.getByRole('listitem')).toHaveCount(2);

  // The library is durable across a new app session.
  await page.reload();
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');
  const reopened = page.getByRole('list', { name: 'Files on this device' });
  await expect(reopened.getByRole('listitem')).toHaveCount(2);

  await reopened.getByRole('button', { name: 'Delete alpha.txt from this device' }).click();
  await expect(reopened.getByRole('listitem')).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete all' }).click();
  await expect(reopened.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByText('No saved files yet.')).toBeVisible();
});
