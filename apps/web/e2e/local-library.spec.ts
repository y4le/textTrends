import { expect, test, type Locator } from '@playwright/test';
import { LOCAL_LIBRARY_DB_NAME } from '../src/lib/local-library.ts';
import { awaitAllReady, awaitReadyCount, DOC_COUNT, gotoPlace, openQuickAdd } from './helpers.ts';

async function dragSavedText(source: Locator, target: Locator): Promise<void> {
  const targetHandle = await target.elementHandle();
  if (targetHandle === null) throw new Error('active input drop target is unavailable');
  try {
    await source.evaluate((node, dropTarget) => {
      const transfer = new DataTransfer();
      node.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      dropTarget.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, targetHandle);
  } finally {
    await targetHandle.dispose();
  }
}

test('empty Inputs foregrounds local import and collapses acquisition around active work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./?fresh=1');

  const active = page.getByRole('region', { name: 'Active inputs' });
  const acquisition = page.getByRole('region', { name: 'Add texts' });
  const acquisitionToggle = acquisition.getByRole('button', { name: 'Hide options' });
  await expect(acquisitionToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(acquisition.getByText('Import and analyze', { exact: true })).toBeVisible();
  const trust = acquisition.getByText('Processed in your browser · never uploaded.', { exact: true });
  await expect(trust).toBeVisible();
  expect((await trust.boundingBox())?.y).toBeLessThan(844);

  const catalogToggle = acquisition.getByRole('button', { name: /Browse Standard Ebooks/ });
  await expect(catalogToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('list', { name: 'Popular Standard Ebooks' }).getByRole('listitem'))
    .toHaveCount(20);

  await page.getByLabel('Add files — import and analyze').setInputFiles({
    name: 'primary.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('primary local text'),
  });
  await awaitReadyCount(page, 1);
  const collapsedToggle = acquisition.getByRole('button', { name: 'Show options' });
  await expect(collapsedToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(collapsedToggle).toBeFocused();
  await expect(acquisition.locator('#input-acquisition-options')).toHaveCount(0);
  expect((await active.getByRole('heading', { name: 'Active inputs' }).boundingBox())?.y).toBeLessThan(844);

  await collapsedToggle.click();
  await expect(acquisition.getByRole('button', { name: /Browse Standard Ebooks/ }))
    .toHaveAttribute('aria-expanded', 'false');
  const saveFiles = page.getByLabel('Save files to library');
  await expect(saveFiles).toBeVisible();
  await saveFiles.setInputFiles({
    name: 'saved-for-later.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('save this without analysing it'),
  });
  await expect(page.getByRole('list', { name: 'Saved texts' })).toContainText('saved-for-later.txt');
  await expect(active.getByRole('list', { name: 'Active input order' }).getByRole('listitem')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('local files persist, join active inputs, reorder accessibly, and delete independently', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');

  const cards = page.locator('.input-card-grid > .input-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.locator(':scope > h4, :scope > .input-card-heading-row > h4')).toHaveText([
    'Active inputs',
    'Add texts',
    'Local library',
  ]);
  const saveFiles = page.getByLabel('Save files to library');
  await saveFiles.focus();
  await expect(saveFiles).toBeFocused();
  await expect(saveFiles.locator('..')).toHaveCSS('outline-style', 'solid');

  const localPanel = page.getByRole('region', { name: 'Local library' });
  const activePanel = page.getByRole('region', { name: 'Active inputs' });
  // The synthetic pointer scroll needed to span these two long cards is
  // browser-dependent; dispatch native drag events while retaining the real
  // row's dragstart handler and the active card's drop handler.
  const activeDropTarget = activePanel;
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
  await expect(activePanel.getByRole('list', { name: 'Active input order' }).getByRole('listitem')).toHaveCount(DOC_COUNT);

  // A second acquisition of the same format + bytes reuses the saved record.
  await localPanel.evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['alpha alpha'], 'another-alpha.txt', { type: 'text/plain' }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(saved.getByRole('listitem')).toHaveCount(DOC_COUNT + 2);
  await expect(localPanel.getByRole('status')).toContainText('already saved');

  // A saved-file drag appends to the same ordinary corpus; a second is refused.
  await dragSavedText(saved.getByRole('listitem').filter({ hasText: 'alpha.txt' }), activeDropTarget);
  await expect(activePanel.getByRole('list', { name: 'Active input order' }).getByRole('listitem'))
    .toHaveCount(DOC_COUNT + 1);
  await awaitReadyCount(page, DOC_COUNT + 1);
  await dragSavedText(saved.getByRole('listitem').filter({ hasText: 'alpha.txt' }), activeDropTarget);
  await expect(activePanel.getByRole('list', { name: 'Active input order' }).getByRole('listitem')).toHaveCount(DOC_COUNT + 1);
  await expect(localPanel.getByRole('status')).toContainText('already active');
  await dragSavedText(saved.getByRole('listitem').filter({ hasText: 'beta.md' }), activeDropTarget);
  await expect(activePanel.getByRole('list', { name: 'Active input order' }).getByRole('listitem'))
    .toHaveCount(DOC_COUNT + 2);
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
  await expect(activePanel.locator(':scope > [role="status"]'))
    .toHaveText(`alpha moved to position ${DOC_COUNT + 1} of ${DOC_COUNT + 2}.`);
  for (let position = DOC_COUNT; position > 0; position -= 1) await moveAlphaUp.click();
  await expect(active.getByRole('listitem').first()).toContainText('alpha');
  await expect(moveAlphaUp).toBeFocused();
  await expect(moveAlphaUp).toHaveAttribute('aria-disabled', 'true');
  await moveAlphaUp.press('Enter');
  await expect(moveAlphaUp).toBeFocused();
  await expect(activePanel.locator(':scope > [role="status"]'))
    .toHaveText('alpha is already first.');
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

test('a large local library scrolls and filters filenames with regular expressions', async ({ page }) => {
  await page.goto('./');
  const local = page.getByRole('region', { name: 'Local library' });
  const names = Array.from({ length: 30 }, (_, index) =>
    `chapter-${index.toString().padStart(2, '0')}.${index % 2 === 0 ? 'txt' : 'md'}`);
  await local.evaluate((target, filenames) => {
    const transfer = new DataTransfer();
    for (const name of filenames) {
      transfer.items.add(new File([`contents of ${name}`], name, { type: 'text/plain' }));
    }
    target.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, names);

  const saved = local.getByRole('list', { name: 'Saved texts' });
  await expect(saved.getByRole('listitem')).toHaveCount(30);
  const results = local.getByRole('region', { name: 'Saved text results' });
  await expect(results).toHaveCSS('overflow-y', 'auto');
  expect(await results.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await results.focus();
  await expect(results).toBeFocused();

  const filter = local.getByRole('searchbox', { name: 'Filter saved texts by filename' });
  await filter.fill('^chapter-(0[37]|1[24])\\.(txt|md)$');
  await expect(saved.getByRole('listitem')).toHaveCount(4);
  await expect(local.locator('#local-library-filter-status')).toHaveText('4 of 30 saved texts shown.');

  await filter.fill('[');
  await expect(filter).toHaveAttribute('aria-invalid', 'true');
  await expect(saved.getByRole('listitem')).toHaveCount(30);
  await expect(local.locator('#local-library-filter-status'))
    .toHaveText('Invalid regular expression; showing all 30 saved texts.');

  await filter.fill('^missing-file$');
  await expect(saved.getByRole('listitem')).toHaveCount(0);
  await expect(local.getByText('No saved texts match this regular expression.', { exact: true })).toBeVisible();
  await local.getByRole('button', { name: 'Clear library filter' }).click();
  await expect(saved.getByRole('listitem')).toHaveCount(30);
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
  await expect(page.locator('.scope-organ > [role="status"]')).toContainText('nothing is being analyzed');
  await expect(activePanel.getByText('No active inputs. Nothing is being analyzed.', { exact: true })).toBeVisible();

  await gotoPlace(page, 'trends');
  const emptyPlace = page.getByRole('region', { name: 'No active inputs' });
  await expect(emptyPlace).toContainText('Nothing is being analyzed.');
  await emptyPlace.getByRole('button', { name: 'Open Inputs' }).click();
  await expect(page.locator('#place-inputs-heading')).toBeFocused();
  await expect(page).toHaveURL(/[?&]p=inputs(?:&|#|$)/);
});

test('Clear all confirms one reset, keeps saved texts, and leaves demos additive', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');

  const active = page.getByRole('region', { name: 'Active inputs' });
  const order = active.getByRole('list', { name: 'Active input order' }).getByRole('listitem');
  const clear = active.getByRole('button', { name: 'Clear all active inputs and terms' });
  const local = page.getByRole('region', { name: 'Local library' });
  const saved = local.getByRole('list', { name: 'Saved texts' }).getByRole('listitem');
  await expect(order).toHaveCount(DOC_COUNT);
  await expect(page.locator('.term-bar .term-bucket')).toHaveCount(3);
  await expect(saved).toHaveCount(DOC_COUNT);

  let dismissedMessage = '';
  page.once('dialog', async (dialog) => {
    dismissedMessage = dialog.message();
    await dialog.dismiss();
  });
  await clear.click();
  expect(dismissedMessage).toBe(`Clear ${DOC_COUNT} active texts and 3 terms?\n\nSaved texts will remain in the local library.`);
  await expect(clear).toBeFocused();
  await expect(order).toHaveCount(DOC_COUNT);
  await expect(page.locator('.term-bar .term-bucket')).toHaveCount(3);

  page.once('dialog', (dialog) => dialog.accept());
  await clear.click();
  await expect(active.getByText('No active inputs. Nothing is being analyzed.', { exact: true })).toBeVisible();
  await expect(page.locator('.term-bar .term-bucket')).toHaveCount(0);
  await expect(saved).toHaveCount(DOC_COUNT);
  await expect(clear).toHaveAttribute('aria-disabled', 'true');
  await expect(clear).toBeFocused();
  await expect(active.locator(':scope > [role="status"]')).toHaveText(
    `${DOC_COUNT} active texts and 3 terms cleared. Saved texts remain in the local library.`,
  );

  await expect.poll(() => page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ texts: number; terms: number }>((resolve, reject) => {
        const request = database.transaction('workspace', 'readonly').objectStore('workspace').get('current');
        request.onsuccess = () => {
          const workspace = request.result as {
            corpus?: { order?: readonly string[] };
            notebook?: { groups?: readonly unknown[] };
          } | undefined;
          resolve({
            texts: workspace?.corpus?.order?.length ?? -1,
            terms: workspace?.notebook?.groups?.length ?? -1,
          });
        };
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, LOCAL_LIBRARY_DB_NAME), { timeout: 10_000 }).toEqual({ texts: 0, terms: 0 });

  await page.reload();
  await expect(page.getByText('No active inputs. Nothing is being analyzed.', { exact: true })).toBeVisible();
  await expect(page.locator('.term-bar .term-bucket')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Saved texts' }).getByRole('listitem')).toHaveCount(DOC_COUNT);

  const authored = await openQuickAdd(page);
  await authored.fill('Reader term');
  await authored.press('Enter');
  await page.getByRole('button', { name: 'Activate saved Sherlock texts' }).click();
  await awaitReadyCount(page, DOC_COUNT);
  await expect(page.getByRole('button', { name: 'Edit term: Reader term' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit term: Holmes' })).toBeVisible();
});
