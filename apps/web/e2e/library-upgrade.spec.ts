import { expect, test } from '@playwright/test';
import { LOCAL_LIBRARY_DB_NAME } from '../src/lib/local-library.ts';
import { workspaceState } from '../test/support/workspace-fixtures.ts';
import { awaitReadyCount, gotoPlace } from './helpers.ts';

test('upgrades a real v1 library without losing saved source bytes or workspace references', async ({ page }) => {
  await page.route('**/upgrade-fixture', (route) => route.fulfill({ contentType: 'text/html', body: '<html><body>Storage fixture</body></html>' }));
  await page.goto('./upgrade-fixture');
  const saved = await page.evaluate(async ({ name, workspace }) => {
    const bytes = new TextEncoder().encode('Original saved prose survives the library upgrade.');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
    const id = `txt:${hash}`;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const files = request.result.createObjectStore('files', { keyPath: 'id' });
        files.createIndex('addedAt', 'addedAt');
        files.put({ schema: 'texttrends/library-file/1', id, name: 'saved.txt', format: 'txt',
          contentHash: hash, type: 'text/plain', size: bytes.length, addedAt: 1, lastModified: 1, bytes: bytes.buffer });
        request.result.createObjectStore('workspace').put({ ...workspace, corpus: {
          kind: 'library', order: ['saved-doc'], docs: [{ doc: 'saved-doc', library: id, meta: { title: 'Saved', language: 'en', tags: [] } }],
        } }, 'current');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return { id, bytes: [...bytes] };
  }, { name: LOCAL_LIBRARY_DB_NAME, workspace: workspaceState() });
  await page.goto('./');
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'inputs');
  await expect(page.getByLabel('Saved texts').getByText('saved.txt')).toBeVisible();
  const result = await page.evaluate(async ({ name, id }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction(['files', 'bodies', 'workspace']);
      const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const [metadata, body, workspace] = await Promise.all([
        read(tx.objectStore('files').get(id)), read(tx.objectStore('bodies').get(id)), read(tx.objectStore('workspace').get('current')),
      ]);
      return { inlineBytes: 'bytes' in metadata, bytes: [...new Uint8Array(body)], order: workspace.corpus.order };
    } finally { db.close(); }
  }, { name: LOCAL_LIBRARY_DB_NAME, id: saved.id });
  expect(result).toEqual({ inlineBytes: false, bytes: saved.bytes, order: ['saved-doc'] });
});
