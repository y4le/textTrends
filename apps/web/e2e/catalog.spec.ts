/**
 * The baked Standard Ebooks catalog in the real browser: browsing costs ZERO
 * network requests (no api.github.com, no standardebooks.org), a complete
 * series renders in position order from the checked-in snapshot, and adding a
 * book downloads its source ONLY from raw.githubusercontent.com — fulfilled
 * here from fixtures, so the whole proof runs offline — and ingests it
 * through the same import path as an uploaded file.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount } from './helpers.ts';

const BOOK = 'arthur-conan-doyle_a-study-in-scarlet';
const RAW_BASE = `https://raw.githubusercontent.com/standardebooks/${BOOK}/master/src/epub`;

/** SE-shaped source package: OPF at src/epub/content.opf, spine XHTML beside it. */
const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">https://standardebooks.org/ebooks/arthur-conan-doyle/a-study-in-scarlet</dc:identifier>
    <dc:title>A Study in Scarlet</dc:title>
    <dc:creator>Arthur Conan Doyle</dc:creator>
    <dc:language>en-GB</dc:language>
  </metadata>
  <manifest>
    <item href="text/chapter-1.xhtml" id="c1" media-type="application/xhtml+xml"/>
    <item href="text/chapter-2.xhtml" id="c2" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

const chapter = (title: string, text: string) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>${title}</title></head>
  <body epub:type="bodymatter"><section epub:type="chapter"><h2>${title}</h2><p>${text}</p></section></body>
</html>`;

test('the baked catalog browses offline, renders series in order, and adds from raw fixtures', async ({ page }) => {
  const apiRequests: string[] = [];
  const rawRequests: string[] = [];
  await page.route('https://api.github.com/**', (route) => {
    apiRequests.push(route.request().url());
    return route.abort();
  });
  await page.route('https://standardebooks.org/**', (route) => {
    apiRequests.push(route.request().url());
    return route.abort();
  });
  await page.route('https://raw.githubusercontent.com/**', (route) => {
    const url = route.request().url();
    rawRequests.push(url);
    if (url === `${RAW_BASE}/content.opf`) return route.fulfill({ contentType: 'text/plain', body: OPF });
    if (url === `${RAW_BASE}/text/chapter-1.xhtml`) {
      return route.fulfill({ contentType: 'text/plain', body: chapter('Chapter One', 'The lattimer word appears here.') });
    }
    if (url === `${RAW_BASE}/text/chapter-2.xhtml`) {
      return route.fulfill({ contentType: 'text/plain', body: chapter('Chapter Two', 'The lattimer word appears again.') });
    }
    return route.abort();
  });

  await page.goto('./');
  await awaitAllReady(page);

  // Browsing is purely the baked snapshot: open the catalog and see a series
  // render complete and position-ordered with NO catalog network traffic.
  await page.getByRole('button', { name: /Standard Ebooks catalog/ }).click();
  const series = page.getByRole('list', { name: 'Sherlock Holmes series' });
  await expect(series).toBeVisible();
  const rows = series.getByRole('listitem');
  await expect(rows).toHaveCount(9);
  await expect(rows.nth(0)).toContainText('1. A Study in Scarlet');
  await expect(rows.nth(1)).toContainText('2. The Sign of the Four');
  await expect(rows.nth(8)).toContainText('9. The Casebook of Sherlock Holmes');
  await expect(page.getByRole('list', { name: 'Popular Standard Ebooks' })).toBeVisible();
  expect(apiRequests).toEqual([]);
  expect(rawRequests).toEqual([]);

  // Adding downloads the source from raw.githubusercontent.com only (here:
  // fixtures), repackages it, and ingests it like an uploaded .epub.
  await rows.nth(0).getByRole('button', { name: 'add' }).click();
  await awaitReadyCount(page, 1);
  await expect(page.getByText('A Study in Scarlet')).toBeVisible();
  expect(apiRequests).toEqual([]);
  expect(rawRequests[0]).toBe(`${RAW_BASE}/content.opf`);
  expect(new Set(rawRequests.slice(1))).toEqual(
    new Set([`${RAW_BASE}/text/chapter-1.xhtml`, `${RAW_BASE}/text/chapter-2.xhtml`]),
  );
});
