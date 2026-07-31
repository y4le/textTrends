import { expect, test } from '@playwright/test';
import { awaitAllReady, trace } from './helpers.ts';

test('Scope and Lens round-trip canonical places without issuing analysis', async ({ page }) => {
  await page.goto('./?foreign=%2f&p=compare');
  await awaitAllReady(page);

  const lens = page.getByRole('navigation', { name: 'Analysis lenses' });
  await expect(lens.getByRole('link')).toHaveText([
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
  const reloadMark = (await trace(page)).events.at(-1)?.seq ?? -1;

  const scope = page.getByRole('region', { name: 'Scope' });
  await scope.getByRole('button', { name: 'Sherlock Holmes', exact: true }).click();
  await expect(page).toHaveURL(/\?foreign=%2f&p=corpus$/);
  await scope.getByRole('button', { name: '0 of 8 pinned', exact: true }).click();
  await expect(page).toHaveURL(/\?foreign=%2f&p=findings$/);
  await page.goBack();
  await expect(page).toHaveURL(/\?foreign=%2f&p=corpus$/);
  await page.goForward();
  await expect(page).toHaveURL(/\?foreign=%2f&p=findings$/);

  const queryOps = (await trace(page)).events.filter((event) =>
    event.seq > reloadMark
    && event.direction === 'to-worker'
    && event.t === 'query');
  expect(queryOps).toEqual([]);
});

test('unknown places normalize quietly to Trends', async ({ page }) => {
  await page.goto('./?foreign=kept&p=obsolete&e=modal');
  await expect(page).toHaveURL(/\?foreign=kept&p=trends$/);
  await expect(page.getByRole('link', { name: 'Trends', exact: true }))
    .toHaveAttribute('aria-current', 'page');
});

test('compact Lens keeps four complete destinations in portrait and landscape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  const lens = page.getByRole('navigation', { name: 'Analysis lenses' });
  await expect(lens.getByRole('link')).toHaveCount(4);
  await expect(lens).toHaveCSS('position', 'fixed');
  const portrait = await lens.boundingBox();
  expect(portrait).not.toBeNull();
  expect(Math.abs((portrait!.y + portrait!.height) - 844)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 568, height: 320 });
  await expect(lens.getByRole('link')).toHaveText([
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
