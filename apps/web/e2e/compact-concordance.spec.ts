import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';

test('compact Concordance keeps only direct result and display controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'concordance');

  const controls = page.getByLabel('Concordance display');
  const port = page.getByRole('region', { name: 'Scrollable concordance table' });
  const table = page.getByRole('table', { name: 'Concordance' });
  await expect(table).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('complementary', { name: 'Terms' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Method', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Concordance order')).toHaveCount(0);
  await expect(page.getByLabel('Occurrence navigation')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'recenter node' })).toHaveCount(0);
  await expect(page.locator('.kwic-method')).toHaveCount(0);
  const dockGeometry = await page.locator('.app-shell').evaluate((shell) => {
    const dock = shell.querySelector<HTMLElement>('.workbench-dock');
    const footer = shell.querySelector<HTMLElement>('.workbench-footer');
    return {
      termsRail: getComputedStyle(shell).getPropertyValue('--terms-rail-block-size').trim(),
      dockHeight: dock?.getBoundingClientRect().height ?? -1,
      footerHeight: footer?.getBoundingClientRect().height ?? -2,
    };
  });
  expect(dockGeometry.termsRail).toBe('0px');
  expect(Math.abs(dockGeometry.dockHeight - dockGeometry.footerHeight)).toBeLessThanOrEqual(1);

  for (const control of await controls.locator('button, select').all()) {
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }

  await expect.poll(async () => {
    const portBox = await port.boundingBox();
    const nodeBox = await table.getByRole('columnheader', { name: 'node' }).boundingBox();
    if (!portBox || !nodeBox) return Number.POSITIVE_INFINITY;
    return Math.abs(
      (portBox.x + portBox.width / 2) - (nodeBox.x + nodeBox.width / 2),
    );
  }).toBeLessThanOrEqual(2);

  let mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await controls.getByLabel('Shown context characters').selectOption('12');
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);
  const firstLeft = table.locator('tbody tr').first().locator('.kwic-left-context');
  const shown = firstLeft.locator('[aria-hidden="true"]');
  const complete = firstLeft.locator('.visually-hidden');
  await expect(shown).not.toHaveText('');
  expect((await complete.textContent())!.length).toBeGreaterThan(
    (await shown.textContent())!.length,
  );

  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await controls.getByRole('button', { name: 'wrapped' }).click();
  await expect(page.getByRole('note')).toHaveText('Alignment is off in reading mode.');
  await expect(table).toHaveCount(0);
  await expect(page.getByLabel('Concordance reading view')).toBeVisible();
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);

  const readingRows = page.getByLabel('Concordance reading view').locator('.kwic-reading-row');
  await expect(readingRows.locator('[data-active]')).toHaveCount(0);
  const firstOccurrence = readingRows.first().getByRole('button');
  await firstOccurrence.click();
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: 'back' }).click();
  await expect(firstOccurrence).toBeFocused();

  await controls.getByRole('button', { name: 'aligned' }).click();
  await expect(table).toBeVisible();
  await expect.poll(async () => {
    const portBox = await port.boundingBox();
    const nodeBox = await table.getByRole('columnheader', { name: 'node' }).boundingBox();
    if (!portBox || !nodeBox) return Number.POSITIVE_INFINITY;
    return Math.abs(
      (portBox.x + portBox.width / 2) - (nodeBox.x + nodeBox.width / 2),
    );
  }).toBeLessThanOrEqual(2);

  const overflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.root).toBeLessThanOrEqual(overflow.client);
  expect(overflow.body).toBeLessThanOrEqual(overflow.client);
});
