import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, trace, trackCorpusRequests } from './helpers.ts';
import { PLACE_HEADING, type Place } from '../src/lib/places.ts';
import { LOCAL_LIBRARY_DB_NAME } from '../src/lib/local-library.ts';

async function expectOnlyCanonicalPlace(page: Page, active: Place): Promise<void> {
  for (const [place, heading] of Object.entries(PLACE_HEADING) as [Place, string][]) {
    await expect(page.getByRole('region', { name: heading, exact: true }))
      .toHaveCount(place === active ? 1 : 0);
  }
}

test('workbench tabs round-trip canonical places without issuing analysis', async ({ page }) => {
  await page.goto('./?foreign=%2f&p=compare');
  await awaitAllReady(page, { loadDemo: true });

  const lens = page.getByRole('navigation', { name: 'Workbench sections' });
  await expect(lens.getByRole('link')).toHaveText([
    'Inputs',
    'Trends',
    'Concordance',
    'Vocabulary',
    'Compare',
  ]);
  await expect(lens.getByRole('link', { name: 'Compare', exact: true }))
    .toHaveAttribute('aria-current', 'page');

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await lens.getByRole('link', { name: 'Concordance', exact: true }).click();
  await expect(page).toHaveURL(/\?foreign=%2f&p=concordance$/);
  await expect(lens.getByRole('link', { name: 'Concordance', exact: true }))
    .toHaveAttribute('aria-current', 'page');
  const lensQueryOps = (await trace(page)).events.filter((event) =>
    event.seq > mark
    && event.direction === 'to-worker'
    && event.t === 'query');
  expect(lensQueryOps).toEqual([]);

  await page.reload();
  await awaitAllReady(page);
  await expect(page.getByRole('link', { name: 'Concordance', exact: true }))
    .toHaveAttribute('aria-current', 'page');
  // A direct Concordance reload may still be materializing its first bounded
  // row window after the general analysis barrier. Set the navigation mark
  // only once that governed surface is resident.
  await expect(page.getByRole('grid', { name: 'Concordance' }))
    .toBeVisible({ timeout: 30_000 });
  const reloadMark = (await trace(page)).events.at(-1)?.seq ?? -1;

  const status = page.getByRole('region', { name: 'Corpus status' });
  await status.getByRole('button', { name: 'Library corpus', exact: true }).click();
  await expect(page).toHaveURL(/\?foreign=%2f&p=inputs$/);
  await expectOnlyCanonicalPlace(page, 'inputs');
  await page.getByRole('navigation', { name: 'Workbench sections' })
    .getByRole('link', { name: 'Compare', exact: true }).click();
  await expect(page).toHaveURL(/\?foreign=%2f&p=compare$/);
  await page.goBack();
  await expect(page).toHaveURL(/\?foreign=%2f&p=inputs$/);
  await page.goForward();
  await expect(page).toHaveURL(/\?foreign=%2f&p=compare$/);

  const queryOps = (await trace(page)).events.filter((event) =>
    event.seq > reloadMark
    && event.direction === 'to-worker'
    && event.t === 'query');
  expect(queryOps).toEqual([]);
});

test('Vocabulary and Compare each mount as a closed canonical place', async ({ page }) => {
  await page.goto('./?p=vocabulary');
  await awaitAllReady(page, { loadDemo: true });
  await expectOnlyCanonicalPlace(page, 'vocabulary');
  await expect(page.getByRole('table', { name: 'Vocabulary frequency list' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Book analysis' })).toHaveCount(0);

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page
    .getByRole('navigation', { name: 'Workbench sections' })
    .getByRole('link', { name: 'Compare', exact: true })
    .click();
  await expectOnlyCanonicalPlace(page, 'compare');
  const signedAxis = page.getByRole('table', { name: 'Compare signed axis' });
  await expect(signedAxis).toBeVisible();
  await expect(signedAxis.getByRole('rowgroup', { name: /^Side A ·/ })).toBeVisible();
  await expect(signedAxis.getByRole('rowgroup', { name: /^Side B ·/ })).toBeVisible();

  const queryOps = (await trace(page)).events.filter((event) =>
    event.seq > mark
    && event.direction === 'to-worker'
    && event.t === 'query');
  expect(queryOps).toEqual([]);
});

test('unknown places use the empty-corpus Inputs default', async ({ page }) => {
  await page.goto('./?foreign=kept&p=obsolete');
  await expect(page).toHaveURL(/\?foreign=kept&p=inputs$/);
  await expect(page.getByRole('link', { name: 'Inputs', exact: true }))
    .toHaveAttribute('aria-current', 'page');
});

test('a fresh p-less workspace opens Inputs without loading a demo implicitly', async ({ page }) => {
  const requests = trackCorpusRequests(page);
  await page.goto('./?fresh=1');
  await expect(page).toHaveURL(/\?fresh=1&p=inputs$/);
  await expect(page.getByRole('link', { name: 'Inputs', exact: true }))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('No active inputs. Nothing is being analyzed.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load Sherlock Holmes demo' })).toBeVisible();
  expect(requests).toEqual([]);
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
      return (workspace as { corpus?: { kind?: string; order?: readonly string[] } } | undefined)?.corpus;
    } finally {
      database.close();
    }
  }, LOCAL_LIBRARY_DB_NAME)).toEqual({ kind: 'library', order: [], docs: [] });
});

test('compact tabs keep five complete destinations in portrait and landscape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  const lens = page.getByRole('navigation', { name: 'Workbench sections' });
  await expect(lens.getByRole('link')).toHaveCount(5);
  await expect(lens).toHaveCSS('position', 'fixed');
  const portrait = await lens.boundingBox();
  expect(portrait).not.toBeNull();
  expect(Math.abs((portrait!.y + portrait!.height) - 844)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 568, height: 320 });
  await expect(lens.getByRole('link')).toHaveText([
    'Inputs',
    'Trends',
    'Concordance',
    'Vocabulary',
    'Compare',
  ]);
  const landscape = await lens.boundingBox();
  expect(landscape).not.toBeNull();
  expect(landscape!.x).toBe(0);
  expect(landscape!.height).toBe(320);
  expect(landscape!.width).toBeLessThan(140);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(568);
});
