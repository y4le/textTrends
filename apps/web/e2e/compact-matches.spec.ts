import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, simulateKeyboard, trace } from './helpers.ts';

test('compact Matches keeps the shared terms rail and direct result controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'matches');

  const toolbar = page.getByRole('toolbar', { name: 'Match columns' });
  const grid = page.getByRole('grid', { name: 'Matches' });
  await expect(grid).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('complementary', { name: 'Terms' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Match terms' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Match order')).toHaveCount(0);
  await expect(page.getByLabel('Occurrence navigation')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'recenter node' })).toHaveCount(0);
  await expect(page.getByLabel('Shown context characters')).toHaveCount(0);
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

  for (const control of await toolbar.getByRole('button').all()) {
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }

  const leftWidth = grid.getByRole('separator', { name: 'Left context width' });
  const matchWidth = grid.getByRole('separator', { name: 'Match width' });
  const rightWidth = grid.getByRole('separator', { name: 'Right context width' });
  await expect(leftWidth).toHaveAttribute('tabindex', '-1');
  await expect(matchWidth).toHaveAttribute('tabindex', '-1');
  await expect(rightWidth).toHaveAttribute('tabindex', '-1');
  await expect(leftWidth).toHaveAttribute('aria-valuenow', '50');
  await expect(rightWidth).toHaveAttribute('aria-valuenow', '50');
  const lockedDivider = await leftWidth.evaluate((handle) => ({
    color: getComputedStyle(handle, '::after').borderInlineStartColor,
    opacity: Number.parseFloat(getComputedStyle(handle).opacity),
    pointerEvents: getComputedStyle(handle).pointerEvents,
  }));
  expect(lockedDivider.opacity).toBeGreaterThan(0);
  expect(lockedDivider.pointerEvents).toBe('none');
  const compactToken = grid.locator('[role="row"][aria-rowindex] .kwic-token').first();
  await expect(compactToken.locator('.kwic-token-position')).toHaveText(/^[\d,]+$/);
  await expect(compactToken).toHaveAttribute('title', /^[\d,]+ \/ [\d,]+$/);

  await grid.evaluate((element) => element.focus({ preventScroll: true }));
  await expect(grid).toBeFocused();
  expect(await grid.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none');

  await expect.poll(async () => {
    const portBox = await grid.boundingBox();
    const nodeBox = await grid.getByRole('columnheader', { name: /^match/ }).boundingBox();
    if (!portBox || !nodeBox) return false;
    return nodeBox.x >= portBox.x - 1
      && nodeBox.x + nodeBox.width <= portBox.x + portBox.width + 1;
  }).toBe(true);

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
  const adjust = toolbar.getByRole('button', { name: 'Adjust column widths' });
  await adjust.click();
  await expect(toolbar.getByRole('button', { name: 'Lock column widths' }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(leftWidth).toHaveAttribute('tabindex', '0');
  await expect.poll(() => leftWidth.evaluate((handle, lockedColor) => (
    getComputedStyle(handle, '::after').borderInlineStartColor !== lockedColor
    && getComputedStyle(handle).pointerEvents === 'auto'
  ), lockedDivider.color)).toBe(true);
  expect((await leftWidth.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const firstOccurrence = grid.locator('[role="row"][aria-rowindex]').first().getByRole('button');
  await expect.poll(() => firstOccurrence.evaluate((button) => getComputedStyle(button).cursor))
    .toBe('pointer');
  const defaultCenterError = await firstOccurrence.evaluate((button) => {
    const cell = button.parentElement!.getBoundingClientRect();
    const node = button.getBoundingClientRect();
    return Math.abs((cell.left + cell.width / 2) - (node.left + node.width / 2));
  });
  expect(defaultCenterError).toBeLessThanOrEqual(1);

  await rightWidth.evaluate((handle) => {
    const x = handle.getBoundingClientRect().left + handle.getBoundingClientRect().width / 2;
    const init = {
      bubbles: true,
      cancelable: true,
      pointerId: 41,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: handle.getBoundingClientRect().top + 10,
    };
    handle.dispatchEvent(new PointerEvent('pointerdown', init));
    handle.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: x + 48 }));
    handle.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: x + 48 }));
  });
  expect(Number(await rightWidth.getAttribute('aria-valuenow'))).toBeGreaterThan(50);

  await leftWidth.focus();
  await leftWidth.press('Home');
  await expect(leftWidth).toHaveAttribute('aria-valuenow', '1');
  await matchWidth.focus();
  await matchWidth.press('Home');
  await expect(matchWidth).toHaveAttribute('aria-valuenow', '1');

  const firstLeft = grid.locator('[role="row"][aria-rowindex]').first().locator('.kwic-left-context');
  await expect(firstLeft.locator(':scope > span')).toHaveCount(1);
  await expect(firstLeft.locator(':scope > span')).not.toHaveText('');
  const contextGeometry = await firstLeft.evaluate((cell) => {
    const bounds = cell.getBoundingClientRect();
    const text = cell.querySelector('span')!.getBoundingClientRect();
    return {
      clipped: text.width > bounds.width,
      tailVisible: text.right <= bounds.right + 1 && text.right > bounds.left,
    };
  });
  expect(contextGeometry).toEqual({ clipped: true, tailVisible: true });

  const nodeGeometry = await firstOccurrence.evaluate((button) => {
    const cell = button.parentElement!;
    const text = button.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const first = range.getBoundingClientRect();
    const bounds = cell.getBoundingClientRect();
    return {
      overflow: button.scrollWidth > button.clientWidth,
      firstCharacterVisible: first.left >= bounds.left - 1 && first.left < bounds.right,
      textOverflow: getComputedStyle(button).textOverflow,
    };
  });
  expect(nodeGeometry).toEqual({
    overflow: true,
    firstCharacterVisible: true,
    textOverflow: 'clip',
  });

  await toolbar.getByRole('button', { name: 'Reset column widths' }).click();
  await expect(matchWidth).toHaveAttribute('aria-valuenow', '6');
  await toolbar.getByRole('button', { name: 'Lock column widths' }).click();
  await expect(matchWidth).toHaveAttribute('tabindex', '-1');
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);

  await expect(page.getByRole('button', { name: 'wrapped' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'aligned' })).toHaveCount(0);
  await firstOccurrence.click();
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: 'back' }).click();
  await expect(grid).toBeFocused();

  await expect.poll(async () => {
    const portBox = await grid.boundingBox();
    const nodeBox = await grid.getByRole('columnheader', { name: /^match/ }).boundingBox();
    if (!portBox || !nodeBox) return false;
    return nodeBox.x >= portBox.x - 1
      && nodeBox.x + nodeBox.width <= portBox.x + portBox.width + 1;
  }).toBe(true);

  const overflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.root).toBeLessThanOrEqual(overflow.client);
  expect(overflow.body).toBeLessThanOrEqual(overflow.client);

  // Column preferences are tab-local but survive a browser refresh.
  await toolbar.getByRole('button', { name: 'Adjust column widths' }).click();
  await leftWidth.focus();
  await leftWidth.press('ArrowRight');
  await expect(leftWidth).toHaveAttribute('aria-valuenow', '51');
  await page.reload();
  await awaitAllReady(page);
  await gotoPlace(page, 'matches');
  await expect(page.getByRole('grid', { name: 'Matches' })
    .getByRole('separator', { name: 'Left context width' }))
    .toHaveAttribute('aria-valuenow', '51');

  for (const width of [320, 600, 1_024, 1_440]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.getByRole('grid', { name: 'Matches' })
      .evaluate((port) => ({
        noOverflow: port.scrollWidth <= port.clientWidth + 1,
        partitioned: Math.abs(
          [...port.querySelectorAll<HTMLElement>(
            '.kwic-grid-header > [role="columnheader"]',
          )].reduce((sum, cell) => sum + cell.getBoundingClientRect().width, 0)
          - port.clientWidth,
        ) <= 1,
      }))).toEqual({ noOverflow: true, partitioned: true });
  }
  await expect(grid.locator('[role="row"][aria-rowindex] .kwic-token-position').first())
    .toHaveText(/^[\d,]+ \/ [\d,]+$/);
});

test('short landscape Matches leaves a usable centered results viewport', async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'matches');

  const geometry = await page.locator('.kwic-grid-shell').evaluate((shell) => {
    const line = shell.querySelector<HTMLElement>('.kwic-now-line')!.getBoundingClientRect();
    const port = shell.querySelector<HTMLElement>('.kwic-virtual-grid')!.getBoundingClientRect();
    const dock = document.querySelector<HTMLElement>('.workbench-dock')!.getBoundingClientRect();
    const footer = document.querySelector<HTMLElement>('.workbench-footer')!.getBoundingClientRect();
    const appHeader = document.querySelector<HTMLElement>('.app-header')!.getBoundingClientRect();
    const gridHeader = shell.querySelector<HTMLElement>('.kwic-grid-header')!.getBoundingClientRect();
    return {
      portHeight: port.height,
      midpointError: Math.abs(line.top - (port.top + port.height / 2)),
      portBottom: port.bottom,
      dockTop: dock.top,
      footerHeight: footer.height,
      appHeaderHeight: appHeader.height,
      gridHeaderHeight: gridHeader.height,
      termsRailHeight: Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--terms-rail-block-size')),
      termTargetBlockSize: Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--term-target-block-size')),
    };
  });
  expect(geometry.portHeight).toBeGreaterThan(0);
  expect(geometry.midpointError).toBeLessThanOrEqual(1);
  expect(geometry.portBottom).toBeLessThanOrEqual(geometry.dockTop + 1);
  expect(geometry.footerHeight).toBeGreaterThanOrEqual(52);
  expect(geometry.footerHeight).toBeLessThanOrEqual(Math.floor(320 / 3) + 1);
  expect(geometry.appHeaderHeight).toBeGreaterThanOrEqual(32);
  expect(geometry.appHeaderHeight).toBeLessThanOrEqual(33);
  expect(geometry.gridHeaderHeight).toBeGreaterThanOrEqual(32);
  expect(geometry.gridHeaderHeight).toBeLessThanOrEqual(33);
  expect(geometry.termsRailHeight).toBe(54);
  expect(geometry.termTargetBlockSize).toBe(40);
});
