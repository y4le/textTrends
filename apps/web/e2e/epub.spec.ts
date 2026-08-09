/**
 * EPUB ingest (Phase 2) in the real browser: import a minimal, deterministic
 * EPUB, then prove the worker unzipped it, extracted body-matter text, and made
 * it analyzable — a term that appears ONLY in the epub body produces a trend +
 * concordance. Also proves a persisted epub warm-reopens after the disposable
 * artifact cache is cleared.
 */

import { expect, test } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { awaitAllReady, awaitReadyCount, clearArtifactStores, DB_NAME, clearNotebook, gotoPlace, openQuickAdd } from './helpers.ts';

/** A two-document EPUB 3: body matter carries the distinctive word "zephyrwood";
 *  the title page (front matter) is excluded from body-only extraction. */
function fixtureEpub(): Buffer {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">https://standardebooks.org/ebooks/test/book</dc:identifier>
    <dc:title>The Zephyrwood Chronicle</dc:title>
    <dc:creator>A. Tester</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item href="text/titlepage.xhtml" id="tp" media-type="application/xhtml+xml"/>
    <item href="text/ch1.xhtml" id="c1" media-type="application/xhtml+xml"/>
    <item href="text/ch2.xhtml" id="c2" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="tp"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;
  const page = (bodyType: string, h: string, p: string) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>${h}</title></head>
  <body epub:type="${bodyType}"><section><h2>${h}</h2><p>${p}</p></section></body>
</html>`;
  const container = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="epub/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const zipped = zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(container),
    'epub/content.opf': strToU8(opf),
    'epub/text/titlepage.xhtml': strToU8(page('frontmatter', 'Title', 'By A. Tester.')),
    'epub/text/ch1.xhtml': strToU8(page('bodymatter', 'Part One', 'The zephyrwood grew tall and green.')),
    'epub/text/ch2.xhtml': strToU8(page('bodymatter', 'Part Two', 'Beneath the zephyrwood they rested.')),
  });
  return Buffer.from(zipped);
}

test('an EPUB imports, extracts body text, and analyzes it', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'catalog');

  await page.getByLabel('Create project from files').setInputFiles({
    name: 'zephyrwood.epub',
    mimeType: 'application/epub+zip',
    buffer: fixtureEpub(),
  });
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);

  // A word that appears ONLY in the epub body matter yields a trend line — proof
  // the container was unzipped and its XHTML extracted to analyzable text.
  await gotoPlace(page, 'trends');
  await clearNotebook(page);
  const input = await openQuickAdd(page);
  await input.fill('zephyrwood');
  await input.press('Enter');
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('table', { name: 'Concordance' })).toBeVisible({ timeout: 30_000 });
  const rows = await page.getByRole('table', { name: 'Concordance' }).locator('tbody tr').count();
  expect(rows).toBeGreaterThanOrEqual(2); // both body documents mention it
});

test('a persisted EPUB warm-reopens after the artifact cache is cleared', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'catalog');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'zephyrwood.epub', mimeType: 'application/epub+zip', buffer: fixtureEpub(),
  });
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);

  // Persist the source + save the project, then evict the disposable artifact
  // cache and reload: the worker must re-extract the container from durable
  // source bytes because no derived text remains.
  await page.getByRole('button', { name: 'persist' }).click();
  await expect(page.getByLabel('Documents').getByText('persisted', { exact: true })).toBeVisible({ timeout: 30_000 });
  await gotoPlace(page, 'catalog');
  const save = page.getByRole('button', { name: 'Save project' });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect(page.getByText('Project revision 1 is saved.')).toBeVisible({ timeout: 30_000 });

  await clearArtifactStores(page);
  await page.reload();
  await awaitAllReady(page);
  await gotoPlace(page, 'catalog');
  await page.getByRole('button', { name: 'Load saved project' }).click();
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);

  // Re-extracted from persisted source: the body term still analyzes.
  await gotoPlace(page, 'trends');
  await clearNotebook(page);
  const input = await openQuickAdd(page);
  await input.fill('zephyrwood');
  await input.press('Enter');
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('table', { name: 'Concordance' })).toBeVisible({ timeout: 30_000 });
});

test('a persisted EPUB rebuilds its index when only extracted text survives', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'catalog');
  await page.getByLabel('Create project from files').setInputFiles({
    name: 'zephyrwood.epub', mimeType: 'application/epub+zip', buffer: fixtureEpub(),
  });
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);

  await page.getByRole('button', { name: 'persist' }).click();
  await expect(page.getByLabel('Documents').getByText('persisted', { exact: true })).toBeVisible({ timeout: 30_000 });
  await gotoPlace(page, 'catalog');
  const save = page.getByRole('button', { name: 'Save project' });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect(page.getByText('Project revision 1 is saved.')).toBeVisible({ timeout: 30_000 });

  // Clear the shard while keeping the stored text. The index can rebuild
  // directly from that format-neutral text.
  await page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(dbName); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    try {
      await new Promise<void>((res, rej) => {
        const tx = db.transaction('shards', 'readwrite');
        tx.objectStore('shards').clear();
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
    } finally { db.close(); }
  }, DB_NAME);

  await page.reload();
  await awaitAllReady(page);
  await gotoPlace(page, 'catalog');
  await page.getByRole('button', { name: 'Load saved project' }).click();
  await expect(page.getByText('your project')).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);

  await gotoPlace(page, 'trends');
  await clearNotebook(page);
  const input = await openQuickAdd(page);
  await input.fill('zephyrwood');
  await input.press('Enter');
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('table', { name: 'Concordance' })).toBeVisible({ timeout: 30_000 });
});
