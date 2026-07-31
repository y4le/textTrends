import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace } from './helpers.ts';
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
    await expect(quickAdd).toBeVisible();
    if (viewport.width < 600) {
      const size = await quickAdd.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
      expect(size).toBeGreaterThanOrEqual(16);
    }
  });
}

test('a compact exact-term editor stays inside the page', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('./');
  await awaitAllReady(page);
  await page.getByRole('button', { name: 'Edit members: Holmes' }).click();

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

test('scrollable analytical tables expose named regions', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('region', { name: 'Scrollable concordance table' })).toBeVisible();
  await gotoPlace(page, 'trends');
  await expect(page.getByRole('region', { name: 'Scrollable exact totals table' })).toBeVisible();
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

  const quickAdd = page.getByRole('textbox', { name: 'Add terms to the notebook, comma-separated' });
  const quickBox = await quickAdd.boundingBox();
  expect(quickBox?.height).toBeGreaterThanOrEqual(44);

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
