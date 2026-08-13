import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, simulateKeyboard, trace } from './helpers.ts';

test('compact Concordance keeps the shared terms rail and direct result controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'concordance');

  const controls = page.getByLabel('Concordance display');
  const grid = page.getByRole('grid', { name: 'Concordance' });
  await expect(grid).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('complementary', { name: 'Terms' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Concordance terms' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Method', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Concordance order')).toHaveCount(0);
  await expect(page.getByLabel('Occurrence navigation')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'recenter node' })).toHaveCount(0);
  await expect(page.locator('.kwic-method')).toHaveCount(0);
  const dockGeometry = await page.locator('.app-shell').evaluate((shell) => {
    const dock = shell.querySelector<HTMLElement>('.workbench-dock');
    const footer = shell.querySelector<HTMLElement>('.workbench-footer');
    return {
      termsRail: Number.parseFloat(
        getComputedStyle(shell).getPropertyValue('--terms-rail-block-size'),
      ),
      dockHeight: dock?.getBoundingClientRect().height ?? -1,
      footerHeight: footer?.getBoundingClientRect().height ?? -2,
    };
  });
  expect(dockGeometry.termsRail).toBeGreaterThan(0);
  expect(Math.abs(
    dockGeometry.dockHeight - dockGeometry.footerHeight - dockGeometry.termsRail,
  )).toBeLessThanOrEqual(1);

  for (const control of await controls.locator('button, select').all()) {
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }

  await expect.poll(async () => {
    const portBox = await grid.boundingBox();
    const nodeBox = await grid.getByRole('columnheader', { name: 'node' }).boundingBox();
    if (!portBox || !nodeBox) return Number.POSITIVE_INFINITY;
    return Math.abs(
      (portBox.x + portBox.width / 2) - (nodeBox.x + nodeBox.width / 2),
    );
  }).toBeLessThanOrEqual(2);

  const assertNowLineCentered = async () => page.locator('.kwic-grid-shell').evaluate((shell) => {
    const line = shell.querySelector<HTMLElement>('.kwic-now-line')!.getBoundingClientRect();
    const port = shell.querySelector<HTMLElement>('.kwic-virtual-grid')!.getBoundingClientRect();
    return {
      midpointError: Math.abs(line.top - (port.top + port.height / 2)),
      portBottom: port.bottom,
      dockTop: document.querySelector<HTMLElement>('.workbench-dock')!.getBoundingClientRect().top,
    };
  });
  expect((await assertNowLineCentered()).midpointError).toBeLessThanOrEqual(1);

  await simulateKeyboard(page, 280);
  await expect.poll(async () => (await assertNowLineCentered()).midpointError).toBeLessThanOrEqual(1);
  const insetGeometry = await assertNowLineCentered();
  expect(insetGeometry.portBottom).toBeLessThanOrEqual(insetGeometry.dockTop + 1);

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await controls.getByLabel('Shown context characters').selectOption('12');
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);
  const firstLeft = grid.locator('[role="row"][aria-rowindex]').first().locator('.kwic-left-context');
  const shown = firstLeft.locator('[aria-hidden="true"]');
  const complete = firstLeft.locator('.visually-hidden');
  await expect(shown).not.toHaveText('');
  expect((await complete.textContent())!.length).toBeGreaterThan(
    (await shown.textContent())!.length,
  );

  await expect(controls.getByRole('button', { name: 'wrapped' })).toHaveCount(0);
  await expect(controls.getByRole('button', { name: 'aligned' })).toHaveCount(0);
  const firstOccurrence = grid.locator('[role="row"][aria-rowindex]').first().getByRole('button');
  await firstOccurrence.click();
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: 'back' }).click();
  await expect(grid).toBeFocused();

  await expect.poll(async () => {
    const portBox = await grid.boundingBox();
    const nodeBox = await grid.getByRole('columnheader', { name: 'node' }).boundingBox();
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

test('short landscape Concordance leaves a usable centered results viewport', async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'concordance');

  const geometry = await page.locator('.kwic-grid-shell').evaluate((shell) => {
    const line = shell.querySelector<HTMLElement>('.kwic-now-line')!.getBoundingClientRect();
    const port = shell.querySelector<HTMLElement>('.kwic-virtual-grid')!.getBoundingClientRect();
    const dock = document.querySelector<HTMLElement>('.workbench-dock')!.getBoundingClientRect();
    return {
      portHeight: port.height,
      midpointError: Math.abs(line.top - (port.top + port.height / 2)),
      portBottom: port.bottom,
      dockTop: dock.top,
    };
  });
  expect(geometry.portHeight).toBeGreaterThan(0);
  expect(geometry.midpointError).toBeLessThanOrEqual(1);
  expect(geometry.portBottom).toBeLessThanOrEqual(geometry.dockTop + 1);
});
