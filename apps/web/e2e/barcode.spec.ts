/**
 * Slice-2 commit D acceptance: the dispersion barcode over a deterministic
 * imported corpus — the strip renders with an honest per-track summary, the
 * occurrence navigation centers the merged concordance at the EXACT
 * position (job-correlated fresh evidence), and a resize issues NO worker
 * query (resident-data redraw only, ruling §D).
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, clearDemoInputs, gotoPlace, submitAndAwaitFreshResults, trace } from './helpers.ts';

// wolf@1, wolf@7, fox@4 — exact ticks, deterministic.
const CORPUS = 'the wolf ran. a fox saw the wolf sleep.\n';

test('a live color-scheme change repaints canvas evidence without reloading', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'theme.txt', mimeType: 'text/plain', buffer: Buffer.from(CORPUS, 'utf-8'),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  const canvas = scrubber.locator('canvas[data-barcode-band="series"]');
  await expect(canvas).toBeVisible();
  const bootId = await page.evaluate(() => {
    const target = window as unknown as { __ttThemeBootId?: string };
    target.__ttThemeBootId ??= crypto.randomUUID();
    return target.__ttThemeBootId;
  });
  const paintedPixel = () => canvas.evaluate((node) => {
    const context = (node as HTMLCanvasElement).getContext('2d')!;
    const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data;
    for (let i = 0; i < pixels.length; i += 4) {
      if ((pixels[i + 3] ?? 0) > 250) return `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`;
    }
    return 'transparent';
  });
  const expectedSeriesColor = () => page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--series-1');
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color.match(/[\d.]+/g)?.slice(0, 3).map(Number).join(',') ?? color;
  });
  const darkPixel = await paintedPixel();
  expect(darkPixel).toBe(await expectedSeriesColor());

  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(expectedSeriesColor).not.toBe(darkPixel);
  await expect.poll(paintedPixel).toBe(await expectedSeriesColor());
  expect(await page.evaluate(() => (window as unknown as { __ttThemeBootId?: string }).__ttThemeBootId))
    .toBe(bootId);
});

test('the barcode summarizes exact occurrences, steps into the concordance, and never queries on resize', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'beasts.txt', mimeType: 'text/plain', buffer: Buffer.from(CORPUS, 'utf-8'),
  });
  await expect(page.getByRole('heading', { name: 'Input workspace', exact: true })).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  // Each term gets its own row, with the line sample preceding its exact total.
  const occurrenceRow = page.getByRole('list', { name: 'Term totals' })
    .getByRole('listitem').filter({ hasText: 'wolf' });
  await expect(occurrenceRow).toBeVisible();
  await expect(occurrenceRow.locator('[data-term-occurrence-count]')).toHaveText('2');
  const [sampleBox, labelBox] = await Promise.all([
    occurrenceRow.locator('svg').boundingBox(),
    occurrenceRow.locator('[data-term-occurrence-label]').boundingBox(),
  ]);
  expect(sampleBox && labelBox ? sampleBox.x : Number.POSITIVE_INFINITY)
    .toBeLessThan(labelBox?.x ?? Number.NEGATIVE_INFINITY);

  // Next-occurrence: a fresh bounded Concordance window centered at wolf@1.
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'Next wolf reference' }).click();
  await expect
    .poll(async () => {
      const t = await trace(page);
      const q = t.events.filter((e) => e.seq > mark && e.direction === 'to-worker' && e.t === 'query' && e.op === 'concordance-window');
      if (q.length === 0) return 'no fresh concordance';
      const res = t.events.filter((e) => e.seq > mark && e.direction === 'from-worker' && e.t === 'result' && q.some((p) => p.job === e.job));
      return res.length > 0 ? 'answered' : 'no result';
    }, { timeout: 30_000 })
    .toBe('answered');
  // The exact occurrence is the active virtual row (wolf@1 → 1-based token 2).
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('grid', { name: 'Concordance' })
    .locator('[role="row"][aria-selected="true"] .kwic-token-position')).toHaveText('2 / 9');

  // Stepping again advances to wolf@7 — relative to the current center.
  await gotoPlace(page, 'trends');
  const mark2 = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByRole('button', { name: 'Next wolf reference' }).click();
  await expect
    .poll(async () => {
      const t = await trace(page);
      const q = t.events.filter((e) => e.seq > mark2 && e.direction === 'to-worker' && e.t === 'query' && e.op === 'concordance-window');
      const res = t.events.filter((e) => e.seq > mark2 && e.direction === 'from-worker' && e.t === 'result' && q.some((p) => p.job === e.job));
      return res.length > 0 ? 'answered' : 'waiting';
    }, { timeout: 30_000 })
    .toBe('answered');
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('grid', { name: 'Concordance' })
    .locator('[role="row"][aria-selected="true"] .kwic-token-position')).toHaveText('8 / 9');

  // CANVAS CLICK: click the strip at wolf@7's x position — the inversion +
  // authoritative resolver center the concordance on that exact occurrence.
  // (First move the center elsewhere so the assertion cannot pass stale.)
  await gotoPlace(page, 'trends');
  await page.getByRole('button', { name: 'Previous wolf reference' }).click();
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('grid', { name: 'Concordance' })
    .locator('[role="row"][aria-selected="true"] .kwic-token-position')).toHaveText('2 / 9');
  await gotoPlace(page, 'trends');
  const canvas = page.getByRole('slider', { name: /reading position/i })
    .locator('canvas')
    .first();
  const box = (await canvas.boundingBox())!;
  const mark3 = (await trace(page)).events.at(-1)?.seq ?? -1;
  // NINE word tokens in the corpus doc; wolf@7 centers at x = (7.5/9)·width
  // — the click must land ON the painted tick, proving the covering path of
  // the pixel inversion, not the dead-space nearest fallback (review-D r2).
  await canvas.click({ position: { x: box.width * (7.5 / 9), y: 3 } });
  await expect
    .poll(async () => {
      const t = await trace(page);
      const q = t.events.filter((e) => e.seq > mark3 && e.direction === 'to-worker' && e.t === 'query' && e.op === 'concordance-window');
      const res = t.events.filter((e) => e.seq > mark3 && e.direction === 'from-worker' && e.t === 'result' && q.some((p) => p.job === e.job));
      return res.length > 0 ? 'answered' : 'waiting';
    }, { timeout: 30_000 })
    .toBe('answered');
  await page.getByRole('main', { name: /Reader: beasts/ })
    .getByRole('button', { name: 'back', exact: true })
    .click();
  await gotoPlace(page, 'concordance');
  await expect(page.getByRole('grid', { name: 'Concordance' })
    .locator('[role="row"][aria-selected="true"] .kwic-token-position')).toHaveText('8 / 9');

  // RESIZE: the strip redraws from the resident result — zero worker queries.
  await gotoPlace(page, 'trends');
  const before = ((await trace(page)).events.at(-1)?.seq ?? -1);
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(400); // let any (forbidden) reissue surface
  const after = (await trace(page)).events.filter((e) => e.seq > before && e.direction === 'to-worker' && e.t === 'query');
  expect(after).toHaveLength(0);
});

test('embedded barcode hover snaps exact evidence in series and by-book views without activating it', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles([
    { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('wolf alpha beta gamma delta', 'utf-8') },
    { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha beta gamma wolf delta', 'utf-8') },
  ]);
  await expect(page.getByRole('heading', { name: 'Input workspace', exact: true })).toBeVisible({ timeout: 30_000 });
  await awaitReadyCount(page, 2);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');

  const scrubber = page.getByRole('slider', { name: /reading position/i });
  const focused = page.getByRole('group', { name: 'Query terms' }).getByRole('button', { name: /^wolf \d+$/i });
  const focusedBefore = await focused.getAttribute('aria-pressed');
  const assertHoverOnly = async () => {
    await expect(focused).toHaveAttribute('aria-pressed', focusedBefore ?? 'false');
    await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'clear selection' })).toHaveCount(0);
  };
  const commits = (view: 'series' | 'by-book') => page.evaluate(
    (activeView) => (window as unknown as { __ttChartCommits?: Record<string, number> }).__ttChartCommits?.[activeView] ?? 0,
    view,
  );

  // Series uses one declared-sequence band. Six pixels before wolf@global8
  // inverts to raw global7, but is within the inclusive 8px painted interval
  // threshold and therefore snaps to the exact occurrence at global8.
  const seriesBand = scrubber.locator('canvas[data-barcode-band="series"]');
  await expect(seriesBand).toHaveCount(1);
  const seriesCommits = await commits('series');
  const seriesBox = (await seriesBand.boundingBox())!;
  await page.mouse.move(seriesBox.x + seriesBox.width * (8 / 10) - 6, seriesBox.y + 3);
  await expect(scrubber).toHaveAttribute('aria-valuenow', '8');
  await assertHoverOnly();

  // Far from either exact tick, hover remains the honest raw graph position.
  await page.mouse.move(seriesBox.x + seriesBox.width * 0.65, seriesBox.y + 3);
  await expect(scrubber).toHaveAttribute('aria-valuenow', '6');
  await assertHoverOnly();
  await seriesBand.click({ position: { x: seriesBox.width * 0.65, y: 3 } });
  await expect(scrubber).toHaveAttribute('aria-valuenow', '6');
  await assertHoverOnly();
  expect(await commits('series')).toBe(seriesCommits);

  await page.getByRole('button', { name: 'separate' }).click();
  const bookBands = scrubber.locator('canvas[data-barcode-band="by-book"]');
  await expect(bookBands).toHaveCount(2);
  const bookBandPixels = await bookBands.evaluateAll((nodes) => nodes.map((node) => {
    const canvas = node as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
    let painted = 0;
    let black = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if ((pixels[i + 3] ?? 0) === 0) continue;
      painted++;
      if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) black++;
    }
    return { painted, black };
  }));
  expect(bookBandPixels.every(({ painted, black }) => painted > 0 && black === 0)).toBe(true);
  const byBookCommits = await commits('by-book');
  const secondBook = bookBands.nth(1);
  const bookBox = (await secondBook.boundingBox())!;
  // Each book owns its normalized scale: wolf@3 in book b snaps locally,
  // while aria-valuenow remains its declared-sequence coordinate (5 + 3).
  await page.mouse.move(bookBox.x + bookBox.width * (3 / 5) - 6, bookBox.y + 3);
  await expect(scrubber).toHaveAttribute('aria-valuenow', '8');
  await assertHoverOnly();

  await page.mouse.move(bookBox.x + bookBox.width * 0.3, bookBox.y + 3);
  await expect(scrubber).toHaveAttribute('aria-valuenow', '6');
  await assertHoverOnly();
  expect(await commits('by-book')).toBe(byBookCommits);

  // The accessible steppers are siblings of the slider, never descendants.
  await expect(scrubber.getByRole('button')).toHaveCount(0);
});
