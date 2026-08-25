import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, gotoPlace } from './helpers.ts';

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

test('density scales virtual data rows without moving their semantic anchors', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'matches');

  const matches = page.getByRole('grid', { name: 'Matches' });
  await expect(matches).toBeVisible();
  await matches.evaluate((port) => {
    port.scrollTop = port.scrollHeight * 0.55;
  });
  await expect.poll(() => matches.getAttribute('data-logical-position'))
    .not.toBe('0.000');
  const matchesAnchor = await matches.getAttribute('data-logical-position');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  let pane = page.getByRole('dialog', { name: 'Settings', exact: true });
  let slider = pane.getByRole('slider', { name: 'Size and spacing' });
  for (const stop of [
    { value: '0', rowHeight: 32 },
    { value: '1', rowHeight: 36 },
    { value: '2', rowHeight: 40 },
  ]) {
    await slider.fill(stop.value);
    await expect(matches).toHaveAttribute('data-logical-position', matchesAnchor!);
    await expect.poll(() => matches.evaluate((port) => {
      const rows = [...port.querySelectorAll<HTMLElement>('[data-matches-rank]')]
        .map((row) => ({
          rank: Number(row.dataset.matchesRank),
          top: row.getBoundingClientRect().top,
          height: row.getBoundingClientRect().height,
        }))
        .sort((left, right) => left.rank - right.rank);
      const pair = rows.find((row, index) => rows[index + 1]?.rank === row.rank + 1);
      const next = pair === undefined
        ? undefined
        : rows.find((row) => row.rank === pair.rank + 1);
      return pair && next
        ? { height: pair.height, pitch: next.top - pair.top }
        : null;
    })).toEqual({ height: stop.rowHeight, pitch: stop.rowHeight });
  }

  await pane.getByRole('button', { name: 'close', exact: true }).click();
  await gotoPlace(page, 'vocabulary');
  const vocabularyPort = page.getByRole('region', {
    name: 'Scrollable Vocabulary frequency list',
  });
  await vocabularyPort.evaluate((port) => { port.scrollTop = 251; });
  const firstFullyVisibleVocabularyRow = () => vocabularyPort.evaluate((port) => {
    const headerBottom = port.querySelector<HTMLElement>('.frequency-grid-header')!
      .getBoundingClientRect().bottom;
    const rows = [...port.querySelectorAll<HTMLElement>('[data-frequency-row]')]
      .map((row) => ({
        index: Number(row.getAttribute('aria-rowindex')),
        top: row.getBoundingClientRect().top,
        height: row.getBoundingClientRect().height,
      }))
      .sort((left, right) => left.index - right.index);
    const first = rows.find((row) => row.top >= headerBottom - 0.5);
    return first ?? null;
  });
  await expect.poll(firstFullyVisibleVocabularyRow).not.toBeNull();
  const vocabularyAnchor = (await firstFullyVisibleVocabularyRow())!.index;

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  pane = page.getByRole('dialog', { name: 'Settings', exact: true });
  slider = pane.getByRole('slider', { name: 'Size and spacing' });
  for (const stop of [
    { value: '0', rowHeight: 44 },
    { value: '1', rowHeight: 48 },
    { value: '2', rowHeight: 52 },
  ]) {
    await slider.fill(stop.value);
    await expect.poll(firstFullyVisibleVocabularyRow).toEqual({
      index: vocabularyAnchor,
      top: expect.any(Number),
      height: stop.rowHeight,
    });
  }

  await pane.getByRole('button', { name: 'close', exact: true }).click();
  await gotoPlace(page, 'compare');
  const comparePort = page.getByRole('region', { name: 'Compare population pyramid' });
  await expect(comparePort.locator('.compare-pyramid-row')).not.toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  pane = page.getByRole('dialog', { name: 'Settings', exact: true });
  slider = pane.getByRole('slider', { name: 'Size and spacing' });
  for (const stop of STOPS) {
    await slider.fill(stop.value);
    await expect.poll(() => comparePort.evaluate((port) => {
      const rows = [...port.querySelectorAll<HTMLElement>('.compare-pyramid-row')]
        .map((row) => row.getBoundingClientRect())
        .filter((box) => box.height > 0);
      return rows.slice(1).every((box, index) =>
        Math.abs(box.top - rows[index]!.bottom) <= 1);
    })).toBe(true);
  }
});
