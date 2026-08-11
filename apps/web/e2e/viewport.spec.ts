/**
 * Dynamic-viewport contract. Playwright cannot raise an OS keyboard, so the
 * resizes-visual case shadows the VisualViewport geometry consumed by the app.
 * The WebKit project proves that contract in a real WebKit engine; it is not a
 * claim about iOS Safari's platform keyboard or fixed-position quirks.
 */

import { expect, test } from '@playwright/test';
import {
  awaitAllReady,
  simulateKeyboard,
  simulatePinchZoom,
  trace,
} from './helpers.ts';

function queriesAfter(
  events: Awaited<ReturnType<typeof trace>>['events'],
  mark: number,
) {
  return events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  );
}

async function keyboardInset(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset').trim());
}

async function expectAboveOccludedBand(
  page: import('@playwright/test').Page,
  locator: import('@playwright/test').Locator,
  occlusion: number,
) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const innerHeight = await page.evaluate(() => window.innerHeight);
  expect(box!.y + box!.height).toBeLessThanOrEqual(innerHeight - occlusion + 1);
}

test('compact header reflows the publisher mark without starving single-line Scope', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('./');
  await awaitAllReady(page);

  const header = page.locator('.app-header');
  await expect(header.locator('h1')).toHaveText('yalethom.as/textTrends');
  const publisher = header.getByRole('link', {
    name: 'yalethom.as/textTrends, publisher home',
  });
  await expect(publisher).toHaveAttribute('href', 'https://yalethom.as/');
  await expect(publisher).toHaveText('yalethom.as/textTrends');
  await expect(publisher.locator('.app-brand-dot')).toHaveCSS('color', 'rgb(193, 67, 46)');
  const publisherBox = await publisher.boundingBox();
  if (!publisherBox) throw new Error('publisher signature has no layout box');
  expect(publisherBox.height).toBeGreaterThanOrEqual(24);
  const publisherType = await publisher.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      family: style.fontFamily,
      size: Number.parseFloat(style.fontSize),
      weight: style.fontWeight,
      lineHeight: Number.parseFloat(style.lineHeight),
    };
  });
  expect(publisherType.family.replaceAll(/["']/g, '')).toBe(
    'Geist Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace',
  );
  expect(publisherType.size).toBeGreaterThanOrEqual(12);
  expect(publisherType.weight).toBe('500');
  expect(publisherType.lineHeight).toBeGreaterThanOrEqual(publisherType.size * 1.25 - 0.1);
  expect(publisherBox.height).toBeLessThanOrEqual(publisherType.lineHeight * 2 + 1);
  await page.keyboard.press('Tab');
  await expect(publisher).toBeFocused();
  await expect(publisher).not.toHaveCSS('outline-style', 'none');
  await expect(header.getByRole('region', { name: 'Scope' })).toHaveCount(1);
  await expect(header.getByRole('navigation', { name: 'Analysis lenses' })).toHaveCount(1);

  const geometry = await header.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const brand = node.querySelector<HTMLElement>('h1')!.getBoundingClientRect();
    const scope = node.querySelector<HTMLElement>('.scope-organ')!.getBoundingClientRect();
    const content = node.querySelector<HTMLElement>('.scope-organ-content')!;
    return {
      height: box.height,
      top: box.top,
      bottom: box.bottom,
      brand: { top: brand.top, bottom: brand.bottom },
      scope: { top: scope.top, bottom: scope.bottom },
      scopeWidth: scope.width,
      scopeClientHeight: content.clientHeight,
      scopeScrollHeight: content.scrollHeight,
    };
  });
  expect(geometry.height).toBeLessThanOrEqual(60);
  expect(geometry.scopeWidth).toBeGreaterThanOrEqual(72);
  for (const child of [geometry.brand, geometry.scope]) {
    expect(child.top).toBeGreaterThanOrEqual(geometry.top);
    expect(child.bottom).toBeLessThanOrEqual(geometry.bottom);
  }
  expect(geometry.scopeScrollHeight).toBeLessThanOrEqual(geometry.scopeClientHeight);
});

test('compact landscape keeps the one-row dock clear of the Lens rail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await page.setViewportSize({ width: 568, height: 320 });

  const dock = page.locator('.workbench-dock');
  const terms = page.getByRole('complementary', { name: 'Terms' });
  const lens = page.getByRole('navigation', { name: 'Analysis lenses' });
  const [dockBox, termsBox, lensBox] = await Promise.all([
    dock.boundingBox(),
    terms.boundingBox(),
    lens.boundingBox(),
  ]);
  if (!dockBox || !termsBox || !lensBox) throw new Error('landscape dock geometry is unavailable');
  expect(dockBox.x).toBeGreaterThanOrEqual(lensBox.x + lensBox.width);
  expect(termsBox.height).toBe(await page.evaluate(() => Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--terms-rail-block-size'),
  )));

  for (const control of [
    terms.locator('.term-bucket-focus').first(),
    terms.locator('.term-bucket-toggle').first(),
    terms.locator('.term-bar-actions button').first(),
  ]) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  const overflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.root).toBeLessThanOrEqual(overflow.client);
  expect(overflow.body).toBeLessThanOrEqual(overflow.client);
});

test('an attached mouse reorders terms with insertion feedback in a touch-capable iPad layout', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 768, height: 1024 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await page.goto('./');
    await awaitAllReady(page);
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);

    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    const manager = page.getByRole('dialog', { name: 'Manage terms' });
    const list = manager.getByRole('list', { name: 'Terms' });
    const source = manager.getByRole('button', { name: 'Reorder Moriarty' });
    const target = manager.getByRole('button', { name: 'Edit term: Holmes' });
    await expect(source).not.toHaveAttribute('draggable', 'true');
    const [sourceBox, targetBox] = await Promise.all([source.boundingBox(), target.boundingBox()]);
    if (!sourceBox || !targetBox) throw new Error('hybrid reorder geometry is unavailable');

    await page.mouse.move(
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(targetBox.x + 8, targetBox.y + 4, { steps: 4 });
    await expect(source.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-dragging', 'true');
    await expect(target.locator('xpath=ancestor::li[1]'))
      .toHaveAttribute('data-drop-position', 'before');
    await page.mouse.up();

    await expect(list.locator('.term-manager-title'))
      .toHaveText(['Moriarty', 'Holmes', 'Watson']);
    await expect(list.locator('[data-drop-position]')).toHaveCount(0);
    for (const control of await manager.locator('.term-manager-visible').all()) {
      const box = await control.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  } finally {
    await context.close();
  }
});

test('touch term reordering cancels extra contacts and autoscrolls at modal edges', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 260 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await page.goto('./');
    await awaitAllReady(page);
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    const manager = page.getByRole('dialog', { name: 'Manage terms' });
    const source = manager.getByRole('button', { name: 'Reorder Holmes' });
    const other = manager.getByRole('button', { name: 'Edit term: Moriarty' });
    const sourceBox = await source.boundingBox();
    const otherBox = await other.boundingBox();
    if (!sourceBox || !otherBox) throw new Error('term touch geometry is unavailable');
    const touch = (
      pointerId: number,
      x: number,
      y: number,
      isPrimary: boolean,
    ) => ({
      pointerId,
      pointerType: 'touch',
      isPrimary,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
    });

    await source.dispatchEvent('pointerdown', touch(
      31,
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2,
      true,
    ));
    await expect(source.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-dragging', 'true');
    await other.dispatchEvent('pointerdown', touch(
      32,
      otherBox.x + otherBox.width / 2,
      otherBox.y + otherBox.height / 2,
      false,
    ));
    await expect(manager.locator('[data-dragging]')).toHaveCount(0);
    await expect(manager.getByRole('status'))
      .toContainText('cancelled because another touch was detected');
    await source.dispatchEvent('pointercancel', touch(
      31,
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2,
      true,
    ));
    await other.dispatchEvent('pointerup', {
      ...touch(
        32,
        otherBox.x + otherBox.width / 2,
        otherBox.y + otherBox.height / 2,
        false,
      ),
      buttons: 0,
    });
    await expect(manager.getByRole('status'))
      .toContainText('cancelled because another touch was detected');

    const managerBox = await manager.boundingBox();
    if (!managerBox) throw new Error('term manager has no layout box');
    await source.dispatchEvent('pointerdown', touch(
      33,
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2,
      true,
    ));
    await source.dispatchEvent('pointermove', touch(
      33,
      managerBox.x + managerBox.width / 2,
      managerBox.y + managerBox.height - 3,
      true,
    ));
    await expect.poll(() => manager.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(source.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-dragging', 'true');
    await expect.poll(() => manager.evaluate((element) => (
      element.scrollHeight - element.clientHeight - element.scrollTop
    ))).toBeLessThanOrEqual(1);
    await expect(manager.getByRole('button', { name: 'Edit term: Moriarty' })
      .locator('xpath=ancestor::li[1]')).toHaveAttribute('data-drop-position', 'after');
    await source.dispatchEvent('pointerup', {
      ...touch(
        33,
        managerBox.x + managerBox.width / 2,
        managerBox.y + managerBox.height - 3,
        true,
      ),
      buttons: 0,
    });
    await expect(manager.getByRole('list', { name: 'Terms' }).locator('.term-manager-title'))
      .toHaveText(['Watson', 'Moriarty', 'Holmes']);
    await expect(manager.locator('[data-dragging], [data-drop-position]')).toHaveCount(0);

    const movedSource = manager.getByRole('button', { name: 'Reorder Holmes' });
    const movedSourceBox = await movedSource.boundingBox();
    if (!movedSourceBox) throw new Error('moved term touch geometry is unavailable');
    await movedSource.dispatchEvent('pointerdown', touch(
      34,
      movedSourceBox.x + movedSourceBox.width / 2,
      movedSourceBox.y + movedSourceBox.height / 2,
      true,
    ));
    await movedSource.dispatchEvent('pointercancel', touch(
      34,
      movedSourceBox.x + movedSourceBox.width / 2,
      movedSourceBox.y + movedSourceBox.height / 2,
      true,
    ));
    await expect(manager.locator('[data-dragging], [data-drop-position]')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('full-height editors honor resizes-visual geometry without losing draft or issuing work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);

  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('viewport-fit=cover');
  expect(viewport).toContain('interactive-widget=resizes-content');
  expect(viewport).not.toContain('user-scalable=no');
  expect(viewport).not.toContain('maximum-scale');

  const css = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')?.href;
    if (!href) throw new Error('production stylesheet link is missing');
    return (await fetch(href)).text();
  });
  for (const rule of [
    /\.workbench-sheet\{[^}]*block-size:28vh;block-size:28dvh/,
    /\.workbench-sheet\[data-detent=half\]\{[^}]*block-size:58vh;block-size:58dvh/,
    /\.workbench-sheet\[data-detent=tall\]\{[^}]*block-size:88vh;block-size:88dvh/,
    /\.reader-region\{[^}]*block-size:100vh;[^}]*block-size:100dvh/,
    /\.form-layer\{[^}]*min-block-size:100vh;min-block-size:100dvh/,
    /\.term-manager\{[^}]*min-block-size:calc\(100vh[^;]+;min-block-size:calc\(100dvh/,
  ]) {
    expect(css).toMatch(rule);
  }

  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.getByRole('dialog', { name: 'Manage terms' })
    .getByRole('button', { name: 'Edit term: Holmes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage terms' });
  const draft = dialog.getByRole('textbox', { name: 'Term and aliases for Holmes' });
  await draft.fill('watson');
  await draft.focus();
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await simulateKeyboard(page, 284);
  await expect.poll(() => keyboardInset(page)).toBe('284px');
  await expect(draft).toHaveValue('watson');
  await expect(draft).toBeFocused();
  await expectAboveOccludedBand(page, draft, 284);
  await expectAboveOccludedBand(
    page,
    dialog.getByRole('button', { name: 'Save term' }),
    284,
  );
  await expectAboveOccludedBand(
    page,
    dialog.getByRole('button', { name: 'Cancel', exact: true }),
    284,
  );
  const compactOverflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(compactOverflow.document).toBeLessThanOrEqual(compactOverflow.client);
  expect(compactOverflow.body).toBeLessThanOrEqual(compactOverflow.client);
  expect(queriesAfter((await trace(page)).events, mark)).toEqual([]);

  await simulatePinchZoom(page, 2);
  await expect.poll(() => keyboardInset(page)).toBe('0px');
  await simulatePinchZoom(page, 1);
  await expect.poll(() => keyboardInset(page)).toBe('284px');
  await simulateKeyboard(page, 0);
  await expect.poll(() => keyboardInset(page)).toBe('0px');
  await expect(draft).toHaveValue('watson');

  await page.setViewportSize({ width: 568, height: 320 });
  await simulateKeyboard(page, 180);
  const overflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.client);
  expect(overflow.body).toBeLessThanOrEqual(overflow.client);
  expect(queriesAfter((await trace(page)).events, mark)).toEqual([]);
});

test('Chromium resizes-content uses dvh once and preserves the open draft', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'interactive-widget resizes-content is the Chromium model');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.getByRole('dialog', { name: 'Manage terms' })
    .getByRole('button', { name: 'Edit term: Holmes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage terms' });
  const draft = dialog.getByRole('textbox', { name: 'Term and aliases for Holmes' });
  await draft.fill('watson');
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await page.setViewportSize({ width: 390, height: 400 });
  await expect.poll(() => keyboardInset(page)).toBe('0px');
  await expect(draft).toHaveValue('watson');
  await expectAboveOccludedBand(
    page,
    dialog.getByRole('button', { name: 'Save term' }),
    0,
  );
  await expectAboveOccludedBand(
    page,
    dialog.getByRole('button', { name: 'Cancel', exact: true }),
    0,
  );
  expect(queriesAfter((await trace(page)).events, mark)).toEqual([]);
});
