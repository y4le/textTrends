import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';
import {
  COMPACT_QUERY,
  WIDE_QUERY,
  widthClassFor,
} from '../src/lib/presentation.ts';

const viewports = [
  { name: 'small phone', width: 320, height: 568 },
  { name: 'current phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'wide desktop', width: 1440, height: 900 },
] as const;

for (const viewport of viewports) {
  test(`${viewport.name} keeps the page inside its visual viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await awaitAllReady(page);

    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.clientWidth);

    const mediaWidth = await page.evaluate(
      ({ compact, wide }) => ({
        compact: matchMedia(compact).matches,
        wide: matchMedia(wide).matches,
      }),
      { compact: COMPACT_QUERY, wide: WIDE_QUERY },
    );
    const expectedWidth = widthClassFor(viewport.width);
    expect(mediaWidth.compact).toBe(expectedWidth === 'compact');
    expect(mediaWidth.wide).toBe(expectedWidth === 'wide');

    const quickAdd = page.getByRole('textbox', { name: 'Add terms to the notebook, comma-separated' });
    const openQuickAdd = page.getByRole('button', { name: 'Add terms to the notebook, comma-separated' });
    await expect(openQuickAdd).toBeVisible();
    await openQuickAdd.click();
    await expect(quickAdd).toBeVisible();
    const size = await quickAdd.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    expect(size).toBeGreaterThanOrEqual(16);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('complementary', { name: 'Terms' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Method & settings', exact: true })).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Method', exact: true })).toHaveCount(0);
  });
}

test('brand, Scope, and Lens share one header row where Lens is not docked', async ({ page }) => {
  for (const viewport of [
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await awaitAllReady(page);

    const geometry = await page.locator('.app-header').evaluate((header) => {
      const box = header.getBoundingClientRect();
      const childBox = (selector: string) => {
        const child = header.querySelector<HTMLElement>(selector);
        if (!child) throw new Error(`missing ${selector} from the page header`);
        const childRect = child.getBoundingClientRect();
        return { top: childRect.top, bottom: childRect.bottom };
      };
      const scope = header.querySelector<HTMLElement>('.scope-organ-content');
      if (!scope) throw new Error('missing Scope content from the page header');
      return {
        height: box.height,
        top: box.top,
        bottom: box.bottom,
        brand: childBox('h1'),
        scope: childBox('.scope-organ'),
        lens: childBox('.lens-organ'),
        scopeClientHeight: scope.clientHeight,
        scopeScrollHeight: scope.scrollHeight,
      };
    });

    expect(geometry.height).toBeLessThanOrEqual(56);
    for (const child of [geometry.brand, geometry.scope, geometry.lens]) {
      expect(child.top).toBeGreaterThanOrEqual(geometry.top);
      expect(child.bottom).toBeLessThanOrEqual(geometry.bottom);
    }
    expect(geometry.scopeScrollHeight).toBeLessThanOrEqual(geometry.scopeClientHeight);
  }
});

test('workbench regions use the governed layout at regular and wide widths', async ({ page }) => {
  for (const viewport of [
    { width: 768, height: 1024, areas: '"place"' },
    { width: 1440, height: 900, areas: '"place"' },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await awaitAllReady(page);
    const layout = await page.locator('.workbench').evaluate((node) => {
      const grid = getComputedStyle(node);
      const place = getComputedStyle(
        node.querySelector<HTMLElement>('.place-region')!,
      );
      return {
        areas: grid.gridTemplateAreas,
        place: place.gridArea,
      };
    });
    expect(layout).toEqual({
      areas: viewport.areas,
      place: 'place',
    });
  }
});

test('a compact exact-term editor stays inside the page', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('./');
  await awaitAllReady(page);
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Manage terms' })
    .getByRole('button', { name: 'Edit members: Holmes' })
    .click();

  const member = page.getByRole('textbox', { name: /Add member to Holmes/ });
  await expect(member).toBeVisible();
  expect(await member.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)))
    .toBeGreaterThanOrEqual(16);
  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
});

test('compact query editing returns through its Back-governed manager', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);

  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  const edit = page
    .getByRole('dialog', { name: 'Manage terms' })
    .getByRole('button', { name: 'Edit members: Holmes' });
  await edit.click();
  const dialog = page.getByRole('dialog', { name: 'Query editor: Holmes' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Manage terms' })).toBeVisible();
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  await expect(edit).toBeFocused();
  await page.goBack();
  await expect(page.getByRole('dialog', { name: 'Manage terms' })).toHaveCount(0);
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
});

test('the Terms bar remains a first-class editor across places', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await expect(page.getByRole('group', { name: 'Query terms' })).toBeVisible();

  await gotoPlace(page, 'vocabulary');
  await expect(page.getByRole('group', { name: 'Query terms' })).toBeVisible();
  const queries = page.getByRole('complementary', { name: 'Terms' });
  await expect(page.locator('.workbench-dock')).toHaveCSS('position', 'fixed');
  await queries.getByRole('button', { name: 'Add terms to the notebook, comma-separated' }).click();
  await expect(page.getByRole('dialog', { name: 'Quick add query terms' })).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Add terms to the notebook, comma-separated' }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('group', { name: 'Query terms' })).toBeVisible();
});

test('compact query controls meet the 44px touch-target floor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);

  for (const control of [
    page.locator('.term-bucket-focus').first(),
    page.locator('.term-bucket-toggle').first(),
    page.locator('.term-bar-actions button').first(),
  ]) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

test('responsive query composition never reissues analysis', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await awaitAllReady(page);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('group', { name: 'Query terms' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('group', { name: 'Query terms' })).toBeVisible();

  const freshQueries = (await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  );
  expect(freshQueries).toEqual([]);
});

test('an open quick-add editor keeps one modal draft across width classes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await page.getByRole('button', { name: 'Add terms to the notebook, comma-separated' }).click();
  const compactDialog = page.getByRole('dialog', { name: 'Quick add query terms' });
  const compactInput = page.getByRole('textbox', {
    name: 'Add terms to the notebook, comma-separated',
  });
  await compactInput.fill('watson');
  await page.setViewportSize({ width: 844, height: 390 });

  await expect(compactDialog).toBeVisible();
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  const wideInput = page.getByRole('textbox', {
    name: 'Add terms to the notebook, comma-separated',
  });
  await expect(wideInput).toHaveCount(1);
  await expect(wideInput).toHaveValue('watson');
  await expect(wideInput).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(wideInput).not.toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(compactDialog).toBeVisible();
  await expect(compactInput).toHaveValue('watson');
  expect(await compactDialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);
  await page.goBack();
});

test('an open group editor keeps its modal draft and focus across width classes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Manage terms' })
    .getByRole('button', { name: 'Edit members: Holmes' })
    .click();
  const compactDialog = page.getByRole('dialog', { name: 'Query editor: Holmes' });
  const addMember = page.getByRole('textbox', { name: /Add member to Holmes/ });
  await addMember.fill('watson');
  await page.setViewportSize({ width: 844, height: 390 });

  await expect(compactDialog).toBeVisible();
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  const inlineEditor = page.getByRole('group', { name: 'Edit members: Holmes' });
  await expect(addMember).toHaveValue('watson');
  expect(await inlineEditor.evaluate((node) => node.contains(document.activeElement))).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(compactDialog).toBeVisible();
  await expect(addMember).toHaveValue('watson');
  expect(await compactDialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);
  await page.goBack();
});

test('scrollable analytical tables expose named regions', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('region', { name: 'Scrollable concordance table' })).toBeVisible();
  await gotoPlace(page, 'catalog');
  await expect(page.getByRole('region', { name: 'Scrollable book analysis table' })).toBeVisible();
});

test('coarse input sizing does not inflate dense concordance rows', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto('./');
  await awaitAllReady(page);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  await page.getByRole('button', { name: 'Add terms to the notebook, comma-separated' }).click();
  const quickAdd = page.getByRole('textbox', { name: 'Add terms to the notebook, comma-separated' });
  const quickBox = await quickAdd.boundingBox();
  expect(quickBox?.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await gotoPlace(page, 'concordance');
  const node = page.getByRole('table', { name: 'Concordance' }).getByRole('button').first();
  const nodeBox = await node.boundingBox();
  expect(nodeBox?.height).toBeLessThan(44);
  await context.close();
});

test('structural rules and safe viewport contract are active', async ({ page }) => {
  const contrastRatio = (foreground: string, background: string): number => {
    const channel = (hex: string, offset: number) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string) =>
      0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto('./');
    const contract = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return {
        background: styles.getPropertyValue('--bg').trim(),
        rule: styles.getPropertyValue('--rule').trim(),
        ruleStrong: styles.getPropertyValue('--rule-strong').trim(),
        viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content'),
      };
    });
    // Strong grouping rules meet the 3:1 non-text floor. Hairlines are
    // intentionally quieter but retain a documented minimum in both schemes.
    expect(contrastRatio(contract.ruleStrong, contract.background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(contract.rule, contract.background)).toBeGreaterThanOrEqual(1.6);
    expect(contract.viewport).toContain('viewport-fit=cover');
  }
});

test('the horizontally overflowing Scope details are keyboard-scrollable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('./');
  await awaitAllReady(page);
  const details = page.getByRole('group', { name: 'Scope details' });
  await expect(details).toHaveAttribute('tabindex', '0');
  expect(await details.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await details.focus();
  await page.keyboard.press('End');
  await expect.poll(() => details.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await page.keyboard.press('Home');
  await expect.poll(() => details.evaluate((node) => node.scrollLeft)).toBe(0);
});
