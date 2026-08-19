import { expect, test, type Page } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  gotoPlace,
  submitAndAwaitFreshResults,
  trace,
  trackCorpusRequests,
} from './helpers.ts';
import { PLACE_HEADING, type Place } from '../src/lib/places.ts';
import { LOCAL_LIBRARY_DB_NAME } from '../src/lib/local-library.ts';

async function expectOnlyCanonicalPlace(page: Page, active: Place): Promise<void> {
  for (const [place, heading] of Object.entries(PLACE_HEADING) as [Place, string][]) {
    await expect(page.getByRole('region', { name: heading, exact: true }))
      .toHaveCount(place === active ? 1 : 0);
  }
}

test('workbench tabs round-trip canonical places without issuing analysis', async ({ page }) => {
  await page.goto('./?foreign=%2f&p=trends');
  await awaitAllReady(page, { loadDemo: true });

  const lens = page.getByRole('navigation', { name: 'Workbench sections' });
  await expect(lens.getByRole('link')).toHaveText([
    'Inputs',
    'Trends',
    'Matches',
    'Vocabulary',
    'Compare',
  ]);
  await expect(lens.getByRole('link', { name: 'Trends', exact: true }))
    .toHaveAttribute('aria-current', 'page');
  await lens.getByRole('link', { name: 'Compare', exact: true }).click();
  await expect(lens.getByRole('link', { name: 'Compare', exact: true }))
    .toHaveAttribute('aria-current', 'page');

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await lens.getByRole('link', { name: 'Matches', exact: true }).click();
  await expect(page).toHaveURL(/\?foreign=%2f&p=matches$/);
  await expect(lens.getByRole('link', { name: 'Matches', exact: true }))
    .toHaveAttribute('aria-current', 'page');
  const lensQueryOps = (await trace(page)).events.filter((event) =>
    event.seq > mark
    && event.direction === 'to-worker'
    && event.t === 'query');
  expect(lensQueryOps).toEqual([]);

  await page.reload();
  await awaitAllReady(page);
  await expect(page.getByRole('link', { name: 'Matches', exact: true }))
    .toHaveAttribute('aria-current', 'page');
  // A direct Matches reload may still be materializing its first bounded
  // row window after the general analysis barrier. Set the navigation mark
  // only once that governed surface is resident.
  await expect(page.getByRole('grid', { name: 'Matches' }))
    .toBeVisible({ timeout: 30_000 });
  const reloadMark = (await trace(page)).events.at(-1)?.seq ?? -1;

  const status = page.getByRole('region', { name: 'Corpus status' });
  await expect(status.getByRole('button', { name: 'Library corpus', exact: true })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Workbench sections' })
    .getByRole('link', { name: 'Inputs', exact: true }).click();
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
  await expect(page.getByRole('table', { name: 'Text details' })).toHaveCount(0);

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page
    .getByRole('navigation', { name: 'Workbench sections' })
    .getByRole('link', { name: 'Compare', exact: true })
    .click();
  await expectOnlyCanonicalPlace(page, 'compare');
  const pyramid = page.getByRole('table', { name: 'Compare population pyramid' });
  await expect(pyramid).toBeVisible();
  await expect(pyramid.getByRole('rowgroup', { name: 'Paired distinctive term ranks' }))
    .toBeVisible();

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
  const active = page.getByRole('region', { name: 'Active inputs' });
  await expect(active.getByText('Want to explore first?', { exact: true })).toBeVisible();
  await expect(active.getByRole('button', { name: 'Add your files' })).toBeVisible();
  await expect(active.getByRole('button', { name: 'Try the Sherlock Holmes sample' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Load demo' })).toHaveCount(0);
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

test('multi-text controls appear only when at least two inputs are active', async ({ page }) => {
  await page.goto('./?fresh=1&p=compare');
  await expect(page).toHaveURL(/\?fresh=1&p=inputs$/);
  await expect(page.getByRole('status', { name: 'Navigation status' }))
    .toHaveText('Compare requires at least two active texts. Opening Inputs.');
  const lens = page.getByRole('navigation', { name: 'Workbench sections' });
  const compare = lens.getByRole('link', { name: 'Compare', exact: true });
  await expect(compare).toHaveCount(0);

  await page.getByLabel('Add files').setInputFiles({
    name: 'one.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('one reference'),
  });
  await awaitReadyCount(page, 1);
  await expect(compare).toHaveCount(0);
  const oneTextInputsUrl = page.url();
  await page.evaluate(() => {
    const url = new URL(location.href);
    url.searchParams.set('p', 'compare');
    history.pushState(history.state, '', url);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  });
  await expect(page).toHaveURL(/\?fresh=1&p=trends$/);
  await page.goBack();
  await expect(page).toHaveURL(oneTextInputsUrl);
  await submitAndAwaitFreshResults(page, 'reference');
  await gotoPlace(page, 'trends');
  await expect(page.getByRole('group', { name: 'Trend view' })).toHaveCount(0);
  const scrubber = page.getByRole('slider', { name: 'Reading position scrubber' });
  await expect(scrubber).not.toHaveAttribute('aria-keyshortcuts', /(?:^| )v(?: |$)/);
  await scrubber.focus();
  await scrubber.press('v');
  await expect(page.locator('svg[data-trend-view="by-book"]')).toHaveCount(0);
  await page.locator('body').press('g');
  await page.locator('body').press('c');
  await expect(page).toHaveURL(/\?fresh=1&p=trends$/);
  await expect(page.getByRole('status', { name: 'Navigation status' }))
    .toHaveText('Compare requires at least two active texts');

  await page.getByRole('button', { name: 'shortcuts', exact: true }).click();
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(shortcuts.getByText('Go to Trends', { exact: true })).toHaveCount(0);
  await expect(shortcuts.getByText('Go to Inputs', { exact: true })).toBeVisible();
  await expect(shortcuts.getByText('Go to Compare', { exact: true })).toHaveCount(0);
  await expect(shortcuts.getByText('Toggle combined / separate view', { exact: true }))
    .toHaveCount(0);
  await shortcuts.getByRole('button', { name: 'close', exact: true }).click();

  await gotoPlace(page, 'inputs');
  await page.getByLabel('Add files').setInputFiles({
    name: 'two.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('two references'),
  });
  await awaitReadyCount(page, 2);
  await expect(compare).toBeVisible();
  await gotoPlace(page, 'trends');
  const view = page.getByRole('group', { name: 'Trend view' });
  await expect(view.getByRole('button')).toHaveText(['combined', 'separate']);
  await expect(view.getByRole('button', { name: 'separate' }))
    .toHaveAttribute('aria-pressed', 'true');
});

test('compact tabs keep every available destination complete in portrait and landscape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  const lens = page.getByRole('navigation', { name: 'Workbench sections' });
  await expect(lens.getByRole('link')).toHaveCount(4);
  await expect(lens).toHaveCSS('position', 'fixed');
  const portrait = await lens.boundingBox();
  expect(portrait).not.toBeNull();
  expect(Math.abs((portrait!.y + portrait!.height) - 844)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 568, height: 320 });
  await expect(lens.getByRole('link')).toHaveText([
    'Inputs',
    'Trends',
    'Matches',
    'Vocabulary',
  ]);
  const landscape = await lens.boundingBox();
  expect(landscape).not.toBeNull();
  expect(landscape!.x).toBe(0);
  expect(landscape!.height).toBe(320);
  expect(landscape!.width).toBeLessThan(140);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(568);
});
