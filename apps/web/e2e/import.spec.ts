/** Real-browser proof of the single durable catalog/workspace path: an import
 * is saved to the local library, activated, restored after artifact eviction,
 * and cascaded out of the active corpus when its catalog file is deleted. */

import { expect, test } from '@playwright/test';
import { LOCAL_LIBRARY_DB_NAME } from '../src/lib/local-library.ts';
import { awaitAllReady, awaitReadyCount, clearArtifactStores, events, gotoPlace, trace } from './helpers.ts';

const DOC_NAME = 'smoke-doc.txt';
const DOC_TEXT = 'The quick brown fox jumps over the lazy dog. '.repeat(120);
const DOC_BYTES = Buffer.byteLength(DOC_TEXT, 'utf-8');

function fileInput() {
  return { name: DOC_NAME, mimeType: 'text/plain', buffer: Buffer.from(DOC_TEXT, 'utf-8') };
}

async function assertTransferred(page: import('@playwright/test').Page, sinceSeq: number): Promise<void> {
  await expect.poll(async () => {
    const ingests = events(await trace(page), { direction: 'to-worker', t: 'ingest' })
      .filter((event) => event.seq > sinceSeq && event.transferBytesBefore === DOC_BYTES);
    if (ingests.length === 0) return 'no ingest yet';
    return ingests.every((event) => event.transferBytesAfter === 0) ? 'transferred' : 'not detached';
  }, { timeout: 30_000 }).toBe('transferred');
}

async function savedWorkspaceOrder(page: import('@playwright/test').Page): Promise<readonly string[]> {
  return page.evaluate(async (databaseName) => {
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
      const corpus = (workspace as { corpus?: { kind?: string; order?: readonly string[] } } | undefined)?.corpus;
      return corpus?.kind === 'library' ? corpus.order ?? [] : [];
    } finally {
      database.close();
    }
  }, LOCAL_LIBRARY_DB_NAME);
}

test('catalog import restores from the library and active deletion cascades', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'inputs');

  const importMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByLabel('Create project from files').setInputFiles(fileInput());
  await assertTransferred(page, importMark);
  await awaitReadyCount(page, 1);
  await expect(page.getByRole('heading', { name: 'library corpus', exact: true })).toBeVisible();
  await expect(page.getByLabel('Documents').getByText('on this device', { exact: true })).toBeVisible();
  await expect.poll(() => savedWorkspaceOrder(page), { timeout: 10_000 }).toHaveLength(1);

  await clearArtifactStores(page);
  await page.reload();
  await awaitReadyCount(page, 1);
  await assertTransferred(page, -1);
  await gotoPlace(page, 'inputs');
  await expect(page.getByRole('heading', { name: 'library corpus', exact: true })).toBeVisible();

  await page.getByRole('button', { name: `Delete ${DOC_NAME} from this device` }).click();
  await expect(page.getByLabel('Files on this device').getByText(DOC_NAME)).toHaveCount(0);
  await expect(page.getByLabel('Documents').getByText('smoke-doc')).toHaveCount(0);
  await expect.poll(() => savedWorkspaceOrder(page), { timeout: 10_000 }).toEqual([]);
});
