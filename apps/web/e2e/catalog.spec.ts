/**
 * The baked Standard Ebooks catalog in the real browser: browsing makes NO
 * external network requests (no api.github.com, no standardebooks.org — the
 * snapshot is fetched as a hashed same-origin JSON asset on first open), a
 * complete series renders in position order from the checked-in snapshot,
 * and adding a book downloads its source ONLY from raw.githubusercontent.com
 * — fulfilled here from fixtures, so the whole proof runs offline — and
 * ingests it through the same import path as an uploaded file. A build-shape
 * test proves payload separation (the snapshot bytes live outside every
 * script); the retry test proves on-demand timing (zero asset requests
 * before the panel opens, exactly one after).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  // render complete and position-ordered with NO external catalog traffic
  // (the snapshot itself is a same-origin JSON asset, invisible to these
  // external-route interceptors; its on-demand timing is asserted in the
  // retry test and its payload separation in the build-shape test).
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

test('build shape: the catalog snapshot bytes live outside every script', () => {
  // PAYLOAD SEPARATION half of the lazy-load guard (Phase A ruling): the
  // webServer command builds dist/ before any spec runs, so the emitted
  // output is on disk. The marker is a catalog-only string: a series
  // sourceUrl prefix that appears nowhere in application code. This proves
  // the ~20 kB snapshot is not embedded in any script or the HTML — the
  // ON-DEMAND TIMING half (nothing fetches the asset until the panel opens)
  // is a runtime property, asserted in the retry test below.
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const marker = 'standardebooks.org/collections/';
  expect(readFileSync(`${dist}index.html`, 'utf8').includes(marker)).toBe(false);
  const assets = readdirSync(`${dist}assets/`);
  for (const script of assets.filter((f) => f.endsWith('.js') || f.endsWith('.css'))) {
    expect(
      readFileSync(`${dist}assets/${script}`, 'utf8').includes(marker),
      `${script} must not embed the catalog`,
    ).toBe(false);
  }
  const carriers = assets.filter(
    (f) => !f.endsWith('.js') && !f.endsWith('.css') && readFileSync(`${dist}assets/${f}`, 'utf8').includes(marker),
  );
  expect(carriers, 'exactly one hashed JSON asset carries the catalog').toHaveLength(1);
  expect(carriers[0]).toMatch(/^standard-ebooks-catalog-.+\.json$/);
});

test('the catalog asset loads on demand, and a failed fetch shows a genuinely retryable error', async ({ page }) => {
  // The review-a3-catalog finding: a dynamic import() cannot retry (the
  // module map memoizes the failure), which is why the snapshot is a plain
  // fetch. This proves BOTH halves of the on-demand contract and the
  // recovery path: zero catalog asset requests after boot, exactly one on
  // first open (here: failed), the error UI offers retry, and retry issues
  // a REAL second request that succeeds.
  const catalogAsset = '**/assets/standard-ebooks-catalog-*.json';
  let aborted = 0;
  await page.route(catalogAsset, (route) => {
    aborted += 1;
    return route.abort();
  });
  await page.goto('./');
  await awaitAllReady(page);
  expect(aborted, 'no catalog asset request before the panel opens').toBe(0);
  await page.getByRole('button', { name: /Standard Ebooks catalog/ }).click();
  await expect(page.getByText(/Could not load the catalog/)).toBeVisible();
  expect(aborted).toBe(1);

  await page.unroute(catalogAsset);
  await page.getByRole('button', { name: 'retry' }).click();
  await expect(page.getByRole('list', { name: 'Popular Standard Ebooks' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Sherlock Holmes series' })).toBeVisible();
});
