import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady } from './helpers.ts';

const STOPS = [
  { value: '0', density: 'compact', textXs: '0.6875rem', rail: 50, target: 36 },
  { value: '1', density: 'standard', textXs: '0.75rem', rail: 54, target: 40 },
  { value: '2', density: 'comfortable', textXs: '0.8125rem', rail: 58, target: 44 },
] as const;

async function expectNoPageOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    root: document.documentElement.scrollWidth
      <= document.documentElement.clientWidth,
    body: document.body.scrollWidth <= document.documentElement.clientWidth,
  }))).toMatchObject({
    root: true,
    body: true,
  });
}

test('density uses three live persisted stops without changing analytical marks', async ({ page }) => {
  await page.addInitScript(() => {
    const scope = window as unknown as { __firstAppliedDensity?: string };
    const observer = new MutationObserver(() => {
      const density = document.documentElement.dataset.density;
      if (scope.__firstAppliedDensity !== undefined || density === undefined) return;
      scope.__firstAppliedDensity = density;
      observer.disconnect();
    });
    observer.observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-density'],
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  await expect(page.locator('html')).toHaveAttribute('data-density', 'standard');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const pane = page.getByRole('dialog', { name: 'Settings', exact: true });
  const slider = pane.getByRole('slider', { name: 'Size and spacing' });
  await expect(slider).toHaveValue('1');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Standard');
  expect((await slider.boundingBox())?.height).toBeGreaterThanOrEqual(44);

  let analyticalGeometry: { graph: number; barcode: number } | null = null;
  for (const stop of STOPS) {
    await page.setViewportSize({ width: 390, height: 844 });
    await slider.fill(stop.value);
    await expect(page.locator('html')).toHaveAttribute('data-density', stop.density);
    await expect(slider).toHaveAttribute(
      'aria-valuetext',
      stop.density[0]!.toUpperCase() + stop.density.slice(1),
    );
    await expect.poll(() => page.evaluate(() => ({
      textXs: document.documentElement.style.getPropertyValue('--text-xs'),
      rail: Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--terms-rail-block-size')),
      target: Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--term-target-block-size')),
      dock: Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--dock-block-size')),
      dockBox: document.querySelector<HTMLElement>('.workbench-dock')
        ?.getBoundingClientRect().height ?? -1,
    }))).toEqual({
      textXs: stop.textXs,
      rail: stop.rail,
      target: stop.target,
      dock: expect.any(Number),
      dockBox: expect.any(Number),
    });
    const reservation = await page.evaluate(() => ({
      dock: Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--dock-block-size')),
      dockBox: document.querySelector<HTMLElement>('.workbench-dock')!
        .getBoundingClientRect().height,
      graph: document.querySelector<HTMLElement>('.footer-sparkline')!
        .getBoundingClientRect().height,
      barcode: document.querySelector<HTMLElement>('canvas[data-barcode-band="series"]')!
        .getBoundingClientRect().height,
    }));
    expect(reservation.dockBox).toBe(reservation.dock);
    const currentGeometry = { graph: reservation.graph, barcode: reservation.barcode };
    analyticalGeometry ??= currentGeometry;
    expect(currentGeometry).toEqual(analyticalGeometry);

    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
      await expectNoPageOverflow(page);
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __firstAppliedDensity?: string }).__firstAppliedDensity))
    .toBe('comfortable');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: 'Reset display' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'standard');
});
